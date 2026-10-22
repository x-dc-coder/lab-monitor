export class LinuxBackend {
    id = 'linux';
    cacheTtlMs = 1000;
    lastCpuTimes = null;
    runner;
    gpuQueryCache = null;
    pmonCache = null;
    constructor(runner) {
        this.runner = runner;
    }
    cacheGet(entry, ttlMs) {
        if (!entry)
            return undefined;
        if (Date.now() - entry.at > ttlMs)
            return undefined;
        return entry.val;
    }
    /** ① 探测：/proc 可读即可用（绝不抛错；探测 GPU 可用性） */
    async probe() {
        try {
            const r = await this.runner.exec('cat /proc/version 2>/dev/null | head -1');
            if (r.code !== 0)
                return { ok: false, reason: 'cannot read /proc/version: ' + (r.stderr || '') };
            const detail = { kernel: (r.stdout || '').trim().slice(0, 80) };
            try {
                const gr = await this.runner.exec('nvidia-smi --query-gpu=driver_version,count --format=csv,noheader 2>/dev/null');
                if (gr.code === 0 && gr.stdout.trim()) {
                    const parts = gr.stdout.trim().split('\n')[0].split(',');
                    detail.gpu = {
                        available: true,
                        driver: parts[0]?.trim() || null,
                        count: parts.length > 1 ? parseInt(parts[1].trim(), 10) : 1,
                    };
                }
                else {
                    detail.gpu = { available: false };
                }
            }
            catch (e) {
                detail.gpu = { available: false };
            }
            return { ok: true, detail };
        }
        catch (e) {
            return { ok: false, reason: 'probe exception: ' + e.message };
        }
    }
    /** /proc/meminfo → { totalMiB, availableMiB }（kB→MiB，向下取整） */
    async readMeminfo() {
        const r = await this.runner.exec('cat /proc/meminfo 2>/dev/null');
        if (r.code !== 0)
            return null;
        const m = {};
        for (const line of (r.stdout || '').split('\n')) {
            const mm = line.match(/^(\w+):\s+(\d+)\s*kB/);
            if (mm)
                m[mm[1]] = parseInt(mm[2], 10);
        }
        if (!m.MemTotal)
            return null;
        return {
            totalMiB: Math.round(m.MemTotal / 1024),
            availableMiB: m.MemAvailable ? Math.round(m.MemAvailable / 1024) : Math.round((m.MemFree || 0) / 1024),
        };
    }
    /** /proc/stat 首行 → { idle, total, at }（jiffies 差分） */
    async readStat() {
        const r = await this.runner.exec('cat /proc/stat 2>/dev/null | head -1');
        if (r.code !== 0)
            return null;
        const parts = (r.stdout || '').trim().split(/\s+/).slice(1).map(Number);
        if (parts.length < 4)
            return null;
        const idle = parts[3] + (parts[4] || 0);
        const total = parts.reduce((a, b) => a + b, 0);
        return { idle, total, at: Date.now() };
    }
    /** CPU 差分（psutil 算法）：首帧返回 null（丢弃）；负值截 0 */
    cpuPercent(cur) {
        const prev = this.lastCpuTimes;
        this.lastCpuTimes = cur;
        if (!prev)
            return null;
        const dTotal = cur.total - prev.total;
        if (dTotal <= 0)
            return 0;
        const dIdle = cur.idle - prev.idle;
        const pct = (1 - Math.max(dIdle, 0) / dTotal) * 100;
        return Math.round(Math.max(pct, 0) * 10) / 10;
    }
    /**
     * 解析 nvidia-smi CSV noheader 行（7 列，实测）：
     *   "0, NVIDIA GeForce RTX 3090, 7 %, 1867 MiB, 24576 MiB, 43, 20.77 W\r"
     *   → { id, name, utilPct, memUsedMiB, memTotalMiB, tempC, powerW }
     */
    parseSmiLine(line) {
        const f = line.replace(/\r$/, '').split(',').map((s) => s.trim());
        if (f.length < 7)
            return null;
        const num = (s) => {
            const n = parseFloat(String(s).split(' ')[0]);
            return Number.isFinite(n) ? n : 0;
        };
        return {
            id: String(parseInt(f[0], 10)),
            name: f[1],
            utilPct: num(f[2]),
            memUsedMiB: num(f[3]),
            memTotalMiB: num(f[4]),
            tempC: num(f[5]),
            powerW: num(f[6]),
        };
    }
    /**
     * GPU 快照（query，TTL 500ms 缓存）：
     * 7 列通用参数：index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw
     */
    async queryGpu() {
        const cached = this.cacheGet(this.gpuQueryCache, 500);
        if (cached !== undefined)
            return cached;
        try {
            const r = await this.runner.exec('nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader 2>/dev/null');
            if (r.code !== 0) {
                const res = { ok: false, gpus: [], reason: 'nvidia-smi query 失败 code=' + r.code };
                this.gpuQueryCache = { at: Date.now(), val: res };
                return res;
            }
            const gpus = [];
            for (const line of (r.stdout || '').split('\n')) {
                if (!line.trim())
                    continue;
                const g = this.parseSmiLine(line);
                if (g)
                    gpus.push(g);
            }
            const res = { ok: gpus.length > 0, gpus, reason: gpus.length === 0 ? '无可用 GPU 设备' : undefined };
            this.gpuQueryCache = { at: Date.now(), val: res };
            return res;
        }
        catch (e) {
            const res = { ok: false, gpus: [], reason: e.message };
            this.gpuQueryCache = { at: Date.now(), val: res };
            return res;
        }
    }
    /**
     * 每进程 GPU 利用率（pmon，辅助证据——慢通道 TTL 5s）
     * nvidia-smi pmon -c 3 -s u 多帧窗口：跳过 # 行，列 pid/type/sm/...；`-` 视 0；同 pid 取 max。
     * 无 nvidia 驱动/失败 → 空 Map（gpuUtilPct 不填充，整卡通道不受影响）。
     */
    async queryPmon(hasGpu = true) {
        if (!hasGpu)
            return new Map();
        const cached = this.cacheGet(this.pmonCache, 5000);
        if (cached !== undefined)
            return cached;
        const byPid = new Map();
        try {
            // #21 快慢解耦：-c 1 极速采样（~50-80ms，避免 -c 3 的 2.1s 阻塞），TTL 5s 缓存
            const r = await this.runner.exec('nvidia-smi pmon -c 1 -s u 2>/dev/null');
            if (r.code === 0) {
                let colIdx = null;
                for (const line of (r.stdout || '').split('\n')) {
                    const t = line.trim();
                    if (!t)
                        continue;
                    if (t.startsWith('#')) {
                        const names = t.replace(/^#+\s*/, '').split(/\s+/);
                        if (names.includes('pid') && names.includes('sm')) {
                            colIdx = {};
                            for (let i = 0; i < names.length; i++)
                                colIdx[names[i]] = i;
                        }
                        continue;
                    }
                    if (!colIdx || colIdx.pid === undefined || colIdx.sm === undefined) {
                        const f = t.split(/\s+/);
                        if (f.length >= 6) {
                            const pid = parseInt(f[0], 10);
                            const smRaw = f[2];
                            const sm = smRaw === '-' || smRaw === '' || smRaw === undefined ? 0 : parseFloat(smRaw);
                            if (Number.isFinite(pid) && Number.isFinite(sm)) {
                                const prev = byPid.get(pid);
                                if (prev === undefined || sm > prev)
                                    byPid.set(pid, sm);
                            }
                        }
                        continue;
                    }
                    const f = t.split(/\s+/);
                    if (f.length <= Math.max(colIdx.pid, colIdx.sm))
                        continue;
                    const pid = parseInt(f[colIdx.pid], 10);
                    const smRaw = f[colIdx.sm];
                    const sm = smRaw === '-' || smRaw === '' || smRaw === undefined ? 0 : parseFloat(smRaw);
                    if (!Number.isFinite(pid) || !Number.isFinite(sm))
                        continue;
                    const prev = byPid.get(pid);
                    if (prev === undefined || sm > prev)
                        byPid.set(pid, sm);
                }
            }
        }
        catch (e) {
            /* pmon 不可用 → 空 */
        }
        this.pmonCache = { at: Date.now(), val: byPid };
        return byPid;
    }
    /** ② 快照：全量规范化输出（协议 docs/03-protocol.md §2.1；1.2：procs +ppid/+gpuUtilPct；#22 补齐整卡 GPU） */
    async snapshot() {
        const ts = Date.now();
        const [mem, stat, psOut, gpuRes] = await Promise.all([
            this.readMeminfo(),
            this.readStat(),
            this.runner.exec('ps -eo pid=,ppid=,pcpu=,rss=,etimes=,args= --no-headers 2>/dev/null | head -100'),
            this.queryGpu(),
        ]);
        const cpu = { percent: null, cores: null };
        if (stat)
            cpu.percent = this.cpuPercent(stat);
        const procs = [];
        if (psOut && psOut.code === 0) {
            for (const line of (psOut.stdout || '').split('\n')) {
                // #16 启动时间：ps etimes（运行秒数，纯数字无空格）→ startTs = now - etimes*1000
                const mm = line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\d+)\s+(.*)$/);
                if (mm) {
                    const etimes = parseInt(mm[5], 10);
                    procs.push({
                        pid: parseInt(mm[1], 10),
                        ppid: parseInt(mm[2], 10),
                        cmd: mm[6],
                        cpuPct: parseFloat(mm[3]),
                        memMiB: Math.round(parseInt(mm[4], 10) / 1024), // rss kB → MiB（A3 补齐）
                        startTs: Number.isFinite(etimes) ? ts - etimes * 1000 : undefined,
                    });
                }
            }
        }
        const sources = { cpu: 'procfs', mem: 'procfs', procs: 'ps' };
        let degraded = undefined;
        let gpu = undefined;
        if (gpuRes.ok && gpuRes.gpus.length > 0) {
            sources.gpu = 'linux-smi';
            gpu = gpuRes.gpus;
        }
        else {
            degraded = { gpu: gpuRes.reason || 'nvidia-smi unavailable' };
        }
        // 合并器（A1）：pmon 按 pid 归并；失败静默（sources 不标 +pmon）
        const pmon = await this.queryPmon(gpuRes.ok);
        if (pmon.size > 0) {
            sources.procs = 'ps+pmon';
            for (let i = 0; i < procs.length; i++) {
                const sm = pmon.get(procs[i].pid);
                if (sm !== undefined) {
                    procs[i].gpuUtilPct = sm;
                    procs[i].gpu = sm;
                }
            }
        }
        return {
            ts,
            platform: 'linux',
            sources,
            gpu,
            cpu,
            mem: mem || { totalMiB: null, availableMiB: null },
            procs,
            degraded,
        };
    }
    /** ③ 流：Linux 后端无 GPU 流能力（GPU 在 Windows 侧） */
    stream() {
        return null;
    }
    /** ④ 关闭：清差分基线与缓存（无子进程） */
    async close() {
        this.lastCpuTimes = null;
        this.gpuQueryCache = null;
        this.pmonCache = null;
    }
}
