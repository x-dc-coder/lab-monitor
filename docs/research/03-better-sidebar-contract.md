# better-sidebar 契约核验与参考实现分析（t5）

> 调研人：researcher｜日期：2026-08-18
> 依据（全部经 read/grep/bash 读文件核验，未调用任何 client 侧 inspect）：
> - `/home/dc/.dsh/profiles/web/node_modules/dsh-better-sidebar/`（v0.12.2）`lib/types/client/service.d.ts`、`lib/types/context-types.d.ts`
> - `/home/dc/dsh-plugins/my-tabs-plugin/`（用户已验证的第三方 tab 参考实现）：`src/client/index.js`（773 行）、`cordis.patch.yml`、`package.json`
> - `<dsh>/node_modules/@deepseek-ai/dsh-cordis-client-runner/lib/client.js`（动态插件 client 半 guard 门面源码）、`lib/types/client/timer.d.ts`（timer 服务）
> 用途：t3 架构师写 Lab Monitor 可视化方案的关键输入。

---

## 1. TabDescriptor / registerTab / TabComponentProps 契约要点

### 1.1 服务发布形态（context-types.d.ts）

```ts
betterSidebar: BetterSidebarService;  // "The client-side sidebar registry: external plugins
                                      //  register tab types and file previewers here.
                                      //  Provided by the client half; undefined on the host side."
```

- 服务由 **dsh-better-sidebar 的 client 半**发布到 Cordis context，名为 `ctx.betterSidebar`；host 侧为 undefined。
- 服务声明注释（service.d.ts L1-7）：消费者在 `inject` 中声明，调用 `registerTab` / `registerFileViewer`，**两者都返回 disposer**，Cordis 在 fiber 销毁时自动调用（HMR-safe）。

### 1.2 TabDescriptor（service.d.ts L117-201）

| 字段 | 类型 | 语义 |
|---|---|---|
| `id` | `string` | 全局唯一；同时是 `SidebarTab.type`（内置 `'explorer'`；插件惯例 `'my-plugin:db'`） |
| `title` | `string \| () => string` | **thunk 形式**（i18n 友好）；tab-bar 频繁渲染需便宜 |
| `icon` | `ReactNode \| (size) => ReactNode` | 也可 thunk |
| `order` | `number` | `+` 菜单排序，默认 100 |
| `hidden` | `boolean` | 从 `+` 菜单隐藏 |
| `available` | `(ctx, scope, state) => boolean` | `+` 菜单禁用谓词；**不**拦截 openTab |
| `single` | `boolean` | 单实例糖：`true` = `dedupeKey: () => id`（打开时聚焦已有 tab 而非新建重复） |
| `dedupeKey` | `(tab) => string \| undefined` | 匹配已有 tab 则聚焦；`undefined` = 不合并 |
| `createTab` | `(state) => { tab, patch? } \| null` | 自定义建 tab（mint id / 改 state）；`null` 拒绝创建 |
| `urlTarget` | `(url) => boolean` | v0.13.0+ 外链接管（当前 0.12.2 无） |
| `settings` | `SidebarSettingsDeclaration` | 见 1.3 |
| `badge` | `(ctx, scope, state) => string \| number \| null \| undefined` | **v0.12.0+ 角标**：数字=计数（99+ 封顶），字符串原样，null/undefined 隐藏；**每次 tab-bar 渲染都调用，必须便宜**；抛异常被吞（不显示） |
| `onOpen` / `onActivate` / `onClose` | `(tab, scope) => void` | **v0.12.0+ 生命周期回调**；**仅 service 路径触发**（openTab 实际创建 / activateTab / closeTab；dedupe 聚焦算 onActivate 不算 onOpen；builtin 直改 state 不触发任何回调）；抛异常只记日志不破坏流程 |
| `component` | `(props: TabComponentProps) => ReactNode` | 渲染函数 |

### 1.3 SidebarSettingsDeclaration（settings 声明，service.d.ts L74-99）

| 字段 | 语义 |
|---|---|
| `toggles` | 声明式设置行，**key 必须是 host PrefsSchema 字段**（内置如 'autoOpenSubagent'）；未知键被 settings seam 丢弃 |
| `pluginToggles` | **v0.12.0+ 插件自有设置**：key 插件本地，持久化在 sidebar prefs 文档 `pluginSettings[<descriptor id>]`，**无需改 host PrefsSchema**；值须 JSON 可序列化 |
| `render` | v0.12.0+ 自定义设置面板（收到 store/service/prefs/pluginSettings/updatePluginSetting/close） |

