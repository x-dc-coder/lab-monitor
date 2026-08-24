#!/usr/bin/env bash
# forward-monitor.sh — lab-monitor → monitor.dc-sy.cn 转发器生命周期管理（WSL 无 systemd）
# 用法: scripts/forward-monitor.sh {start|stop|status}
set -u

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$DIR/scripts/forward-monitor.mjs"
LOG="$DIR/forward-monitor.log"
PIDFILE="$DIR/forward-monitor.pid"

cmd="${1:-status}"

case "$cmd" in
  start)
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "转发器已在运行 (pid $(cat "$PIDFILE"))"; exit 0
    fi
    nohup node "$SCRIPT" >> "$LOG" 2>&1 &
    echo $! > "$PIDFILE"
    sleep 1
    if kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "✓ 转发器已启动 (pid $(cat "$PIDFILE"))"
    else
      echo "✗ 启动失败，查看 $LOG"; rm -f "$PIDFILE"; exit 1
    fi
    ;;
  stop)
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      kill "$(cat "$PIDFILE")"
      rm -f "$PIDFILE"
      echo "✓ 转发器已停止"
    else
      echo "转发器未在运行"; rm -f "$PIDFILE"
    fi
    ;;
  status)
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "运行中 (pid $(cat "$PIDFILE"))，最后日志:"
      tail -3 "$LOG" 2>/dev/null
    else
      echo "未运行"
    fi
    ;;
  *)
    echo "用法: $0 {start|stop|status}"; exit 2
    ;;
esac
