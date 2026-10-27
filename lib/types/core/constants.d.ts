/**
 * 核心常量（指标/训练关键词/采样参数）—— 迁移自 host/index.js §1
 */
import type { ExpType, NotifyLevel, RunRecord } from './types.js';
/** 采集周期（核心层固定 2s；UI 轮询见 pollMs） */
export declare const SAMPLE_MS = 2000;
/** 进程表（ps）周期——状态机 pid 关联/crashed 判定对齐 */
export declare const PS_INTERVAL_MS = 5000;
/** 环形缓冲双条件封顶（docs/02 §2.2） */
export declare const RING_MAX_POINTS = 1000;
export declare const RING_MAX_MS: number;
/** R-3：实验 running 期扩容至 2h */
export declare const RING_EXPAND_POINTS = 2000;
export declare const RING_EXPAND_MS: number;
/** 告警列表封顶 */
export declare const ALERT_MAX = 20;
/** pid 连续消失 ≥2 个 ps 周期（10~15s）→ crashed */
export declare const CRASH_PS_GAP = 2;
/** #17（2026-08-27，issue#17）：幽灵 run 豁免阈值——疑似工具代码体误判的 run（从未关联进程 + 短时长 + 无资源活动）归档 aborted 不告警 */
export declare const GHOST_RUN_ABORT_SEC = 30;
/** 幽灵 run GPU util 峰值阈值 %（真实训练即使启动即崩 GPU util 也会瞬时冲高；<10% 视为无活动证据） */
export declare const GHOST_GPU_UTIL_MAX = 10;
/** 幽灵 run 组 CPU 峰值阈值 % */
export declare const GHOST_CPU_PCT_MAX = 5;
/** 配对 result 后进程仍活的宽限 ps 周期 → done */
export declare const DONE_GRACE_TICKS = 2;
/** 2026-08-20（A2 多轨）：并行实验跟踪上限（超出时归档最旧 running 为 aborted） */
export declare const MAX_PARALLEL_RUNS = 4;
/** 2026-08-22（P2 实验历史）：已结束实验历史上限（ended[] 投影与 settings 持久化共用） */
export declare const MAX_HISTORY = 20;
export declare const THRESHOLD_DEFAULTS: {
    utilWarn: number;
    memWarn: number;
    tempWarn: number;
    pollMs: number;
    procTopN: number;
    wGpu: number;
    wCpu: number;
    wMem: number;
};
/** #13-3 差异化阈值：全局阈值的分层覆盖（全局 → 实验类型 → 标签组）
 *  byExpType: { gpu-train: { utilWarn: 60, memWarn: 90 }, ... }
 *  byTag:     { "推理服务": { memWarn: 95 }, ... }（按主实验进程组命中的标签组） */
export interface ThresholdOverrides {
    byExpType?: Record<string, Partial<Thresholds>>;
    byTag?: Record<string, Partial<Thresholds>>;
}
export type Thresholds = typeof THRESHOLD_DEFAULTS;
export declare const THRESH_KEYS: readonly ["utilWarn", "memWarn", "tempWarn", "pollMs", "procTopN", "wGpu", "wCpu", "wMem"];
/**
 * 训练命令识别表（T4-1 + 2026-08-23 精度修复）
 * 误报实证（T2 §2.4，~/.dsh/settings.yaml history）：grep 模式串含 "torchrun" 被命中、
 * gh issue heredoc 含 torchrun 字样命中、python3 -c "import zipfile" 工具脚本全被记为实验。
 * 修复原则（docs/研读复盘/2026-08-24-告警分级输入.md §2.4 + 22-issue5 §3.3）：
 *   - torchrun/deepspeed 不再裸词匹配：要求后跟 脚本文件 或 训练器句式（-m torch.distributed 等）
 *   - python -c/-m 增加排除特征：常见工具/检查形态（import zipfile/docx 检查、打印环境等）不命中
 *   - 未命中 = null（不猜），防误报优先
 */
export declare const TRAIN_PATTERNS: {
    name: string;
    re: RegExp;
}[];
export declare function matchTrainFeature(cmdStr: string | null | undefined): string | null;
/**
 * M2（issue#6，docs/架构设计/告警通知设计.md §3.3）：实验类型自动层识别正则（保守，未命中不猜）。
 * 判定顺序（classifyExpType）：smoke/regression/full 明确形态 → gpu-train（matchTrainFeature 门控）
 * → gpu-calc（推理/渲染/仿真，非 train）→ long（serve/batch 类长驻）。gpu-train 不在本表，
 * 由 TRAIN_PATTERNS（2026-08-23 精度修复，11/11 验证）门控，避免与 calc 关键字冲突。
 */
