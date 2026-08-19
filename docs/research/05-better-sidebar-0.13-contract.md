# better-sidebar 0.13.0 契约差异与互斥机制核验（t6）

> 调研人：asset-researcher｜日期：2026-08-18
> 依据（全部经 read/grep/bash 读本地文件核验，未调用任何 client 侧 inspect）：
> - `/home/dc/.dsh/profiles/web/node_modules/dsh-better-sidebar/`（本机已升级 **0.13.0**）`lib/types/client/service.d.ts`（440 行）、`lib/client.js`（publish/mount gate/suspend 逻辑）、`lib/index.js`（host 半 externalDisable）、`README.md`（v0.13.0/v0.12.3 变更段）、`cordis.patch.yml`
> - 基线：`output-t2b-better-sidebar.md`（researcher 的 0.12.2 契约实证）
> 用途：t7 架构师按"核心独立 + 可插拔 UI 出口"原则修订计划 v1.2 的关键输入。

---

## 1. 版本与安装方式确认

| 项 | 值 |
|---|---|
| 本机实际版本 | **0.13.0**（`package.json` version、`SIDEBAR_SERVICE_VERSION = "0.13.0"` 锁步） |
| 挂载方式 | `dsh.profile.bundles` 协调 + `cordis.patch.yml` 单 insert 行 `id: better-sidebar`（与 0.12.2 相同，无变化） |
| 升级路径 | npm 通道（`dsh plugin --profile web add dsh-better-sidebar`），非 link: 本地包 |

## 2. service.d.ts 契约差异清单（0.12.2 → 0.13.0）

### 2.1 差异总表

| # | 位置 | 0.12.2 | 0.13.0 | 变化类型 | 对 Lab Monitor 影响 |
|---|---|---|---|---|---|
| D1 | `SIDEBAR_SERVICE_VERSION` | `"0.12.2"` | `"0.13.0"` | 修改 | 版本探测应判 `>= 0.13` 语义而非等值 |
| D2 | `SidebarSettingToggleType` | `'switch' \| 'text' \| 'number'` | **+ `'select'`** | 新增 | 阈值面板可用下拉（如告警级别选择）；不用则无影响 |
| D3 | `SidebarSettingSelectOption`（新接口） | 无 | `value/title/desc/icon` | 新增 | 同 D2 |
| D4 | `SidebarSettingToggle.options?` / `multi?` | 无 | 新增字段 | 新增 | 同 D2（`multi` 多选写数组值，JSON 可序列化） |
| D5 | `TabDescriptor.urlTarget` | 字段已声明，注释标注 `v0.13.0+`（未生效） | **正式生效**（注释 `v0.13.0+`，语义同前） | 生效化 | Lab Monitor **不使用**（不抢外链）；若使用需 `features` 门控 |
| D6 | `SIDEBAR_FEATURES` | 9 项（已含 `urlTarget` 预留） | **+ `'settingSelect'`**（10 项） | 新增 1 项 | 真正新增能力只有 `settingSelect`；`features` 单调追加机制不变 |
| D7 | `FileViewerProps` | 无工具栏字段 | + `toolbar?` / `onToolbarState?` / `onToolbarControls?` | 新增 | 标注"Internal (built-in text editor)"——**外部 viewer 忽略即可**，忽略者渲染如旧 |
| D8 | `EditorToolbarState` / `EditorToolbarControls`（新接口） | 无 | 有 | 新增 | 同上，仅内置编辑器合并模式使用 |
| D9 | `BetterSidebarService` 方法集 | registerTab/registerFileViewer/getTabs/getFileViewers/getTab/isTabEnabled/isViewerEnabled/matchFileViewer/openTab/closeTab/subscribe/version/features/getSnapshot/subscribeState/updateTab/activateTab/openFile | **完全相同** | 无变化 | 核心 RPC 面零变化 |
| D10 | `TabDescriptor` 其余字段（id/title thunk/icon/order/hidden/available/single/dedupeKey/createTab/settings/badge/onOpen\|onActivate\|onClose/component） | — | — | **无变化** | Lab Monitor 依赖项全兼容 |
| D11 | `TabComponentProps.visible` | 活动 tab 且面板打开 | 相同 | 无变化 | 省电暂停语义不变 |
| D12 | `SidebarSettingsDeclaration`（toggles/pluginToggles/render） | — | — | 无变化 | 阈值面板 `pluginToggles` 机制不变 |

