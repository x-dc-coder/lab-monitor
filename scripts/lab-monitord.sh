#!/usr/bin/env bash
# lab-monitord.sh — daemon 启动/停止/状态/前台运行（含 --supervise 保活循环）
# 用法：lab-monitord.sh {start|stop|status|run} [--supervise]
# 单实例：run 外层用 flock -n 独占 daemon.lock；持锁失败 → 提示后 exit 0（不拉第二个采样器）。
# stop 先写 daemon.stopping，再向监督进程与 node 子进程发信号；循环在子进程前后看到哨兵则退出，不再重启。
# 不用 pkill -f 匹配脚本名：那会命中正在执行的 `lab-monitord.sh stop` 自身。
set -u

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENTRY="${LAB_MONITORD_ENTRY:-$REPO_DIR/lib/types/daemon/main.js}"
STATE_DIR="${LAB_MONITOR_STATE_HOME:-$HOME/.local/state/lab-monitor}"
LOCK_FILE="$STATE_DIR/daemon.lock"
PID_FILE="$STATE_DIR/daemon.pid"
STOP_FILE="$STATE_DIR/daemon.stopping"
LOG_FILE="$STATE_DIR/lab-monitord.out.log"
# pgrep -f 正则：字符类避免命令行里的字面模式命中 pgrep/本脚本（stop 命令行不含 --supervise）
SUPERVISE_PAT='[l]ab-monitord\.sh.*--supervise'
NODE_PAT='[l]ib/types/daemon/main\.js'

mkdir -p "$STATE_DIR"

ACTION='run'
SUPERVISE=0
# 参数解析（动词与 flag 任意顺序）
while [ $# -gt 0 ]; do
  case "$1" in
    start|stop|status|run) ACTION="$1" ;;
    --supervise) SUPERVISE=1 ;;
    --lock-file) LOCK_FILE="$2"; shift ;;
    --entry) ENTRY="$2"; shift ;;
  esac
  shift
done

# 日志轮转：>10MB → .1
if [ -f "$LOG_FILE" ] && [ "$(stat -c%s "$LOG_FILE" 2>/dev/null || echo 0)" -gt $((10*1024*1024)) ]; then
  mv -f "$LOG_FILE" "$LOG_FILE.1"
fi

do_run() {
  if [ ! -f "$ENTRY" ]; then
    echo "[lab-monitord] entry not found: $ENTRY (先 pnpm build)" >&2
    exit 1
  fi
  # flock 持锁期间运行 supervise/直接运行；-n 非阻塞，被占即 exit 0
  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    echo "[lab-monitord] lock held ($LOCK_FILE) — already running, exit 0"
    exit 0
  fi
  if [ "$SUPERVISE" = "1" ]; then
    while true; do
      if [ -e "$STOP_FILE" ]; then
        exit 0
      fi
      node "$ENTRY" >>"$LOG_FILE" 2>&1
      code=$?
      if [ -e "$STOP_FILE" ]; then
        exit 0
      fi
      echo "[lab-monitord] child exited code=$code, restart in 3s" >>"$LOG_FILE"
      sleep 3
    done
  else
    exec node "$ENTRY" >>"$LOG_FILE" 2>&1
  fi
}

