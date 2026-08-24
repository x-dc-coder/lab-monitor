# lab-monitor → monitor.dc-sy.cn 监控面板对接方案（#11 落地）

> 状态：待批准 ｜ 日期：2026-08-24 ｜ 关联：ad1acb8（SSE 事件流端点）
> 决策输入：用户确认——① 实验/GPU 状态上报到面板（含资源趋势与实验状态视图）；
> ② 数据流方向 = 本机 → cloud（ingest 上报）；③ 先出详细方案再执行。

---

## 1. 背景与目标

lab-monitor（本机 WSL 内 DSH 插件）最新提交 `ad1acb8` 新增 SSE 事件流端点
`GET /lab-monitor/events`，标志其从"进程内监控"升级为"可对外订阅的实时事件源"。
本方案将该事件/状态出口对接至生产监控面板 **monitor.dc-sy.cn**（cloud
124.221.190.237 上的 monitor-panel），实现：

- 面板新增 **lab-monitor 状态视图**：GPU 利用率/显存/温度趋势、活跃实验
  （cmd/类型/时长）、实验计数、告警摘要；
- 数据单向、安全（Bearer token）、无新公网端口暴露。

## 2. 现状盘点（已全部实测）

| 项 | 结论 |
|---|---|
| 本机 SSE 端点 | `GET http://127.0.0.1:3080/lab-monitor/events` 可连（长连接保活正常），**localhost only**，无鉴权（known-issues #6） |
| 本机 JSON 数据面 | `GET http://127.0.0.1:3080/lab-monitor/api/snapshot` → 200（含 gpu/procs/experiments/alerts/thresholds/enabled） |
| 线上 ingest 通道 | **未启用**：无 token POST `/api/ingest` → 404（`INGEST_ENABLED=0`）；nginx 已豁免 Basic Auth、`limit_except POST`（GET→403 已证） |
| ingest 契约 | `POST https://monitor.dc-sy.cn/api/ingest`，`Authorization: Bearer <token>`；body `{results:[{node_id, group, metrics:[{name,value,ts}], payload?}]}`；group/metric 必须过 `GROUP_METRICS` 白名单，否则整批拒绝 |
| 面板聚合 | `Aggregator.ingest()` 按 group 分发 `_on_<group>()`，payload 写入 `latest[group]`，`overview()` 读快照拼装 `/api/overview` |
| 面板前端 | `web/src/views/overview.ts`：6 KPI + grid2 窗口（devices/tunnels/certs…），`S.overview` 驱动 |
| 本机运行环境 | WSL，**systemd 不可用**（PID1=init）；Node v24.16.0（**无内置 EventSource**）；openssl 可用 |

## 3. 架构与数据流

```
本机 (WSL)                                        cloud (monitor.dc-sy.cn)
┌─────────────────────────────┐    HTTPS POST     ┌──────────────────────────────┐
│ lab-monitor (DSH :3080)     │   Bearer token    │ nginx :443 → :8898           │
│  ├ snapshot (JSON, 轮询源)  │───────────────▶   │  /api/ingest (FastAPI)       │
│  └ events (SSE, 未来实时)   │   30s 周期        │  → Aggregator.ingest()       │
│            ▲               │                   │  → latest["lab_monitor"]     │
│            │ 本地 127.0.0.1 │                   │  → overview() → /api/overview│
│  forwarder (node 常驻)  │                   │  → 前端 overview.ts 新视图   │
│  轮询 snapshot → 映射指标    │                   │  → samples 表（趋势）        │
└─────────────────────────────┘                   └──────────────────────────────┘
```

- **上报周期**：30s（与面板自采/前端轮询节奏一致；训练秒级波动由本机自身秒级采样兜底，
  面板只做远端呈现，research/02 正交边界已明确）。
- **node_id**：`dc-desktop`（本机标识，monitor-panel 的 MonitorNode 抽象天然支持多节点）。
- **group**：新增 `lab_monitor`（见 §4）。

## 4. cloud 侧改动清单（monitor-panel 仓库 + 生产部署）

### 4.1 `app/constants.py` — 新增 group 与指标白名单

```python
GROUP_LAB = "lab_monitor"   # 本机实验监控（lab-monitor 上报，issue #11）

# METRIC_GROUPS 追加 GROUP_LAB
GROUP_METRICS[GROUP_LAB] = (
    "gpu_util_percent",   # GPU 利用率 %
    "vram_used_mib",      # 显存已用 MiB
    "vram_total_mib",     # 显存总量 MiB
    "vram_util_percent",  # 显存占用 %
    "gpu_temp_c",         # 温度 °C
    "experiment_active",  # 当前活跃实验数
    "experiments_total",  # 累计归档实验数
    "alerts_crit",        # 未解决 critical 告警数
    "alerts_warn",        # 未解决 warn 告警数
    "monitor_enabled",    # 引擎开关 1/0
)
```

### 4.2 `app/services/aggregator.py` — 新增 `_on_lab`