设置行控件类型：`'switch' | 'text' | 'number'`（number 带 min/max 钳制、unit 后缀）。

### 1.4 TabComponentProps（service.d.ts L101-115）

```ts
interface TabComponentProps {
  ctx: Context;
  store: SidebarStore;
  scope: SessionScope;
  tab: SidebarTab;
  /** Whether this tab is the active one AND the panel is open (live views pause otherwise). */
  visible: boolean;
  expanded?: string[]; onToggleDir?; onReferenceFile?; onOpenFile?; onOpenDiff?; onSubagentJump?;
}
```

**`visible` 语义**：tab 是活动 tab **且** 面板打开时为 true；tab 失活或面板收起即 false —— 官方明确要求 live 视图在 visible=false 时暂停。

### 1.5 Service 方法（BetterSidebarService，service.d.ts L268-354）

`registerTab(desc): disposer`、`registerFileViewer(desc): disposer`、`getTabs/getFileViewers/getTab`、`isTabEnabled(id)`（缺省=启用，显式 false 才禁用）、`matchFileViewer`、`openTab(seed, scope?)`（v0.12.0+ 可指定目标 session；content open 自动展开面板，type-only open 不展开）、`closeTab`、`activateTab`、`subscribe/subscribeState/getSnapshot`（侧边栏快照：sessionId/state/prefs）、`updateTab(tabId, {title?, path?, meta?})`、`openFile(scope, path, title?)`、`version`（'0.12.2'）、`features`（能力门控数组：badge/tabLifecycle/updateTab/openFile/targetedOpen/stateSubscription/tabMeta/pluginSettings/urlTarget）。

---

## 2. 参考实现 my-tabs-plugin 摘录

### 2.1 挂载与依赖声明

`cordis.patch.yml`（bundle 协调自动写入 dsh.profile.bundles）：
```yaml
- insert:
    - id: my-tabs
      name: my-tabs-plugin
```

`package.json` 关键段：
```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": {
    "platform": "web",
    "inject": ["@deepseek-ai/dsh-client-runtime", "dsh-better-sidebar"]
  }
}
```
（静态插件包级 inject 声明 client 半的硬依赖；动态插件则用返回插件对象上的 inject，见 §3。）

### 2.2 client/index.js：inject + apply + registerTab（L8-9, L752-773）

```js
export const inject = ['betterSidebar', 'slots']   // 硬依赖：betterSidebar、slots

export function apply(ctx) {
  ctx.effect(() =>
    ctx.betterSidebar.registerTab({
      id: 'my-tabs:usage',
      title: () => 'DeepSeek 用量',              // thunk 形式
      icon: (size) => createElement(IconUsageOutline16, { size }),
      order: 90,
      single: true,                               // 单实例
      component: (props) => createElement(Dashboard, props),  // props 原样透传（含 visible）
    }),
  )
  // slots 为可选服务：ctx.get 判空后再注入设置页 section
  const slots = ctx.get('slots')
  if (slots !== undefined) {
    slots.inject('settings.section', () => slots.register(
      { name: 'settings.section', id: 'my-tabs-usage', order: 110, label: 'DeepSeek 用量' },
      () => createElement(CredentialsPage),
    ))
  }
}
```

要点：**`registerTab` 的 disposer 包在 `ctx.effect()` 里** → fiber 销毁（HMR/stop/update）时自动注销；`slots` 用 `ctx.get` 可选消费（服务缺席时静默降级，不阻塞）。

### 2.3 client/index.js：visible 暂停轮询（L452-511, Dashboard 组件）

```js
function Dashboard({ scope, visible }) {          // visible 来自 TabComponentProps
  // ...
  useEffect(() => { loadAll(false) }, [loadAll])   // 首帧加载
  useEffect(() => {
    if (!visible || !auto) return                  // ★ visible=false → 不启动轮询
    const id = window.setInterval(() => loadAll(false), 60000)   // 60s 轮询
    return () => window.clearInterval(id)          // visible 变 false / 卸载 → 清理
  }, [visible, auto, loadAll])
  // loadAll → fetch('/my-tabs/api/summary?...') 同源 HTTP API（静态插件可注册路由）
}
```

