# 12 Lab Monitor V2 正式插件迁移方案（动态 → 正式）

> **归档注记（2026-08-20 清理）**：本文所述 v1.4.5 MVP 资产（`plugin/`、`scripts/dev-run.sh`、`lab-monitor.define.json`）已归档至 `docs/archive/v1.4.5-plugin/`，dev-run.sh 已随迁移退役（本文 §6 所述）。

> 状态：设计定稿（2026-08-19）。依据官方规范：plugin-specialist docs（tool-catalog / cordis-tutorial
> / packages/AGENTS）+ 官方仓库 /tmp/dsh-repo + dsh-better-sidebar@0.13.0 实装参照。
> 用户要求：**TS 开发，全面遵循官方规则**。

## 1. 为什么迁移（动态插件 vs 正式插件）

| 维度 | 动态插件（v1.4.5 MVP） | 正式插件（V2） |
|---|---|---|
| 安装 | 会话内 `cordis_define`（无 CLI） | `dsh plugin --profile web add <pkg>` |
| 持久 | 进程内存，**重启消失**，会话隔离 | package.json + cordis.yml 行，**重启持久** |
| 代码形态 | 单函数体 concat（无 import） | **ESM 多文件 + TS**（自由 import） |
| 构建 | dev-run.sh 字符串拼接 | **tsc + tsdown**（官方构建链） |
| 服务注册 | 无（settings 持久化缺失） | schemastery + settings.register 可用 |
| Client 半 | host.call 轮询 + 页面 round trip | package.json `dsh.client` + `client-modules` 自动伺服 `/plugins/<id>/client.js` |

## 2. 官方正式插件规范（本迁移遵循）

### 2.1 包结构（dsh-better-sidebar 实装 + official repo 双重参照）

```
lab-monitor/
├── package.json          # type:module, main:lib/index.js, exports, peerDeps, dsh.client
├── tsconfig.json         # strict:true, noImplicitAny（官方 rule）
├── tsconfig.build.json   # 构建用（tsc 产 lib/types）
├── tsdown.config.ts      # host: lib/types/*.js → lib（ESM node）；client: clientBundle()
├── cordis.patch.yml      # bundle patch：insert 插件行（dsh plugin add 自动挂载）
├── src/
│   ├── index.ts          # host 半入口：export { name, apply, inject, config? }
│   ├── sampler/          # 采样后端（TS 化，自由 import）
│   ├── client.ts         # client 半入口（React + slots/betterSidebar）
│   └── ...
└── lib/                  # 构建产物（tsc→tsdown）
```

### 2.2 关键规范点（官方实证）

1. **Host 半**：`export { name, apply, inject, config }`；`inject` 数组声明硬依赖（shell/timer/...）；
   可选服务 `ctx.get(name)`；副作用必须挂 ctx（on/effect/interval 的 disposer）。
2. **Client 半**：package.json `"dsh": {"client": {"platform":"web", "inject":[], "immediately":true}}` +
   `exports["./client"]` → 打包产物；`client-modules` 自动伺服 `/plugins/<id>/client.js?rev=<rev>`。
   Client bundle 格式：`window.__ModuleLoader__.load({id, factory})`，外部依赖走注入 require。
3. **cordis.patch.yml**：`insert` 插件行 → `dsh plugin add` 自动挂载（无需手改 profile cordis.yml）。
4. **安装**：`dsh plugin --profile web add link:/home/dc/projects/lab-monitor`（现成先例：
   dsh-crypto-randomuuid-polyfill = link: 本地路径）。
5. **peerDeps**：@deepseek-ai/cordis（^4.0.1）+ 消费的 @deepseek-ai/dsh-* 服务包
   （better-sidebar 列举 18 个；lab-monitor 只需消费的几个）+ react@18.2。

### 2.3 构建链（better-sidebar scripts 实证）

```json
"scripts": {
  "build": "rm -rf lib && tsc -p tsconfig.build.json && tsdown",
  "typecheck": "tsc --noEmit",
  "watch": "tsdown --watch"
}
```

- tsc → `lib/types/*.js`（strict 检查 + emit）
- tsdown host 配置：`entry: ['lib/types/index.js'], outDir: 'lib', format:['esm'], platform:'node', target:'es2024'`
- tsdown client 配置：`clientBundle('lab-monitor', ['lib/types/client.js'])`（ModuleLoader 格式）