- `_on_lab(result, ts)`：将 `result.payload`（agent 上送的 lab 快照）写入 `self.latest[GROUP_LAB]`
  （默认 ingest 已写 `latest`，若无需告警联动可零实现——仅依赖通用路径即可，`_on_` 可不定义）。
- `overview()` 增加 `"lab"` 段：

```python
lab_p = self.latest.get(constants.GROUP_LAB, {})
# ...
"lab": {
    "gpu_util_percent": lab_p.get("gpu_util_percent"),
    "vram_used_mib":    lab_p.get("vram_used_mib"),
    "vram_total_mib":   lab_p.get("vram_total_mib"),
    "vram_util_percent": lab_p.get("vram_util_percent"),
    "gpu_temp_c":       lab_p.get("gpu_temp_c"),
    "experiment_active": lab_p.get("experiment_active"),
    "experiments_total": lab_p.get("experiments_total"),
    "alerts_crit":      lab_p.get("alerts_crit"),
    "alerts_warn":      lab_p.get("alerts_warn"),
    "monitor_enabled":  lab_p.get("monitor_enabled"),
    "experiment":       lab_p.get("experiment"),   # 当前活跃实验 {cmd,type,startTs} 或 null
},
```

### 4.3 前端 `web/src/views/overview.ts` — 新增 lab 视图

- 6 KPI 后追加 **KPI 07「LAB GPU」**：显存占用 `vram_used/vram_total` + GPU util + 温度；
  仅当 `o.lab` 存在时渲染（远端未上报则显示 `—`，不干扰既有面板）。
- grid2 窗口追加 **「实验 · lab-monitor」** 表：活跃实验（cmd/类型/时长）、
  `experiment_active`/`experiments_total`、告警摘要（crit/warn 徽标）。
- `web/src/types.ts` 同步 `OverviewData` 增加 `lab` 字段；`web/src/state.ts` 无需改
  （overview 为整体快照）。

### 4.4 生产 env — 启用 ingest + 生成 token（受控写，备份先行）

- 备份 `/opt/monitor-panel/env` → `env.bak-<ts>`；
- 追加（或取消注释）：

```ini
MONITOR_INGEST_ENABLED=1
MONITOR_INGEST_TOKEN=<openssl rand -hex 32>
```

- `systemctl restart monitor-panel`；验证无 token→401、错 token→401、对 token→200。

### 4.5 部署

- 走 `monitor-panel/scripts/deploy.sh`（原子部署：备份→rsync→软链→restart→健康检查
  `"ok":true` + `"mode":"live"` →失败自动回滚），**不用 mcp deploy**（无 deploy.yml）。
- 部署顺序：代码改动（constants/aggregator/前端）→ deploy.sh → env 启用 ingest →
  重启 → 验证。

## 5. 本机侧改动清单（lab-monitor 仓库，新增转发器）

### 5.1 `scripts/forward-monitor.mjs`（新建，node ≥18，零依赖）

职责（每 30s 一轮，单轮内完成拉取+上报，失败静默重试下一轮）：

1. `fetch('http://127.0.0.1:3080/lab-monitor/api/snapshot')` 拉 JSON；
2. 提取指标 → `metrics[]`（白名单名，见 §4.1；`experiment_active` 取活跃实验数组长度，
   `experiments_total` 取 `ended.length`，`monitor_enabled` 取 `enabled`）；
3. 当前活跃实验（若有）写入 `payload.experiment = {cmd, type, startTs}`；
4. `fetch('https://monitor.dc-sy.cn/api/ingest', {method:'POST', headers:{Authorization:
   'Bearer '+TOKEN, 'Content-Type':'application/json'}, body: JSON.stringify({results:[{
   node_id:'dc-desktop', group:'lab_monitor', metrics, payload}]})})`；
5. 每轮落一行 debug 日志（`forward-monitor.log`，带 ts/接受数/错误）。

配置：`~/.config/lab-monitor-forward.env`（`MONITOR_INGEST_TOKEN=...`，chmod 600），
脚本启动时读取；**token 不入库、不进 git**。

### 5.2 常驻方式（WSL 无 systemd）

- 首选：`nohup node scripts/forward-monitor.mjs >> forward-monitor.log 2>&1 &`，
  pid 写入 `forward-monitor.pid`；提供 `scripts/forward-monitor.sh {start|stop|status}` 封装；
- 开机自启：`.bashrc`/`.profile` 追加 start 检查（幂等：pid 存活则跳过），
  或 Windows 任务计划（二期，非必须）。
- **运行身份**：本机为开发环境（local 主机，账号 dc 单用户），**不适用"一服务一用户"规则**
  （该规则仅针对 cloud 等远程服务器——服务账号 `<服务>-<主机名>`，2026-08-24 确认）。
  转发器以 dc 运行合规，token 存 dc 家目录 600 即可。

### 5.3 不引入 SSE 的原因（本期）

