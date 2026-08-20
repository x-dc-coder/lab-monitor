# 13 better-sidebar Tab 不显示诊断（2026-08-20）

> 状态：**已修复并验证**（2026-08-20 收尾）。输入：src/client.ts、dsh-better-sidebar lib/client.js（0.13.0）、DSH boot manifest、dsh-client-modules/client-modules 源码、浏览器 console/DOM 实测（kimi-webbridge）。
> 最终结论：**真正的根因是 ② 出口（conversation.view）注册姿势违反官方 slots 契约**——直接裸调 `slots.register()` 而未用 `slots.inject('conversation.view', () => slots.register(...))` 包裹，浏览器 console 抛 `slot "conversation.view" is not declared (a parent entry's children table must declare it)`，导致兜底出口注册失败。修复后 ③ 适配器（better-sidebar registerTab）正常工作、Tab 与面板均渲染成功。
>
> **后续澄清（2026-08-20 用户确认）**：实际部署中插件**未注册到 better-sidebar 侧边栏**，而是出现在**主页面会话区**（三个 tab：对话 / 轨迹 / GPU监控）——即 ② conversation.view 出口生效。用户要求保持现状，③ 适配器留待后续优化。

## 1. 现象

用户重启 DSH 后，better-sidebar 侧边栏**没有出现「GPU 监控」Tab**。之前动态版（v1.4.5）的 sidebar 适配器是工作的。

## 2. 已排除的假设（静态证据）

| 假设 | 结论 | 证据 |
|---|---|---|
| client 半未加载 | **排除** | DSH boot manifest 含 `{"id":"lab-monitor","url":"/plugins/lab-monitor/client.js?rev=c87a342b2084","inject":[],"immediately":true}`；`/plugins/lab-monitor/client.js` HTTP 200 |
| 跨 bundle 服务隔离 | **排除** | client-modules 源码确认：所有 bundle 共享同一 client root context（`ctx.reflect.provide("modules", ...)`），`ctx.get('betterSidebar')` 应能拿到跨 bundle 服务 |
| registerTab 契约不匹配 | **排除** | better-sidebar client.js 7330-7332 行：`label: typeof d.title === "function" ? d.title() : d.title`——title 函数受支持；我的 desc `{id, title:()=>'GPU 监控', order:90, single:true, badge, settings, component}` 与契约匹配；`filter(d => !d.hidden && isTabEnabled(d.id))`——hidden 未设（不隐藏）、tabsEnabled 默认启用 |
| 服务未发布 | **未排除** | better-sidebar 在 lib/client.js 9534 行 `ctx.provide("betterSidebar", service)`；若其 apply 晚于 lab-monitor 的 3 次重探（6 秒窗口），lab-monitor 会放弃并保持 conversation.view |

## 3. 最可能根因（需浏览器端确认）

1. **时序竞态**：lab-monitor `immediately:true` 立即 apply，`ctx.get('betterSidebar')` 在 better-sidebar apply 完成前返回 undefined，重探 3 次（2s 间隔 = 6s）仍拿不到 → 放弃，保持 conversation.view 兜底。better-sidebar 是重 bundle（~10k 行），apply 可能 >6s。
2. **settings 禁用**：better-sidebar store 的 `tabsEnabled['lab-monitor:gpu']` 若被用户配置为 false（或默认策略），Tab 被过滤。

## 4. 验证方法（需用户 GUI）

在浏览器打开 DSH（http://127.0.0.1:3080），按 F12 看 console：
- 若有 `[lab-monitor] better-sidebar 出口③已注册，已切换到增强 Tab` → 适配器注册成功，Tab 被 better-sidebar 过滤（查设置）
- 若有 `[lab-monitor] better-sidebar registerTab 失败` → 契约运行时错误（需看具体 error）
- 若两者都无 → client apply 未执行或 `ctx.get('betterSidebar')` 全程 undefined（时序竞态）

## 5. 修复建议（若为时序竞态）

src/client.ts 的 `tryProbe` 重探次数 `MAX_ATTEMPTS = 3`（6 秒）可能不足。改为**更长重探窗口**（如 10 次 × 2s = 20s）或**监听 better-sidebar 服务发布事件**。动态版（v1.4.5）因 harness 环境服务就绪快未暴露此问题，正式插件 bundle 大导致竞态显现。

## 6. 附带发现