## 3. lab-monitor 现状 → V2 映射

### 3.1 服务依赖（审计结果）

| ctx 服务 | 现用法 | V2 处理 |
|---|---|---|
| `shell` | makeRunner(ctx.shell)，采样/ps 通道 | `inject: ['shell']`（硬依赖，平台恒有） |
| `timer` | ctx.interval/timeout（采样 tick/退避） | `inject: ['timer']`（或 cordis 内置 timer helper） |
| `settings` | ctx.get('settings') 可选（阈值事实来源） | `ctx.get('settings')` 可选 + **schemastery 持久化（P2 2' 解锁）** |
| `systemPrompt` | ctx.get('systemPrompt') 可选（labstatus 注入） | `ctx.get('systemPrompt')` 可选（正式环境必有） |
| `slots`（client） | ctx.get('slots') 兜底出口 ② | client 半 inject 或 ctx.get |
| `betterSidebar`（client） | ctx.get 判空，可选 ③ | 同左（正式插件可 inject 可选） |
| `tools`（host） | harness.registerTool（lab_status/advice/ctl） | **正式 API：ctx.tools 服务注册**（better-sidebar inject 'tools' 先例） |

### 3.2 需要改动的代码点

1. **去掉 concat**：sampler/ 六文件 + index.js 各自成为 TS 模块，`import` 互相引用（dev-run.sh 退役）。
2. **harness.handle → 正式 RPC 或直接函数**：动态沙箱的 `harness.handle('labMonitor.snapshot')`
   在正式插件里没有（那是动态 runner 的 invoke 表）。Client 半数据面改为：
   - 方案 A（推荐）：**client-modules 的注入 + host 注册的服务方法**（@Remote / ctx.remote 命名空间）
   - 方案 B（更简）：**webServer HTTP 路由**（better-sidebar 同款：/lab-monitor/snapshot → JSON）
3. **tools 注册**：`harness.registerTool(ctx, harness.defineTool(...))` → 官方 `ctx.tools` 的正式注册
   （dsh-tools 服务：`ctx.tools.register` 或 inject tools 后直接注册）。
4. **settings 持久化**：schemastery 声明配置 schema → 阈值跨重启保留（P2 2' 解锁）。
5. **sandboxPolicy danger-full-access**：正式插件环境 shell 沙箱策略需要重新确认
   （web profile 的 shell 沙箱在正式插件注入 shell 时如何配置——需实证）。

### 3.3 里程碑影响

- P2 2'（settings 持久化）：V2 解锁 → 验收项从"留 v2"转"可做"
- P0 6'（互斥形态）、P0 2'（会话端到端）、P0 3'（无 GPU 机）：正式插件下重新走会话内实证
- 回归红线：client 半重写后需重跑 P0 1/2/5/6

## 4. 迁移步骤（执行顺序）

