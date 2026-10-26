/**
 * Sink SPI（两类，非单一 webhook）：experiment-record（实验结束同步）/ metrics-forward（周期指标转发）
 * 隔离契约：sink 回调抛错由 registry 捕获 → 记 health.lastError/consecutiveFailures，
 * 绝不向上传播，绝不阻塞采样 tick 与其他 sink。
 */
export {};