pid_alive() {
  [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null
}

list_pids() {
  pgrep -f "$1" 2>/dev/null || true
}

any_pid() {
  [ -n "$(list_pids "$1" | head -1)" ]
}

# 向匹配进程发信号。优先杀其进程组（setsid 的会话 leader 一组带走 node 与 sleep），
# 但绝不向 stop 自己的进程组发信号。
signal_matched() {
  local sig="$1" pat="$2" pid mypgid pgid
  mypgid="$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ' || true)"
  while read -r pid; do
    [ -n "$pid" ] || continue
    [ "$pid" = "$$" ] && continue
    pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ' || true)"
    if [ -n "${pgid:-}" ] && [ "$pgid" != "$mypgid" ]; then
      kill "-$sig" -- "-$pgid" 2>/dev/null || kill "-$sig" "$pid" 2>/dev/null || true
    else
      kill "-$sig" "$pid" 2>/dev/null || true
    fi
  done < <(list_pids "$pat")
}

signal_one() {
  local sig="$1" pid="$2" mypgid pgid
  [ -n "$pid" ] || return 0
  [ "$pid" = "$$" ] && return 0
  pid_alive "$pid" || return 0
  mypgid="$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ' || true)"
  pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ' || true)"
  if [ -n "${pgid:-}" ] && [ "$pgid" != "$mypgid" ]; then
    kill "-$sig" -- "-$pgid" 2>/dev/null || kill "-$sig" "$pid" 2>/dev/null || true
  else
    kill "-$sig" "$pid" 2>/dev/null || true
  fi
}

daemon_alive() {
  any_pid "$SUPERVISE_PAT" || any_pid "$NODE_PAT"
}

case "$ACTION" in
  run)
    do_run
    ;;
  start)
    # status 语义先探活（不信任 pidfile；监督循环在 sleep 间隙也算在跑）
    if bash "$0" status >/dev/null 2>&1; then
      echo "[lab-monitord] already running"
      exit 0
    fi
    # 上一轮 stop 留下的哨兵必须在拉起前清掉，否则 supervise 循环会立刻退出
    rm -f "$STOP_FILE"
    nohup setsid bash "$0" run --supervise >/dev/null 2>&1 &
    spid=$!
    sleep 1
    if ! pid_alive "$spid"; then
      spid="$(list_pids "$SUPERVISE_PAT" | head -1)"
    fi
    if pid_alive "$spid"; then
      echo "$spid" >"$PID_FILE"
      echo "[lab-monitord] started (supervisor pid $spid, log $LOG_FILE)"
    else
      echo "[lab-monitord] failed to start (see $LOG_FILE)" >&2
      exit 1
    fi
    ;;
  stop)
    # 哨兵必须先于信号存在：监督进程若正在 sleep 3，被杀前不得再拉起子进程
    : >"$STOP_FILE"
    if [ -f "$PID_FILE" ]; then
      pid="$(cat "$PID_FILE" 2>/dev/null || true)"
      signal_one TERM "$pid"
    fi
    # 无 pidfile 的 `run --supervise`（登录任务 / 手工 setsid）同样要停
    signal_matched TERM "$SUPERVISE_PAT"
    signal_matched TERM "$NODE_PAT"
    for _ in $(seq 1 20); do
      daemon_alive || break
      sleep 0.5
    done
    if daemon_alive; then
      if [ -f "$PID_FILE" ]; then
        pid="$(cat "$PID_FILE" 2>/dev/null || true)"
        signal_one KILL "$pid"
      fi
      signal_matched KILL "$SUPERVISE_PAT"
      signal_matched KILL "$NODE_PAT"
      sleep 0.5
    fi
    if daemon_alive; then
      echo "[lab-monitord] stop failed: process still alive" >&2
      exit 1
    fi
    # 两边都没了才撤哨兵与 pidfile（start 也会再清一次哨兵）
    rm -f "$PID_FILE" "$STOP_FILE"
    echo "[lab-monitord] stopped"
    ;;
  status)
    ok=0
    if [ -f "$PID_FILE" ]; then
      pid="$(cat "$PID_FILE" 2>/dev/null || true)"
      # 不信任陈旧 pidfile：pid 存活且进程级确认是监督循环或 daemon entry
      if pid_alive "$pid" && { any_pid "$NODE_PAT" || any_pid "$SUPERVISE_PAT"; }; then
        echo "[lab-monitord] running (pid $pid)"
        ok=1
      fi
    fi
    if [ "$ok" -eq 0 ]; then
      if any_pid "$NODE_PAT"; then
        echo "[lab-monitord] running (pid $(list_pids "$NODE_PAT" | head -1))"
        ok=1
      elif any_pid "$SUPERVISE_PAT"; then
        echo "[lab-monitord] running (pid $(list_pids "$SUPERVISE_PAT" | head -1))"
        ok=1
      else
        echo "[lab-monitord] not running"
        exit 1
      fi
    fi
    ;;
  *)
    echo "usage: $0 {start|stop|status|run [--supervise]}" >&2
    exit 2
    ;;
esac
