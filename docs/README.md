# Lab Monitor 文档索引

> 本文件是 docs/ 的导航中心：按**分类**组织，人读与 Agent 查阅共用。
> 项目内 Agent 另自动加载根目录 `AGENTS.md`（操作速查，本文档的精简版）。
> 使用手册完整版：`docs/usage/usage.md`。

## 快速导航（按需求找文档）

| 我想… | 看这份 |
|---|---|
| 知道 lab-monitor 怎么工作（架构） | `architecture/core.md`（引擎/出口/V2/M1-M3） |
| 理解告警/通知/路由/权限设计 | `architecture/alert-notify.md` + `research/22-issue5-alert-notify-design.md` |
| 用工具/面板/配置（人读完整手册） | `usage/usage.md` |
| Agent 在项目内干活（速查） | `AGENTS.md`（项目根） |
| 查数据结构（RunRecord/Alert/快照字段） | `reference/data-model.md` |
| 查 RPC/工具/事件契约 | `reference/protocol.md` |
| 查验收清单/里程碑 | `reference/milestones.md` |
| 了解设计决策依据（调研/评审） | `research/`（00-24/26/27） |
| 看历史计划 | `plan/`（PLAN-v1.1/1.3/1.4.5 归档） |
| 查已知问题 | `research/18-known-issues.md` |

## 分类清单

### 📐 architecture/ —— 架构设计（怎么造的）

| 文档 | 内容 |
|---|---|
| `core.md` | 核心引擎 7 模块（sampler/ring/state-machine/balancer/proc-aggregator/exp-type）+ UI 出口四出口 + V2 形态 + **§12 M1/M2/M3 架构** |
| `alert-notify.md` | 告警架构：严格分级（severity/urgency/trend/sustainedMs）+ 通知引擎 + 类型矩阵 + agentDir 路由 + 权限 guard + 消息链兜底 |
| `ui-adapters.md` | 出口注册策略 / 优先级 / 互斥规则 / 能力降级矩阵 |

### 📖 reference/ —— 参考说明（协议/数据/里程碑）

| 文档 | 内容 |
|---|---|
| `data-model.md` | 指标枚举 / 快照 / ring buffer / 状态机转移表 / RunRecord+Alert 字段（含 V2.8/V2.9 增补） |
| `protocol.md` | RPC 契约 + 工具契约 + 事件信封（冻结版） |
| `milestones.md` | P0/P1/P2 验收清单（勾选制） |

### 📗 usage/ —— 使用说明（怎么用）

| 文档 | 内容 |
|---|---|
| `usage.md` | 完整使用手册：工具契约（lab_status/lab_advice/lab_ctl/lab_status_ro）+ 面板 UI + 阈值/告警/类型/通知语义 + 持久化 + HTTP 数据面 + 变更记录（V2.4-V2.9） |

### 🔬 research/ —— 调研与设计（决策依据）

- **00-19**：架构基线 / 外部基准 / 内部资产 / 契约调研 / 采样实证 / e2e 记录 / KV 缓存 / 已知问题 / UI 集成
- **20-24**：issue #5 系列设计（20 方案 F / 21 T2 分级+类型 / **22 综合设计定稿** / 23 评审 / 24 T1 agent 调研）
- **26-27**：prompt 注入替代性分析 + #4/#5 验收审查（2026-08-24）
- 关键入口：`22-issue5-alert-notify-design.md`（M1/M2/M3 设计事实源）

### 📦 plan/ —— 历史实施计划（归档）

- `PLAN-v1.1.md` / `PLAN-v1.3.md` / `PLAN-v1.4.5.md`：MVP→v2 演进的历史计划（现行状态以 README 与 architecture/ 为准）

### 🗄 archive/ —— 旧资产归档

- `v1.4.5-plugin/`：v1.4.5 动态插件版源码快照（2026-08-20 归档，仅供查档）

## Agent 查阅指引

1. **操作速查** → 项目根 `AGENTS.md`（工具契约 / 实验识别规则 / 验证清单 / 配置键）
2. **架构理解** → `architecture/core.md` §12（M1/M2/M3）+ `architecture/alert-notify.md`
3. **设计决策** → `research/22-issue5-alert-notify-design.md`（综合设计）+ `research/26`（prompt 注入替代）
4. **契约细节** → `reference/protocol.md` + `reference/data-model.md`
5. **变更历史** → `usage/usage.md` §8 变更记录 + README V2.x 演进段
