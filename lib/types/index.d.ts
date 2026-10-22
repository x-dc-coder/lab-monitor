/**
 * Lab Monitor Host 半（V2 正式插件入口）
 * 职责：collector / ring-buffer / state-machine / balancer / hooks / tools /
 *       prompt 注入 / settings 探测 + webServer HTTP 数据面（替代动态版 harness.handle RPC）
 * 契约：lab-protocol/1.1（docs/03-protocol.md）
 *
 * 与动态版（v1.4.5）的差异：
 *   1. harness.handle('labMonitor.*') RPC → webServer HTTP 路由 /lab-monitor/api/*
 *      （better-sidebar 同款模式；client 半 fetch 消费）
 *   2. harness.defineTool/registerTool → 官方 ctx.tools.register(defineTool(...))
 *   3. settings 持久化可用（schemastery + settings.register，P2 2' 解锁）
 *   4. inject 正式声明：shell/timer 硬依赖；tools/webServer/systemPrompt 可选消费
 */
import type { Context } from '@deepseek-ai/cordis';
import { type BackendMode } from './sampler/index.js';
import { type ExpTypeRule } from './core/exp-type.js';
import type { TagRule, TrackRule } from './core/types.js';
import type { ExpType, SwanLabConfig } from './core/types.js';
export { matchSyncConditions, sanitizeCmd, syncAllEligibleRuns, syncRunToSwanLab } from './sync/swanlab.js';
/** host 半插件配置（schemastery schema 由外部声明；此处仅运行时默认） */
export interface LabMonitorConfig {
    /** 是否注入 labstatus 到 system prompt（默认关——KV 缓存友好；用 lab_status 工具按需查询） */
    promptInjection: boolean;
    /** #14 监控目标模式：auto=按平台（WSL→windows）/ windows / linux（强制切换） */
    backendMode: BackendMode;
    /** 采样周期 ms */
    sampleMs: number;
    /** UI 轮询周期 ms */
    pollMs: number;
    /**
     * 自定义监控进程关键词（2026-08-20 新增）：命中（命令名/命令行 contains）的进程在
     * 监控面板高亮 + 置顶展示，并纳入聚合统计。例：["llama-server", "vllm"]。
     * 来源：配置文件（settings.yaml 的 lab-monitor 段）静态基线 + lab_ctl watch 运行时动态合并。
     */
    watchProcs: string[];
    /**
     * 进程标签规则（2026-08-20 新增，A2 标签分组）：手动给进程打标签分组展示。
     * 匹配 cmdline 全串正则（脚本形态天然覆盖——解释器进程 cmdline 含脚本路径）。
     * 来源：settings.yaml（lab-monitor 段）静态基线 + lab_ctl tag 运行时动态合并。
     */
    tags: TagRule[];
    /**
     * #17 增强（2026-08-27）：显式跟踪规则（lab_ctl track）——命中 cmdline 的命令无条件记为实验并监控，
     * 不受 TRAIN_PATTERNS 保守识别限制（如 python infer.py / vllm serve 等非训练形态），且跳过幽灵 run 豁免
     * （crash 严格判定）。来源：settings.yaml 静态基线 + lab_ctl track 运行时动态合并。
     */
    trackRules: TrackRule[];
    /**
     * 告警通知通道 fallback（off|notice|wake）：仅无实验上下文/unknown 类型时作为兜底档位；
     * 实际档位由策略引擎按「有效级别 × 实验状态 × 归属」计算（M1 实现 unknown/无实验上下文部分）。
     * 默认 notice（不主动唤醒，KV 缓存友好）。
     */
    alertNotify: 'off' | 'notice' | 'wake';
    /**
     * 显式通知目标 agent 列表（空 = 自动选择：M1 阶段 = roots() 主代理）。
     * M3 起支持按 runId → 发起 agent 路由（exec.agent）。
     */
    alertTargets: string[];
    /** 聚合窗口 ms：同目标在窗口内最多 1 条通知（最紧急的胜出）；默认 60s */
    notifyThrottleMs: number;
    /** warn 持续该时长（秒）→ 通知升 critical（不改 level 本身）；null/0 = 关闭升级。默认 600s=10min */
    escalateAfterSec: number;
    /** B1 证据1：wake 档投递后未领取（无 agent/inbox/claimed）的兜底等待 ms；默认 600000ms=10min；可注入（环境变量 LAB_MONITOR_NOTIFY_TIMEOUT_MS） */
    notifyTimeoutMs: number;
    /** 是否广播 critical 实验级告警到全部 agent（默认关；M1 阶段仅对 roots() 生效） */
    broadcast: boolean;
    /**
     * 实验类型配置规则（pattern→type→notify 覆盖；复用 TagRule 形态）：
     * 优先级最高的识别层（用户意图 > 自动正则 > 学习历史）。notify 覆盖出厂类型矩阵（EXP_TYPE_DEFAULT_NOTIFY）。
     */
    experimentTypes: ExpTypeRule[];
    /** 兜底类型（未命中任何层时的保守默认；默认 unknown 不猜） */
    expTypeDefault: ExpType;
    /** 是否启用学习层（按 fingerprint 历史时长归类 long；默认 true） */
    expTypeLearning: boolean;
    /**
     * 子代理对 lab_ctl 的控制权限：readonly（默认，只读查询）/ restricted（白名单动作）/ full（等同主代理）。
     * 安全边界：子代理默认只读——guard 执行期拒绝 lab_ctl，仅 lab_status/lab_advice 可调。
     */
    subagentPolicy: 'readonly' | 'restricted' | 'full';
    /** 远端设备列表配置（默认预设 gpu220） */
    devices: DeviceConfig[];
    /** 当前监控目标设备（'local' 或远程设备 id 如 'gpu220'） */
    currentDevice: string;
    /** SwanLab 按需同步配置 */
    swanlab?: SwanLabConfig;
}
export interface DeviceConfig {
    id: string;
    label?: string;
    host: string;
    port?: number;
    user: string;
    keyPath?: string;
    pollMs?: number;
}
export declare const DEFAULT_DEVICES: DeviceConfig[];
export type NotifyAction = 'off' | 'inject' | 'steer' | 'followup' | 'send-nq' | 'escalate-root';
export declare function resolveAction(level: 'off' | 'notice' | 'wake', targetState: 'running' | 'idle' | 'absent'): NotifyAction;
export declare const name = "lab-monitor";
/** 依赖声明：shell/timer/webServer/tools 硬依赖（与官方 better-sidebar 一致，inject 后属性直访）；settings/systemPrompt 可选 */
export declare const inject: string[];
export declare function apply(ctx: Context, config?: Partial<LabMonitorConfig>): void;
