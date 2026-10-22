type CtxLike = {
    get(name: string): unknown;
    effect(fn: () => unknown, label?: string): void;
    setTimeout(fn: () => void, ms: number): () => void;
    setInterval(fn: () => void, ms: number): () => void;
};
export declare const name = "lab-monitor";
/** 依赖声明：只 timer（平台内置恒存在）；better-sidebar 绝不进 inject（t2b 结论①） */
export declare const inject: string[];
export declare function apply(ctx: CtxLike): void;
export {};
