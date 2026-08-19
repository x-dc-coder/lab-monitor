# 13 better-sidebar Tab 不显示诊断（2026-08-20）

> 状态：**代码级诊断完成**（队长接管收尾，2026-08-20）。输入：src/client.ts、dsh-better-sidebar lib/client.js（0.13.0）、DSH boot manifest、dsh-client-modules/client-modules 源码。
> 结论：**适配器代码正确、registerTab 契约匹配；运行时行为需浏览器端验证**（Agent 无法直接观察浏览器 console/DOM）。

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
