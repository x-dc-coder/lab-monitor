/**
 * SamplerBackend 契约（V2 TS 化）
 * 一个平台采样后端的统一契约：后端 = "一个平台的全部采样通道的组合"。
 * 上层（ring/state/balancer/rpc/tools/UI）不感知平台差异，只消费规范化快照。
 * 方法集（netdata 五方法映射）：
 *   probe()    Promise<{ok, reason?, detail?}>  —— 环境探测（= Check），绝不抛错
 *   snapshot() Promise<快照>                    —— 一次性全量采样（= Collect）
 *   stream()   AsyncIterable<{ts, raw}> | null  —— 长驻增量流（GPU dmon 行流）
 *   close()    Promise<void>                    —— 释放资源（杀 interop 子进程，幂等）
 */
export {};