注意：参考实现是**静态插件**，数据走同源 fetch + Host 路由；**动态插件没有同源路由**，对应姿势是 `host.call`（见 §3.2）。

---

## 3. 两条核心结论

### 结论①：动态插件 client 半能消费 betterSidebar —— 必须过 guard 门面，`ctx.get` 与属性访问规则不同

依据：dsh-cordis-client-runner `lib/types/client/guard.js`（动态插件 client 半的 ctx 是白名单代理）：

```js
const readService = (name, requireDeclaration) => {
  if (requireDeclaration && !declared.has(name)) return denyRead(name); // 属性访问需声明
  const service = denyContext(ctx.get(name), name, env);                // ctx.get 是可选查找
  ...
}
return new Proxy({}, {
  get(_target, prop) {
    if (prop === "get") return (name) => readService(name, false);  // ctx.get → 免声明
    ...
    return readService(prop, true);                                  // ctx.prop → 需声明
  },
})
```

| 访问方式 | 是否需要 `inject` 声明 | 服务缺席行为 | 结论 |
|---|---|---|---|
| `ctx.get('betterSidebar')` | **不需要**（optional lookup） | 返回 undefined（需判空） | ✅ 可用，适合可选消费 |
| `ctx.betterSidebar` 属性 | **必须**声明 `inject: ['betterSidebar']` | 未声明 → guard 抛教学错误 "service not declared by your plugin"；已声明 → 插件进入 waiting，服务激活后自动继续 | ✅ 推荐（硬依赖） |

- betterSidebar 由 dsh-better-sidebar 的 **client 半**发布（host 侧 undefined），动态插件的 client 半与它同页面加载，故可达。
- **推荐姿势**（与参考实现一致）：返回对象形态
  ```js
  return {
    inject: ['betterSidebar'],          // 也可加 'slots'（设置页）、'timer'（轮询）
    apply(ctx) {
      ctx.effect(() => ctx.betterSidebar.registerTab({ ... }))   // disposer 挂 fiber
    },
  }
  ```
  若想"有侧边栏就注册、无则静默"，用 `const bs = ctx.get('betterSidebar'); if (bs) bs.registerTab(...)`。
- guard 附加限制：ctx 只读（不能赋值）；服务返回值若是 cordis Context 会被拒；slots/theme 有专门守卫（slots 注册自动分配遮蔽优先级）。

### 结论②：host.call 轮询 + visible 暂停的落地方式（动态插件版）

1. **数据通道**：动态插件 client 半的闭包符号面含 `host`（README：参数即符号面 `React/console/styles/host`）；`host.call(method, args)` 经 `dynamicCordisRunner` Remote namespace 调**同包 host 半** `harness.handle` 注册的处理器，只驮 JSON（函数/undefined/类实例会被 codec 拒收）→ host 半跑 nvidia-ml-py/psutil 采集，`harness.handle('labMonitor.snapshot', ...)` 返回 JSON 快照，client 轮询该快照。

2. **轮询 + visible 暂停**（核心模式，照抄参考实现 L507-511 的骨架，但定时器来源不同）：
   ```js
   useEffect(() => {
     if (!visible) return                       // ★ tab 失活/面板收起 → 停轮询
     const timer = ctx.setInterval(() => refresh(), 5000)   // 动态插件用 timer 服务
     return () => timer()                       // 清理
   }, [visible, refresh])
   ```
   - **动态插件不能 `window.setInterval`**：浏览器 timer 全局被 guard 遮蔽（教学陷阱 TIMER_REDIRECT：`browser timer globals are unavailable in dynamic packages. Declare inject: ['timer'] ... In React, create timers from an event handler or React.useEffect and return callback-form disposers from the effect cleanup`）。
   - 正确姿势：`inject: ['timer']` → `ctx.setInterval(cb, delay)` / `ctx.interval(cb, delay)`（返回 **disposer**，fiber 销毁自动停）；高频刷新可用 `ctx.throttle(cb, delay)` / `ctx.debounce(cb, delay)`（节流防抖包装，fiber 归属）。timer 服务 API 见 `dsh-cordis-client-runner/lib/types/client/timer.d.ts`（与 host Cordis TimerService 同构：timeout/interval/setTimeout/setInterval/throttle/debounce）。
   - `visible` 语义：tab 是活动 tab **且**面板打开；因此"用户没在看这个 tab"时零轮询开销，切回来立即恢复（useEffect 依赖 visible 重新执行）。

