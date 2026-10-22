/**
 * ring-buffer（双条件封顶 + 查询降采样）—— 迁移自 host/index.js §3
 */
import { RING_EXPAND_MS, RING_EXPAND_POINTS } from './constants.js';
export function createRing(maxPoints, maxMs) {
    const points = [];
    let capPoints = maxPoints;
    let capMs = maxMs;
    return {
        push(s) {
            points.push(s);
            while (points.length > capPoints ||
                (points.length > 1 && points[points.length - 1].ts - points[0].ts > capMs)) {
                points.shift();
            }
        },
        expand() {
            capPoints = RING_EXPAND_POINTS;
            capMs = RING_EXPAND_MS;
        },
        size() {
            return points.length;
        },
        history(sinceMs, bucketMs) {
            const bm = bucketMs || 10000;
            const buckets = [];
            let cur = null;
            for (let i = 0; i < points.length; i++) {
                const p = points[i];
                if (p.ts < sinceMs)
                    continue;
                const bk = Math.floor(p.ts / bm) * bm;
                if (!cur || cur.bucket !== bk) {
                    cur = { bucket: bk, ts: bk, gpuUtilSum: 0, gpuUtilN: 0, gpuMemSum: 0, gpuMemN: 0, cpuSum: 0, cpuN: 0, memUsedSum: 0, memUsedN: 0, groupCpuSum: 0, groupCpuN: 0, groupMemSum: 0, groupMemN: 0 };
                    buckets.push(cur);
                }
                const g = p.gpu && p.gpu.length ? p.gpu[0] : null;
                if (g && typeof g.utilPct === 'number') {
                    cur.gpuUtilSum += g.utilPct;
                    cur.gpuUtilN += 1;
                }
                if (g && typeof g.memUsedMiB === 'number') {
                    cur.gpuMemSum += g.memUsedMiB;
                    cur.gpuMemN += 1;
                }
                if (p.cpuPct !== null && typeof p.cpuPct === 'number') {
                    cur.cpuSum += p.cpuPct;
                    cur.cpuN += 1;
                }
                if (typeof p.memUsedMiB === 'number') {
                    cur.memUsedSum += p.memUsedMiB;
                    cur.memUsedN += 1;
                }
                if (p.group && typeof p.group.cpuPct === 'number') {
                    cur.groupCpuSum += p.group.cpuPct;
                    cur.groupCpuN += 1;
                }
                if (p.group && typeof p.group.memMiB === 'number') {
                    cur.groupMemSum += p.group.memMiB;
                    cur.groupMemN += 1;
                }
            }
            let out = buckets.map((b) => ({
                ts: b.ts,
                gpuUtil: b.gpuUtilN ? Math.round(b.gpuUtilSum / b.gpuUtilN) : null,
                gpuMem: b.gpuMemN ? Math.round(b.gpuMemSum / b.gpuMemN) : null,
                cpu: b.cpuN ? Math.round(b.cpuSum / b.cpuN) : null,
                memUsed: b.memUsedN ? Math.round(b.memUsedSum / b.memUsedN) : null,
                groupCpu: b.groupCpuN ? Math.round(b.groupCpuSum / b.groupCpuN) : null,
                groupMem: b.groupMemN ? Math.round(b.groupMemSum / b.groupMemN) : null,
            }));
            if (out.length > 500)
                out = out.slice(out.length - 500); // ≤500 点渲染（P2 验收 3）
            return { points: out, truncated: out.length >= 500 };
        },
    };
}
