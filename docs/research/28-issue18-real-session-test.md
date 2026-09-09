# 28-issue18-real-session-test.md — Issue #18 根因复盘与真实会话端到端测试方案

> 创建：2026-09-09 | 关联 Issue：#18（告警升根广播命中无关会话） | 验证环境：DSH Live Session (master)

## 1. 背景与 Bug 复盘

在 2026-09-08，M-PCA 会话中执行了纯 CPU 多进程校准脚本，触发了 `io-bottleneck` 告警，但该告警却跨会话投递到了完全无关的 Words-Production 会话。

### 根因分析
1. **配置项未消费**：`settings.yaml` 中的 `alertTargets: string[]` 在 `notifyAlerts()` 路由分发逻辑中完全未被读取消费，配置悬空。
2. **生命周期与时序漏洞**：发起会话在后台启动任务后，当前 turn 结束，该会话的 live agent 随之 detach。当告警触发时，`agentsSvc.get(run.agentId)` 返回 `undefined`，代码无条件回退到 `else` 分支：`for (const r of rootsList()) addTarget(...)`，将当前存活的所有根会话（如 Words-Production）加入告警目标。
3. **无视 broadcast 配置**：未检查 `broadcast: false`，无条件全量广播。
4. **io-bottleneck 误报**：未校验实验是否使用 GPU，纯 CPU 满载被误判为 GPU 数据管线瓶颈。
5. **裸解释器指纹误绑**：`cmdFingerprint` 截断得到裸解释器路径（如 `.venv/bin/python`），在 `findAliveProc` 中通过子串 `indexOf` 模糊匹配误绑了系统常驻服务 Vision-MCP（PID 3350）。

---

## 2. 真实会话端到端测试方案（SOP）

本测试方案用于在**真实运行的 DSH 会话**中进行端到端验证，可随时复用。

### 前置条件
1. 编译最新代码产物：`pnpm build`；
2. **重启 DSH 应用**（安全红线：由用户在终端手动重启），使宿主加载最新的 `lib/`；
3. 检查 HTTP 数据面是否就绪：
   ```bash
   curl -s http://127.0.0.1:3080/lab-monitor/api/snapshot | jq .platform
   ```

---

### 测试场景 1：标准实验识别与本会话精准绑定
- **目的**：验证真实实验命令被识别，且 `agentId` 准确记录为当前发起会话，不外溢。
- **执行命令**：
  ```bash
  python3 -c "import torch; import torch.nn as nn; m=nn.Linear(2,2); loss=torch.tensor(1.0); loss.backward(); print('training ok')"
  ```
- **验证断言**：
  1. 命令正常执行；
  2. 等待 ~8s 后调 `lab_status`，最新一条 `ended` 记录满足：
     - `state === 'done'`
     - `type === 'gpu-train'`
     - `agentId` 为当前会话的 sessionId（如 `session-xxx`）；
  3. 查看 `/tmp/dsh-web.log`，日志显示 `lab/experiment-start` 与 `lab/experiment-end` 均携带该 `agentId`。

---

### 测试场景 2：纯 CPU 密集作业防误报 io-bottleneck 核验
- **目的**：复现 M-PCA 场景，验证纯 CPU 求解器（GPU 利用率为 0%）不再触发数据管线告警。
- **执行命令**：
  ```bash
  python3 -c "
  import multiprocessing, time
  def work():
      end = time.time() + 10
      while time.time() < end: pass
  ps = [multiprocessing.Process(target=work) for _ in range(4)]
  for p in ps: p.start()
  for p in ps: p.join()
  print('cpu work done')
  "
  ```
- **验证断言**：
  1. 任务持续 10s CPU 高占用运行完毕；
  2. 调用 `lab_advice`：返回 `{"ok":true,"advice":[]}`；
  3. 调 `lab_status`：`alerts: []`，无任何 `io-bottleneck` 告警。

---

### 测试场景 3：裸解释器命令与系统常驻服务防误绑
- **目的**：验证类似 `python -m pip list` 不会将 Vision-MCP 等后台常驻服务作为实验进程绑定。
- **执行命令**：
  ```bash
  python3 --version && python3 -m pip list | grep -i 'torch' || true
  ```
- **验证断言**：
  1. 调用 `lab_status`：`experiment: null`；
  2. 检查系统常驻进程（如 Vision-MCP），其 PID 未被绑定，不产生常驻幽灵 run。

---

### 测试场景 4：后台任务离线退出与跨会话防广播核验
- **目的**：验证发起会话当前 turn 结束后，后台任务即使发生 crash，在 `broadcast: false` 时严格禁止向其他会话广播。
- **执行命令**：
  1. 注册临时跟踪：`lab_ctl track track={op:"add", label:"测试路由", patterns:["test_bg_run\.py"]}`
  2. 后台启动任务并保存 pid：`nohup python3 -c 'import time; [time.sleep(1) for _ in range(60)]' >/tmp/bg.log 2>&1 & echo $! > /tmp/bg_pid.txt`
  3. 触发跟踪：`python3 test_bg_run.py --launch`
  4. 终止后台进程：`kill -9 $(cat /tmp/bg_pid.txt)`
- **验证断言**：
  1. 等待 ~12s 状态机判定 crashed；
  2. 查看 `/tmp/dsh-web.log`：
     输出：`[lab-monitor] 发起会话 xxx 不在线且 broadcast=false，跳过向无关根会话广播`；
  3. 系统内其他存活根会话（如 Words-Production）未收到任何通知，会话未被唤醒。

---

### 测试场景 5：配置 alertTargets 靶向投递与热更新
- **目的**：验证用户在 `settings.yaml` 配置了指定的 sessionId 时，仅靶向投递给该目标。
- **验证方法**：
  1. 修改 `~/.dsh/settings.yaml` 中 `alertTargets: ["session-target-id"]`；
  2. 观察 HTTP snapshot 输出中 `alertTargets` 已热更新生效；
  3. 产生告警时，检查日志确认仅投递给指定会话，未广播全局 roots。