- lab-monitor boot entry `inject: []` + `immediately: true`：立即执行且不等待任何服务。若改为 `inject: ['betterSidebar']` 会让 client 半 waiting 直到服务发布（但 t2b 结论①禁止——服务缺席会使整个 client 半 waiting、默认出口失效）。折中：保持 inject:[]，加长重探窗口。
- better-sidebar 的 `features` 数组（badge/pluginSettings）需在 desc 里探测后才挂载——当前代码正确。

## 7. 真根因与修复记录（2026-08-20 收尾，plugin-specialist 诊断）

### 7.1 真根因（非时序竞态）

时序竞态假设（§3.1）**不成立**。浏览器 console 实测（/tmp/dsh-chrome.log）捕获到唯一一条 lab-monitor 错误：

```
[lab-monitor] conversation.view 注册失败: Error: slot "conversation.view" is not declared
(a parent entry's children table must declare it)
```

错误抛出点：`dsh-client-ui-slots/lib/index.js:66`（`SlotCore.register` 要求 `rec.spec` 已存在——slot 必须先在父 entry 的 children 表中声明）。官方契约（`dsh-cordis-client-runner` 的 slots 文档 example）：

```js
return {
  inject: ['slots'],
  apply(ctx) {
    ctx.slots.inject('conversation.view', () => ctx.slots.register(
      { name: 'conversation.view', id: 'my-entry', order: 100, label: 'My entry' },
      () => React.createElement('div', null, 'hello'),
    ))
  },
}
```

**必须用 `slots.inject(key, cb)` 包裹 `slots.register`**：inject 订阅该 slot 的声明（ui-conversation 的 children 表），声明就绪后才执行注册；裸调 register 在声明未建立时直接抛错。lab-monitor 旧代码为 `slots.register({name:'conversation.view',...})`（无 inject 包裹）→ ② 兜底出口注册失败 → UI 完全不显示（会话区无卡片、侧边栏无 tab 均由此引起）。

### 7.2 修复（src/client.ts apply ② 出口）

```ts
const slotsSvc = slots as { inject(key: string, cb: () => () => void): () => void; register(desc: unknown, comp: unknown): () => void }
disposeView = slotsSvc.inject('conversation.view', () =>
  slotsSvc.register({ name: 'conversation.view', id: 'lab-monitor', order: 20, label: labelThunk }, MonitorPanel),
)
```

配套：scripts/mock-test.js 三处 slots 桩补齐 `inject(key, callback)`（立即执行 callback 返回 disposer，对齐官方契约）；package.json `dsh.client.inject` 由 `[]` 补齐为 `["@deepseek-ai/dsh-client-runtime", "@deepseek-ai/dsh-client-ui-slots"]`（client 半真实依赖）。

### 7.3 浏览器端验证（2026-08-20 09:5x，kimi-webbridge + vision 截图）

- boot 图 `lab-monitor` 条目 rev 与本地构建 sha1 前 12 位一致（DSH 实时提供新 bundle，no-cache）
- 侧边栏 tab 环出现「对话 | 轨迹 | 监控 GPU0 6% 15.4/15.9G CPU 15%」（③ 注册成功，label thunk 工作）
- 点击「监控」tab → 4 张卡片完整渲染：GPU（NVIDIA RTX 5060 Ti / 6% / 显存 15.4/15.9G / 39°C / 10W）、CPU、内存、告警区（INFO 显存占用 97% 置信 70%）
- 会话区无卡片属**设计行为**（docs/05 §1：③ 与 ② 互斥，③ 存在时替代 ②），非缺陷

### 7.4 经验沉淀

1. **client 半注册任何官方 slot 必须先 `slots.inject(key, () => slots.register(...))`**，裸调 register 必然抛 `not declared`。这是 slots 服务 children-table 声明的硬约束（平台 + 第三方 UI 包统一如此）。
2. 浏览器 console 是 client 半排障的唯一事实源：node 进程日志（/tmp/dsh-web.log）只含 host 半输出；client 半错误只能通过 `--enable-logging` 的 chrome 日志或浏览器控制通道（kimi-webbridge evaluate / screenshot）捕获。
3. `dsh.client.inject` 是 client 半的**包级依赖声明**（boot 图信息性元数据，权威边在 `dsh.client` 声明，经 entry creation 到达 fiber）；空数组=无依赖等待，非致命但信息不完整，建议按真实依赖补齐。