export declare const EXP_TYPE_PATTERNS: {
    type: ExpType;
    re: RegExp;
}[];
/**
 * M2（issue#6，docs/架构设计/告警通知设计.md §3.4）：类型 × notifyLevel 出厂默认矩阵。
 * 语义：类型矩阵 = 配置（experimentTypes 可覆盖），本表只是出厂建议值，不硬编码代码分支。
 * unknown 走全局 fallback（critical→notice 起点，不给类型特权）。
 */
export declare const EXP_TYPE_DEFAULT_NOTIFY: Record<ExpType, {
    critical: NotifyLevel;
    warn: NotifyLevel;
}>;
/** M2：学习层长任务归类阈值——同 fingerprint 历史时长 p90 ≥ 3600s → long（docs/架构设计/告警通知设计.md §3.2 S5） */
export declare const LONG_LEARN_SEC = 3600;
/**
 * 命令指纹：ps 关联 / result 配对用的特征串（T1-1/T1-2）
 * v1.4.5（e2e 实证）：python -c 内联形态用「pyc: + 归一化命令从 -c 起的完整后缀前 28 字符」，
 * ps 行 indexOf 可匹配（findAliveProc 同归一化）；不可用 m[1]（分号处截断）。
 * 2026-08-20（A2 多轨修复）：28 → 48 字符——v1 单跟踪时指纹只匹配自身（长度无碍），
 * 多轨下两个相似命令（如 sleep(30) vs sleep(35)）在 28 字符处差异恰好被截掉 → 指纹相同
 * → 都关联到第一个进程（pid/procGroup 重叠，实证 run-001/run-002 共享进程组）。
 * 48 字符保留更多区分信息，且 ps cmdline 一般长于此，indexOf 匹配不受影响。
 */
export declare function cmdFingerprint(cmdStr: string | null | undefined): string;
/** ps 行归一化：与 cmdFingerprint 的归一化对齐（引号剥离、空白折叠） */
export declare function normalizeCmdForMatch(s: string | null | undefined): string;
/**
 * runId（settings 持久化主键 / 告警 runId 关联 / history 去重）
 * 2026-08-24（实测修复）：原实现仅日期+计数器，重启后计数器归零 → 同日重启多次会与
 * settings 恢复的旧记录 runId 重复（实测 run-20260824-001 出现两条：恢复的历史 + 新 run）。
 * 仿 makeTagId 修复：日期 + HHMMSS + 计数器（同一秒内最多 999 条，重启后同秒并发概率可忽略）。
 */
export declare function makeRunId(): string;
/**
 * 标签规则 id（与 runId 区分前缀；settings 持久化主键）
 * 2026-08-20（持久化修复）：id 必须跨重启唯一——之前仅日期+计数器，重启后计数器归零
 * → 新规则与磁盘已有规则 id 重复（实测 tag-20260820-001 重复两条，remove 会删错）。
 * 改为日期 + HHMMSS + 计数器（同一秒内最多 999 条，足够；重启后同秒并发概率可忽略）。
 */
export declare function makeTagId(): string;
/**
 * #17（2026-08-27，issue#17）：幽灵 run 豁免判定。
 * 背景：pre-execute 曾对 run_code 代码体做 TRAIN_PATTERNS 匹配，代码/文档/注释中的示例命令
 * （如 `python scripts/train.py --config ...`）被误记为实验；该类 run 无真实进程、无资源活动，
 * 进程消失判定会误报 experiment-crash（critical/wake 噪音，实证 run-20260827-185517-001，
 * gpuUtilMax 4%、durationSec 11、无进程）。此判定为 crash 门控的第二道防线（源头修复见
 * src/index.ts pre-execute——仅 bash 参与识别）。
 * 条件（全部满足才算幽灵 run，保守防误伤真实实验）：
 *   - 从未关联到任何进程（pid 空 且 procGroup 空/无成员）
 *   - 运行时长 < GHOST_RUN_ABORT_SEC（30s）
 *   - 无显著资源活动证据：GPU util 峰值 < 10% 且组 CPU 峰值 < 5%（采样缺失视为无活动证据）
 */
export declare function isGhostRun(run: Pick<RunRecord, 'pid' | 'procGroup' | 'startTs' | 'sampleStats'>, now?: number): boolean;