3. **badge 更新**（v0.12.0+）：descriptor 的 `badge` thunk **每次 tab-bar 渲染都调用，必须便宜** → 不能在里面发 host.call；应让轮询把最近快照写入模块级变量/ref，badge thunk 只读该值：
   ```js
   let last = null                    // 模块级最近快照
   badge: () => last?.critical ? String(last.critical) : null   // 数字=计数(99+封顶)/字符串原样
   ```

---

## 4. 对 Lab Monitor Tab 的落地建议

1. **id 命名**：`lab-monitor:gpu`（命名空间前缀 + 冒号，与内置单字 id、参考实现 `my-tabs:usage` 惯例一致；id 兼作 SidebarTab.type，是 settings 启用开关的键）。
2. **badge 显示内容**：数字 = 告警计数（CRITICAL 级告警数，99+ 自动封顶）；字符串 = 精简状态（如 `OOM`、`3卡忙`）；null 隐藏。**只读模块级最近快照，禁止在 badge thunk 内发请求**。
3. **title thunk 格式**：`() => 'GPU 监控'` 静态最稳；若动态（如忙时加 `●`），thunk 必须 O(1) 读快照，不做任何计算/IO。
4. **settings 面板放哪些阈值**（用 v0.12.0+ `pluginToggles`，插件自有键持久化在 `pluginSettings['lab-monitor:gpu']`，无需改 host PrefsSchema）：
   - GPU util 告警阈值（`type:'number'`，如 90，min 0 max 100，unit `%`）
   - 显存占用告警阈值（`type:'number'`，如 95，unit `%`）
   - 温度告警阈值（`type:'number'`，如 85，unit `°C`）
   - 轮询间隔（`type:'number'`，如 5000，min 1000 max 60000，unit `ms`）
   - 自动轮询开关（`type:'switch'`，默认 true —— 对应参考实现 Dashboard 的 `auto` 状态）
5. **生命周期回调**：`onOpen/onActivate` 可用于"用户打开 tab 时立即拉一次快照"（体验优化）；`onClose` 停掉该 tab 私有轮询（badge 依赖的模块级快照可保留最后值）。注意回调仅 service 路径触发。
6. **capability 门控**：`ctx.betterSidebar.features.includes('badge')` 判断再注册 badge（0.12.0+ 才有）；`'pluginSettings'` 同理门控 settings 声明 —— 兼容旧版本不炸。
7. **轮询节奏建议**：visible 时 5s（host.call 快照，轻量）；badge 由同一快照驱动；`onClose` 后由 host 半决定是否继续采集（供未来 Agent 消费），client 侧零开销。
8. **数据流总览**：Host 半（nvidia-ml-py/psutil 采集 + `harness.handle('labMonitor.snapshot')`）⇄ `host.call` ⇄ Client 半（tab 组件轮询 + 模块级快照 → badge/title/仪表盘），全部 JSON，凭据与采集逻辑不出 host。

---

### 附：核验证据文件清单

| 文件 | 作用 |
|---|---|
| `~/.dsh/profiles/web/node_modules/dsh-better-sidebar/lib/types/client/service.d.ts`（392 行） | TabDescriptor/TabComponentProps/BetterSidebarService/features 契约 |
| `~/.dsh/profiles/web/node_modules/dsh-better-sidebar/lib/types/context-types.d.ts` | `ctx.betterSidebar` 服务发布声明（client half，host 侧 undefined） |
| `~/dsh-plugins/my-tabs-plugin/src/client/index.js`（773 行） | 参考实现：inject/apply/registerTab（L752-762）、visible 暂停轮询（L507-511）、slots 可选消费（L764-772） |
| `~/dsh-plugins/my-tabs-plugin/cordis.patch.yml`、`package.json` | 挂载行与 `dsh.client.inject: ["@deepseek-ai/dsh-client-runtime","dsh-better-sidebar"]` |
| `<dsh>/node_modules/@deepseek-ai/dsh-cordis-client-runner/lib/client.js` | guard 门面：`ctx.get` 免声明 / 属性访问需 inject 声明；timer 全局遮蔽教学错误 |
| `<dsh>/node_modules/@deepseek-ai/dsh-cordis-client-runner/lib/types/client/timer.d.ts` | Client timer 服务 API（ctx.setInterval/interval/throttle/debounce，返回 disposer） |