### 2.2 结论：对外部 Tab 插件（Lab Monitor）的契约面 **0.12.2 → 0.13.0 完全向后兼容**
- registerTab / badge / title thunk / visible / pluginToggles / render / onOpen|onActivate|onClose / single / dedupeKey 全部不变；
- 新增项（select 设置行、urlTarget 生效、viewer 工具栏）均为**可选能力**，不用即无感；
- 唯一需要注意：`features` 多了 `settingSelect`，若代码按"已知 features 列表"硬编码判断请改为 `includes()` 语义（features 只增不减，官方保证）。

## 3. 互斥机制确认（aionui-panel）

### 3.1 README 官方描述（v0.13.0 变更段）
> 与 dsh-web-ui 家族右侧面板互斥：读取 `aionui-panel` 设置命名空间的提供方选择——当选择「使用 aionui-panel」时，整个 better-sidebar（右侧栏 / 底部面板 / 浮动入口 / 各类接管）不再挂载；选择 DSH-better-sidebar（或未安装 aionui）时正常。设置页保存后实时生效（settings-document 推送），无需刷新。

### 3.2 实现核验（lib/index.js + lib/client.js 源码）

**① 判定方 = Host 半**（lib/index.js L2684）：
```js
const externalDisable = () => {
  return (sctx.settings.describe({ redactSecrets: true })
    .find((candidate) => candidate.ns === "aionui-panel")?.value)?.rightPanel === "aionui-panel";
};
```
- 设置命名空间：**`aionui-panel`**（dsh-web-ui 家族注册）；字段：**`rightPanel`**；值：`"aionui-panel"` → better-sidebar 被外部禁用。
- 判定在 host 半（settings 服务 describe），通过 settings RPC 的 `externalDisable` 字段传给 client（`settingsFace.externalDisable`）。

**② Client 半行为**（lib/client.js）：
- `ctx.provide("betterSidebar", service)` 在 `apply()` **开头无条件发布**（L9534）——**互斥不影响服务发布**；
- `registerBuiltins(ctx, service)` 亦无条件注册（effect）——内置 tab/viewer 注册表始终存在；
- `sync()`（L9583-9586）：`loadExternalDisable(api)` → `sidebarStore.setSuspended(suspended)` → **`if (suspended) unmount()`**——只卸载侧边栏 UI DOM，不撤销服务；
- `loadExternalDisable`（L8291-8294）：**任何失败（路由拒绝、aionui 缺失、格式错误）读 false** → "未安装 dsh-web-ui 家族时永不误禁"；
- 挂载门（L2398）：`if (store.getSuspended()) return null`（+ 菜单渲染返回 null）；
- 实时生效：`ctx.get("remote")?.$on?.("settings/document-updated", sync)`（L9592）——保存设置即重新 sync，无需刷新；
- **`suspended` 不在 `getSnapshot()` 快照中**（源码注释明示 "Not part of the snapshot — nothing renders on it"），服务 API 无任何方法暴露该状态。

### 3.3 本机现状
- `~/.dsh/profiles/web/node_modules/` 与 `package.json` / `pnpm-lock.yaml` **均无 aionui-panel / dsh-web-ui 家族包** → `externalDisable` 恒为 false，互斥当前不生效；
- 但用户未来可能安装 dsh-web-ui 家族 → **必须防御**。

## 4. 结论（三选一 + 证据）

### 结论：**B（存在需规避的兼容性风险）+ A 部分成立 —— 需要"服务存在性 + UI 可见性"双重判定**

| 场景 | ctx.get('betterSidebar') | registerTab 结果 | 用户可见性 | 证据 |
|---|---|---|---|---|
| 未安装/未挂载 better-sidebar | `undefined` | —（判空跳过） | — | context-types.d.ts：client 半提供，host 侧 undefined；guard 门面 ctx.get 免声明、缺席返回 undefined（t2b §3） |
| 已挂载、未选 aionui（本机现状） | 服务对象 | 成功，Tab 正常显示 | ✅ | apply() 无条件 provide + mount() |
| 已挂载、选了 aionui-panel | **服务对象（非 undefined）** | **成功（注册表照常）** | ❌ **UI 整体不挂载，Tab 不可见** | lib/client.js L9534 无条件 provide；L9585-9586 suspended 时仅 unmount()；suspended 不在快照 |

