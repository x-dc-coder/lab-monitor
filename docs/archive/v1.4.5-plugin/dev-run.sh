#!/usr/bin/env bash
# ============================================================================
# dev-run.sh —— MVP 确定性组装器（T1-3 / D4-1）
# ----------------------------------------------------------------------------
# 用法：scripts/dev-run.sh [--check] [--out-file <path>]
# 职责：
#   1. 按 D4-1 固定顺序 concat sampler/ 六文件 + host/index.js → code.host
#      （禁 import/export，顶层函数共享作用域、顺序敏感初始化区）
#   2. code.client = plugin/client/index.js
#   3. node --check 两个半（语法预检，等同 cordis_define 的 precheck）
#   4. 组装 cordis_define 参数载荷 JSON（name/purpose/code.host/code.client）
#   5. 默认打印载荷（队长可粘贴或经工具传入 cordis_define）；--out-file 落盘
#   --check 仅做语法与目录完整性校验，不输出载荷
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."   # 项目根

MODE=print
OUT_FILE=""
for arg in "$@"; do
  case "$arg" in
    --check) MODE=check ;;
    --out-file) MODE=outfile ;;
    --out-file=*) OUT_FILE="${arg#*=}"; MODE=outfile ;;
    *) if [ -z "$OUT_FILE" ]; then OUT_FILE="$arg"; MODE=outfile; fi ;;
  esac
done

HOST_PARTS=(
  "plugin/host/sampler/backend-interface.js"
  "plugin/host/sampler/windows-paths.js"
  "plugin/host/sampler/backend-linux.js"
  "plugin/host/sampler/backend-windows.js"
  "plugin/host/sampler/backend-windows-native.js"
  "plugin/host/sampler/index.js"
  "plugin/host/index.js"
)
CLIENT_PART="plugin/client/index.js"

err() { echo "✗ $*" >&2; exit 1; }

# —— 目录/文件完整性 ——
[ -f "plugin/host/index.js" ] || err "缺少 plugin/host/index.js"
[ -f "$CLIENT_PART" ] || err "缺少 $CLIENT_PART"
for f in "${HOST_PARTS[@]}"; do
  [ -f "$f" ] || err "缺少 $f"
done

mkdir -p /tmp/lab-monitor-build
HOST_BUILD=/tmp/lab-monitor-build/code.host.js
CLIENT_BUILD=/tmp/lab-monitor-build/code.client.js

: > "$HOST_BUILD"
for f in "${HOST_PARTS[@]}"; do
  # 各文件间空行分隔（避免上一文件结尾注释吞掉下一文件首行）
  { echo; cat "$f"; } >> "$HOST_BUILD"
done
cp "$CLIENT_PART" "$CLIENT_BUILD"

# —— 语法预检（等同 cordis_define precheck 的编译门禁）——
node --check "$HOST_BUILD"  || err "code.host 语法错误"
node --check "$CLIENT_BUILD" || err "code.client 语法错误"
echo "✓ code.host ($(wc -l < "$HOST_BUILD") 行) + code.client ($(wc -l < "$CLIENT_BUILD") 行) 语法通过"

if [ "$MODE" = "check" ]; then
  echo "✓ dev-run --check 完成（目录完整 + 双半语法）"
  exit 0
fi

# —— 组装 cordis_define 载荷 ——
NAME="lab-monitor"
PURPOSE="本机秒级科研实验监控：采样/状态机/平衡引擎/告警/Agent 工具/prompt 注入 + conversation.view 兜底 UI（核心独立，无第三方依赖）"

node --input-type=module - "$HOST_BUILD" "$CLIENT_BUILD" "$NAME" "$PURPOSE" "$OUT_FILE" <<'NODE'
import { readFileSync } from 'node:fs'
const [, , hostPath, clientPath, name, purpose, outFile] = process.argv
const payload = {
  name,
  purpose,
  code: {
    host: readFileSync(hostPath, 'utf8'),
    client: readFileSync(clientPath, 'utf8'),
  },
}
const json = JSON.stringify(payload)
if (outFile) {
  import('node:fs').then((fs) => fs.writeFileSync(outFile, json))
  console.log('✓ 载荷已写入 ' + outFile + '（' + json.length + ' 字节）')
} else {
  process.stdout.write(json + '\n')
}
NODE