- Node 24 无内置 EventSource；SSE 面向实时事件（实验 start/end 瞬间），
  而面板是 30s 级轮询呈现——轮询 snapshot 已覆盖全部指标，误差 ≤30s；
- SSE 实时通道（实验开始/结束即时翻牌、告警即时上屏）列为二期增强
  （可用 `curl -N` 子进程解析或补 EventSource 依赖后启用）。

## 6. 安全设计

| 面 | 措施 |
|---|---|
| 传输 | HTTPS（monitor.dc-sy.cn 443）；token 走 `Authorization: Bearer`（hmac 常量时间比对，ingest.py 已有） |
| token 管理 | cloud env（600 monitor）+ 本机 `~/.config/...env`（600）；可独立轮换（改 env + 改本机配置，立即失效） |
| 暴露面 | 无新公网端口；SSE 保持 localhost only 不开放；ingest 404 态与 401 态不变 |
| 数据 | 仅上行本机 GPU/实验概要指标，不含命令原文敏感参数（cmd 仅截断显示用） |
| 面板侧 | 新 group 指标名白名单收敛，杜绝脏指标 |

## 7. 实施步骤（批准后执行顺序）

1. **cloud 代码改动**：constants.py / aggregator.py / 前端 overview.ts + types.ts（本地改好，typecheck/esbuild 通过）；
2. **部署**：deploy.sh 部署到 cloud（自带备份回滚）；验证 `/api/overview` 含 `lab` 段、前端新视图渲染（未上报时显示 `—`）；
3. **env 启用 ingest**：备份 env → 加 `INGEST_ENABLED=1` + token → restart → 三态验证（无/错 token 401、对 token 200）；
4. **本机转发器**：写 `forward-monitor.mjs` + 配置 + 启动脚本 → `start` → 观察日志；
5. **端到端验证**：cloud `curl` 用 转发器同款 body 手动 POST → overview 出现 lab 数据；等 30s 后前端视图出现 GPU/实验卡片；
6. **收尾**：`status_update` 更新 cloud 状态记忆；文档归位。

## 8. 验证清单

- [ ] cloud：无 token POST → 401；错 token POST → 401；对 token POST 空结果集 → 200 `{accepted:0}`
- [ ] cloud：对 token POST 合法 `lab_monitor` body → 200 `{accepted:1}`；白名单外指标 → 拒绝
- [ ] cloud：`/api/overview` 含 `lab` 段且字段齐全
- [ ] 前端：overview 页出现 LAB GPU KPI + 实验窗口；本机未上报时显示 `—` 不报错
- [ ] 本机：转发器日志每 30s 有成功上报记录；kill 转发器 → 面板 `lab` 段 90s 内不刷新（预期行为）
- [ ] 端到端：本机跑一次 `python3 -c "import torch..."` 验证实验（gpu-train）→ 面板实验窗口显示活跃实验

## 9. 回滚方案

| 阶段 | 回滚动作 |
|---|---|
| 代码/部署后 | `deploy.sh` 回滚到上一 release（自动/手动均可，保留旧 release 5 个） |
| env 后 | `monitor-deploy-ctl` 还原 `env.bak-<ts>` + restart；或 `INGEST_ENABLED=0`（接口回 404，通道关闭） |
| 本机转发器 | `forward-monitor.sh stop`（kill pid），面板 lab 段自动变 `—` |
| 整体 | 以上三者任一层可独立回滚，互不依赖；无数据破坏风险（ingest 仅追加 samples） |

## 10. 遗留/二期

- SSE 实时事件通道（实验 start/end 即时翻牌、告警即时上屏）——补 EventSource 或 `curl -N`；
- 面板侧 lab 告警联动（实验崩溃 → 面板红灯/webhook）；
- 多节点（pi 实验机）同协议接入（node_id 区分即可）。

---

## 附录：#13 待优化项落地记录（2026-08-24）

| 项 | 状态 | 落地 |
|---|---|---|
| #13-2 GPU 趋势 | ✅ 部署 | lab 视图趋势图（1h/24h，samples 通道）+ 转发器 30s 窗口聚合 avg/max 双值（gpu_util_max） |
| #13-1 SSE 数据模型 | ✅ 部署 | 转发器 payload 加 procs_top（Top10 进程）+ tags（标签组聚合）；面板 Top 进程/标签组窗口 |
| 附加 CPU/内存 | ✅ 部署 | 转发器补推 cpu_percent/mem_percent/used/total；前端 5 gauge 卡 |
| #13-3 差异化阈值 | 🔧 代码完成 | resolveThresholds 覆盖链（全局→byExpType→byTag）；set-threshold 支持 thresholdOverrides；client 设置页 JSON 编辑；**待 DSH 重启 + 阈值数值拍板** |

版本锚点：monitor-panel releases 20260824-181416 / 182702 / 184356；lab-monitor 提交 4d792ac / 76e1b1d（+ 转发器 9722278）