1. **包骨架**：package.json + tsconfig + tsdown.config + cordis.patch.yml
2. **TS 化 host 半**：src/index.ts + src/sampler/*.ts（搬运逻辑，import 化，类型标注）
3. **host 半服务接入**：inject 声明 + tools 正式注册 + settings/schemastery
4. **client 半 TS 化**：src/client.ts（React + slots 兜底 + better-sidebar 适配器）
5. **构建链**：tsc + tsdown → lib/（host ESM + client ModuleLoader bundle）
6. **安装验证**：`dsh plugin --profile web add link:...` → cordis.patch.yml 自动挂载 → 重启验证
7. **回归**：verify.sh 适配新结构（dev-run/verify-host/mock-test 指向 src 或 lib）
8. **文档**：架构/协议/里程碑/计划全面更新（V2 章节）

## 5. 风险与实证点

| 风险 | 实证方式 |
|---|---|
| host 半 tools 正式注册 API 形态 | 读 dsh-tools 包源码 + better-sidebar lib/index.js 注册段 |
| client 半数据面（RPC 或 HTTP） | 动态 runner 的 invoke 表在正式插件不存在 → 必须选型 |
| shell 沙箱在正式插件的策略 | 实装后跑 verify-sampler 验证 /mnt/c interop 仍通 |
| settings.register 需 schemastery | 读 dsh-settings 包 + better-sidebar config.ts 参照 |
| link: 安装后 cordis.patch.yml 自动挂载 | dsh plugin add 实证（先例：randomuuid-polyfill） |

## 6. KV 缓存命中率骤降分析（用户实测：90% → 50%）——已实证根因

### 6.1 结论：lab-monitor 的动态 prompt 注入是头号嫌疑，机制已实证

用户报告「模型缓存命中率骤降（90% → 50%）」，怀疑与 lab-monitor 注入消息有关。
**实证确认机制成立**（dsh-system-prompt + dsh-agent-loop 源码）：

1. `dsh-agent-loop` 的 `preStep()`（**每个模型步**）调用 `systemPrompt.assemble()`
2. `assemble()` 内 `variables[name] = provider(context)` —— **每次模型步重新执行 labstatus provider**
3. labstatus 内容基于 2s 采样（GPU %/CPU %/告警数）→ **数值必然每步变化**
4. 变化点之后的 prompt 段（后续 sections + **全部对话历史** + 工具定义）**KV 前缀缓存全部失效**

这是「动态注入」与「前缀缓存」的**结构性冲突**，不是注入格式错误：
- 之前 90%+：system prompt 静态，多轮对话共享前缀
- 现在 50%：每步 labstatus 都变，前缀在 labstatus 位置断裂，其后所有历史失效

### 6.2 V2 处理（已落地在 src/index.ts）

- **默认关闭 prompt 注入**（`config.promptInjection`，默认 false）
- 状态信息改为 **`lab_status` 工具按需查询**（工具结果不进 system prompt 前缀，不破坏缓存）
- `promptInjection: true` 时仍可用（用户显式开启，接受缓存代价）
- 完整 KV 缓存原理与证据链存档：本文件 §6 + dsh-system-prompt/dsh-agent-loop 源码路径

### 6.3 对其他插件的启示

任何「每模型步重渲染的动态 systemPrompt 变量」都会破坏前缀缓存：
- 建议：低频（分钟级）或按需（工具/事件触发），避免每步 provider 重渲染
- 这是 DSH 插件开发的重要性能约束，已回填 plugin-specialist 认知

## 7. 运行时修复（2026-08-20 重启实证）

正式插件首次加载（02:43 重启）发现 3 个动态版不存在的运行时问题，均已修复并验证：

### 7.1 webServer/tools 必须进 inject（ctx.get 拿不到未注入服务）
- 现象：`webServer 服务缺席，HTTP 数据面不可用` + `工具注册失败: reading 'layers'`
- 根因：正式插件上下文中 `ctx.get('webServer')`/`ctx.get('tools')` 返回 undefined
  （cordis `_getImpl` 只在隔离注册表查已注入服务）；动态版 harness 直接提供，掩盖了差异
- 修复：`inject = ['shell', 'timer', 'webServer', 'tools']`（与官方 better-sidebar 一致），
  改 `ctx.webServer`/`ctx.tools` 属性直访（inject 后 cordis 保证属性挂载）
- 类型：`src/types.d.ts` 加 `import type {} from '@deepseek-ai/dsh-host-webserver'` 等触发模块声明合并

### 7.2 tools.register 解构丢 this
- 现象：`Cannot read properties of undefined (reading 'layers')`（ToolRegistry.layers 类字段）
- 根因：`const register = toolsService.register` 解构后 this 丢失（register 依赖类字段）
- 修复：直接 `toolsService.register(defineTool(...))` 调用

### 7.3 工具 render 固定 null → Agent 结果不可见
- 现象：`lab_status` 返回完整快照，但 `lab_advice`/`lab_ctl` 返回 null
- 根因：工具结果到 Agent 消息走 `output.render(value)`；lab_advice/lab_ctl 的 render
  固定返回 `renderText(null)`，value 被丢弃 → Agent 看到 null
- 修复：render 改为 `(_args, value) => renderText(value)`；execute 返回统一 `{ok:true,...}` 形状

### 7.4 验证状态（02:50 重启后）
- HTTP 数据面全通：snapshot/history/advice/setThresholds/control 均 200 + 真实数据
- Agent 工具：`lab_status` 返回完整快照（GPU/CPU/内存/进程/告警）
- `lab_advice`/`lab_ctl` 修复后待 03:xx 重启验证
