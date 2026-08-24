#!/usr/bin/env bash
# ============================================================================
# verify.sh —— CI 式自测（计划 §5.5）
# ----------------------------------------------------------------------------
# 运行：scripts/verify.sh
# 内容：
#   1. typecheck（tsc --noEmit）+ 构建（tsc + tsdown → lib/）
#   2. 目录完整性（对照 V2 结构 src/ + scripts/ + docs）
#   3. 契约静态核对（03-protocol 字段 / 04-milestones 存在等关键字）
#   4. host 逻辑回归：scripts/verify-host.js（import lib/types，~140 断言，2026-08-23 适配 TRAIN_PATTERNS）
#   5. client 逻辑回归：node scripts/mock-test.js（import lib/types/client，HTTP 数据面）
#   5b. M1 告警通知单元验证：node scripts/verify-m1.js（resolveAction 全格 + metricOf 指标提取，19 断言）
#   6. 真实采样（可选，-g 关闭）：scripts/verify-sampler.js（GPU/interop 实测）
#   7. P1/P2 端到端实证（可选，--e2e 开启，真实 python 进程 ~2.5min）：scripts/e2e-host.js
# 退出：任一失败 → 非 0
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")/.."

RUN_SAMPLER=1
RUN_E2E=0
for arg in "$@"; do
  [ "$arg" = "--no-sampler" ] || [ "$arg" = "-g" ] && RUN_SAMPLER=0
  [ "$arg" = "--e2e" ] && RUN_E2E=1
done

FAILS=0
ok()  { echo "  ✓ $1"; }
bad() { echo "  ✗ $1"; FAILS=$((FAILS + 1)); }

echo "== [1] typecheck + 构建（V2：tsc --noEmit + tsc/tsdown → lib/） =="
if timeout 120 pnpm exec tsc --noEmit -p tsconfig.json >/dev/null 2>&1; then ok "typecheck 通过"; else bad "typecheck 失败"; fi
if timeout 180 pnpm build >/dev/null 2>&1; then ok "构建产物 lib/ 生成"; else bad "构建失败"; fi

echo "== [2] 目录完整性（计划 §1） =="
MISSING=0
for f in   src/index.ts   src/client.ts   src/sampler/backend-interface.ts   src/sampler/backend-linux.ts   src/sampler/backend-windows.ts   src/sampler/backend-windows-native.ts   src/sampler/index.ts   src/sampler/windows-paths.ts   src/core/constants.ts   src/core/types.ts   src/core/ring.ts   src/core/state-machine.ts   src/core/balancer.ts   package.json   tsconfig.json   tsdown.config.ts   cordis.patch.yml   scripts/verify.sh   scripts/verify-host.js   scripts/verify-sampler.js   scripts/e2e-host.js   scripts/mock-test.js   docs/architecture/core.md   docs/reference/data-model.md   docs/reference/protocol.md   docs/reference/milestones.md   docs/architecture/ui-adapters.md   docs/plan/PLAN-v1.4.5.md   docs/research/12-v2-migration.md ; do
  [ -f "$f" ] || { echo "  ✗ 缺: $f"; MISSING=1; }
done
[ "$MISSING" -eq 0 ] && ok "必备文件齐全" || bad "存在缺失文件"

echo "== [3] 契约静态核对（docs/03-protocol lab-protocol/1.1） =="
CONTRACT=1
grep -q "lab-protocol/1.1" docs/reference/protocol.md 2>/dev/null || { CONTRACT=0; }
for field in "alertsCriticalCount" "callCount" "betterSidebarVisible" "gpuState" "platform"; do
  grep -q "$field" docs/reference/protocol.md || { echo "  ✗ protocol 缺字段: $field"; CONTRACT=0; }
  grep -q "$field" src/index.ts || { echo "  ✗ host 缺字段实现: $field"; CONTRACT=0; }
done
[ "$CONTRACT" -eq 1 ] && ok "契约关键字段 host 侧一致" || bad "契约字段不一致"

echo "== [4] host 核心引擎自测（verify-host.js，import lib/types） =="
if timeout 60 node scripts/verify-host.js >/dev/null 2>&1; then ok "verify-host ALL PASS"; else bad "verify-host 失败"; fi

echo "== [5] client 逻辑回归（mock-test.js，HTTP 数据面） =="
if timeout 60 node scripts/mock-test.js >/dev/null 2>&1; then ok "mock-test ALL PASS"; else bad "mock-test 失败"; fi

echo "== [5b] M1 告警通知单元验证（verify-m1.js，resolveAction 全格 + metricOf） =="
if timeout 30 node scripts/verify-m1.js >/dev/null 2>&1; then ok "verify-m1 ALL PASS"; else bad "verify-m1 失败"; fi

echo "== [5c] 差异化阈值覆盖链验证（verify-overrides.js，#13-3 resolveThresholds 全链路） =="
if timeout 30 node scripts/verify-overrides.js >/dev/null 2>&1; then ok "verify-overrides ALL PASS"; else bad "verify-overrides 失败"; fi

echo "== [5d] 进程详情增强验证（verify-proc-detail.js，#16 所属实验/监控徽标/进程树） =="
if timeout 30 node scripts/verify-proc-detail.js >/dev/null 2>&1; then ok "verify-proc-detail ALL PASS"; else bad "verify-proc-detail 失败"; fi

if [ "$RUN_SAMPLER" -eq 1 ]; then
  echo "== [6] 真实采样实证（verify-sampler.js，GPU/interop 实测） =="
  if timeout 150 node scripts/verify-sampler.js >/dev/null 2>&1; then ok "verify-sampler 通过"; else bad "verify-sampler 失败"; fi
else
  echo "== [6] 真实采样跳过（--no-sampler）=="
fi

if [ "$RUN_E2E" -eq 1 ]; then
  echo "== [7] P1/P2 端到端实证（e2e-host.js，真实进程 T1-T5） =="
  # 2026-08-22（P1 批次）：timeout 200→300——真实采样 tick 与 waitForRule 窗口抖动，实测单跑
  # 在 200~240s 边界波动（2026-08-22 实测两次 200s/240s 超时后第三次 完整通过 EXIT=0）
  if timeout 300 node scripts/e2e-host.js >/dev/null 2>&1; then ok "e2e ALL PASS"; else bad "e2e 失败"; fi
else
  echo "== [7] 端到端实证跳过（--e2e 开启，真实进程 ~3min）=="
fi

echo ""
if [ "$FAILS" -eq 0 ]; then echo "==== verify.sh 全部通过 ===="; else echo "==== verify.sh: $FAILS 组失败 ===="; fi
exit "$FAILS"