**风险点**：0.13.0 之前只有"服务缺席"一种不可用形态，`ctx.get` 判空即可降级（A）；0.13.0 起新增"服务在、UI 隐形"形态——**仅判空无法识别**，且服务 API 不暴露 suspended。若 Lab Monitor 只做判空，用户在 aionui 场景会"注册成功但看不到任何东西"，无提示无兜底。

**规避方案（对 Lab Monitor 适配器层）**：
1. **不依赖客户端探测**：host 半直接读 settings 命名空间 `aionui-panel`（host 半 `settings.describe` 可用，better-sidebar 自己的 host 半即此姿势），得到 `rightPanel === 'aionui-panel'` 即"better-sidebar 出口不可见"；host 半可监听 `settings/updated` 事件（Event 目录已确认存在）实时刷新该标志；
2. host 半把该标志并入现有 `harness.handle` 快照 RPC（如 `getSnapshot` 返回 `{ ui: { betterSidebarVisible: boolean } }`），client 出口适配层按标志决定：注册 better-sidebar Tab 还是**自动切换 conversation.view 原生兜底**（t3 v1.2 已把 conversation.view 定为默认兜底出口，此标志补全"何时切"的判据）；
3. 注册 better-sidebar Tab 的代码保持 `ctx.get('betterSidebar')` 判空（服务缺席静默）+ 上述可见性标志（UI 隐形时静默跳过该出口）——**两种不可用形态都覆盖，核心层（采集/告警/工具/prompt 注入）不受任何影响**。

## 5. 对 Lab Monitor 适配器层的影响清单

| 影响 | 处置 |
|---|---|
| 核心层（Host 半全部 + Client 数据消费者） | **零影响**：不依赖 better-sidebar 任何契约；快照 RPC 增加 `ui.betterSidebarVisible` 字段即可 |
| better-sidebar 出口（Client） | 判空（服务缺席）+ 可见性标志（UI 隐形）双检查；契约字段全部兼容 0.12.2（badge/title thunk/visible/pluginToggles/render 不变）；`features.includes('settingSelect')` 门控才用 select 设置行（阈值面板用 number 行即可，不强依赖） |
| conversation.view 兜底出口 | 保持零第三方依赖；作为"服务缺席/UI 隐形"双场景的统一兜底；优先注册，better-sidebar 可用时再叠加 |
| 版本耦合 | 锁定 0.13.0 语义（service.d.ts 对比确认向后兼容）；升级前跑一次本差异清单 |
| 其他 | `urlTarget` 不使用（不抢外链）；v0.12.3 的皮肤令牌/路径/终端改动为内部机制，不涉外部契约 |

## 附：核验证据文件清单

| 文件 | 关键证据 |
|---|---|
| `~/.dsh/profiles/web/node_modules/dsh-better-sidebar/lib/types/client/service.d.ts`（440 行） | D1-D12 全部差异；`SIDEBAR_FEATURES` 含 `settingSelect` |
| `~/.dsh/profiles/web/node_modules/dsh-better-sidebar/lib/client.js` L9534 / L9583-9597 / L8291-8294 / L867-880 / L2398 | 无条件 provide；suspended→仅 unmount；loadExternalDisable 失败读 false；suspended 不进快照；+ 菜单挂载门 |
| `~/.dsh/profiles/web/node_modules/dsh-better-sidebar/lib/index.js` L2684 | host 半 `ns === "aionui-panel"` 且 `rightPanel === "aionui-panel"` 判定 |
| `~/.dsh/profiles/web/node_modules/dsh-better-sidebar/README.md` v0.13.0 / v0.12.3 段 | 官方互斥描述与 v0.12.3 内部机制 |
| `output-t2b-better-sidebar.md` | 0.12.2 基线契约（对照源） |
