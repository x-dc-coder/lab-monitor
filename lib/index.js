import { defineTool } from "@deepseek-ai/dsh-tools";
import { randomUUID } from "node:crypto";
import Schema from "@deepseek-ai/schemastery";
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import fs, * as fs$1 from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
//#region lib/types/sampler/backend-linux.js
var LinuxBackend = class {
	id = "linux";
	cacheTtlMs = 1e3;
	lastCpuTimes = null;
	runner;
	gpuQueryCache = null;
	pmonCache = null;
	constructor(runner) {
		this.runner = runner;
	}
	cacheGet(entry, ttlMs) {
		if (!entry) return void 0;
		if (Date.now() - entry.at > ttlMs) return void 0;
		return entry.val;
	}
	/** ① 探测：/proc 可读即可用（绝不抛错；探测 GPU 可用性） */
	async probe() {
		try {
			const r = await this.runner.exec("cat /proc/version 2>/dev/null | head -1");
			if (r.code !== 0) return {
				ok: false,
				reason: "cannot read /proc/version: " + (r.stderr || "")
			};
			const detail = { kernel: (r.stdout || "").trim().slice(0, 80) };
			try {
				const gr = await this.runner.exec("nvidia-smi --query-gpu=driver_version,count --format=csv,noheader 2>/dev/null");
				if (gr.code === 0 && gr.stdout.trim()) {
					const parts = gr.stdout.trim().split("\n")[0].split(",");
					detail.gpu = {
						available: true,
						driver: parts[0]?.trim() || null,
						count: parts.length > 1 ? parseInt(parts[1].trim(), 10) : 1
					};
				} else detail.gpu = { available: false };
			} catch (e) {
				detail.gpu = { available: false };
			}
			return {
				ok: true,
				detail
			};
		} catch (e) {
			return {
				ok: false,
				reason: "probe exception: " + e.message
			};
		}
	}
	/** /proc/meminfo → { totalMiB, availableMiB }（kB→MiB，向下取整） */
	async readMeminfo() {
		const r = await this.runner.exec("cat /proc/meminfo 2>/dev/null");
		if (r.code !== 0) return null;
		const m = {};
		for (const line of (r.stdout || "").split("\n")) {
			const mm = line.match(/^(\w+):\s+(\d+)\s*kB/);
			if (mm) m[mm[1]] = parseInt(mm[2], 10);
		}
		if (!m.MemTotal) return null;
		return {
			totalMiB: Math.round(m.MemTotal / 1024),
			availableMiB: m.MemAvailable ? Math.round(m.MemAvailable / 1024) : Math.round((m.MemFree || 0) / 1024)
		};
	}
	/** /proc/stat 首行 → { idle, total, at }（jiffies 差分） */
	async readStat() {
		const r = await this.runner.exec("cat /proc/stat 2>/dev/null | head -1");
		if (r.code !== 0) return null;
		const parts = (r.stdout || "").trim().split(/\s+/).slice(1).map(Number);
		if (parts.length < 4) return null;
		return {
			idle: parts[3] + (parts[4] || 0),
			total: parts.reduce((a, b) => a + b, 0),
			at: Date.now()
		};
	}
	/** CPU 差分（psutil 算法）：首帧返回 null（丢弃）；负值截 0 */
	cpuPercent(cur) {
		const prev = this.lastCpuTimes;
		this.lastCpuTimes = cur;
		if (!prev) return null;
		const dTotal = cur.total - prev.total;
		if (dTotal <= 0) return 0;
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
		const f = line.replace(/\r$/, "").split(",").map((s) => s.trim());
		if (f.length < 7) return null;
		const num = (s) => {
			const n = parseFloat(String(s).split(" ")[0]);
			return Number.isFinite(n) ? n : 0;
		};
		return {
			id: String(parseInt(f[0], 10)),
			name: f[1],
			utilPct: num(f[2]),
			memUsedMiB: num(f[3]),
			memTotalMiB: num(f[4]),
			tempC: num(f[5]),
			powerW: num(f[6])
		};
	}
	/**
	* GPU 快照（query，TTL 500ms 缓存）：
	* 7 列通用参数：index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw
	*/
	async queryGpu() {
		const cached = this.cacheGet(this.gpuQueryCache, 500);
		if (cached !== void 0) return cached;
		try {
			const r = await this.runner.exec("nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader 2>/dev/null");
			if (r.code !== 0) {
				const res = {
					ok: false,
					gpus: [],
					reason: "nvidia-smi query 失败 code=" + r.code
				};
				this.gpuQueryCache = {
					at: Date.now(),
					val: res
				};
				return res;
			}
			const gpus = [];
			for (const line of (r.stdout || "").split("\n")) {
				if (!line.trim()) continue;
				const g = this.parseSmiLine(line);
				if (g) gpus.push(g);
			}
			const res = {
				ok: gpus.length > 0,
				gpus,
				reason: gpus.length === 0 ? "无可用 GPU 设备" : void 0
			};
			this.gpuQueryCache = {
				at: Date.now(),
				val: res
			};
			return res;
		} catch (e) {
			const res = {
				ok: false,
				gpus: [],
				reason: e.message
			};
			this.gpuQueryCache = {
				at: Date.now(),
				val: res
			};
			return res;
		}
	}
	/**
	* 每进程 GPU 利用率（pmon，辅助证据——慢通道 TTL 5s）
	* nvidia-smi pmon -c 3 -s u 多帧窗口：跳过 # 行，列 pid/type/sm/...；`-` 视 0；同 pid 取 max。
	* 无 nvidia 驱动/失败 → 空 Map（gpuUtilPct 不填充，整卡通道不受影响）。
	*/
	async queryPmon(hasGpu = true) {
		if (!hasGpu) return /* @__PURE__ */ new Map();
		const cached = this.cacheGet(this.pmonCache, 5e3);
		if (cached !== void 0) return cached;
		const byPid = /* @__PURE__ */ new Map();
		try {
			const r = await this.runner.exec("nvidia-smi pmon -c 1 -s u 2>/dev/null");
			if (r.code === 0) {
				let colIdx = null;
				for (const line of (r.stdout || "").split("\n")) {
					const t = line.trim();
					if (!t) continue;
					if (t.startsWith("#")) {
						const names = t.replace(/^#+\s*/, "").split(/\s+/);
						if (names.includes("pid") && names.includes("sm")) {
							colIdx = {};
							for (let i = 0; i < names.length; i++) colIdx[names[i]] = i;
						}
						continue;
					}
					if (!colIdx || colIdx.pid === void 0 || colIdx.sm === void 0) {
						const f = t.split(/\s+/);
						if (f.length >= 6) {
							const pid = parseInt(f[0], 10);
							const smRaw = f[2];
							const sm = smRaw === "-" || smRaw === "" || smRaw === void 0 ? 0 : parseFloat(smRaw);
							if (Number.isFinite(pid) && Number.isFinite(sm)) {
								const prev = byPid.get(pid);
								if (prev === void 0 || sm > prev) byPid.set(pid, sm);
							}
						}
						continue;
					}
					const f = t.split(/\s+/);
					if (f.length <= Math.max(colIdx.pid, colIdx.sm)) continue;
					const pid = parseInt(f[colIdx.pid], 10);
					const smRaw = f[colIdx.sm];
					const sm = smRaw === "-" || smRaw === "" || smRaw === void 0 ? 0 : parseFloat(smRaw);
					if (!Number.isFinite(pid) || !Number.isFinite(sm)) continue;
					const prev = byPid.get(pid);
					if (prev === void 0 || sm > prev) byPid.set(pid, sm);
				}
			}
		} catch (e) {}
		this.pmonCache = {
			at: Date.now(),
			val: byPid
		};
		return byPid;
	}
	/** ② 快照：全量规范化输出（协议 docs/03-protocol.md §2.1；1.2：procs +ppid/+gpuUtilPct；#22 补齐整卡 GPU） */
	async snapshot() {
		const ts = Date.now();
		const [mem, stat, psOut, gpuRes] = await Promise.all([
			this.readMeminfo(),
			this.readStat(),
			this.runner.exec("ps -eo pid=,ppid=,pcpu=,rss=,etimes=,args= --no-headers 2>/dev/null | head -100"),
			this.queryGpu()
		]);
		const cpu = {
			percent: null,
			cores: null
		};
		if (stat) cpu.percent = this.cpuPercent(stat);
		const procs = [];
		if (psOut && psOut.code === 0) for (const line of (psOut.stdout || "").split("\n")) {
			const mm = line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\d+)\s+(.*)$/);
			if (mm) {
				const etimes = parseInt(mm[5], 10);
				procs.push({
					pid: parseInt(mm[1], 10),
					ppid: parseInt(mm[2], 10),
					cmd: mm[6],
					cpuPct: parseFloat(mm[3]),
					memMiB: Math.round(parseInt(mm[4], 10) / 1024),
					startTs: Number.isFinite(etimes) ? ts - etimes * 1e3 : void 0
				});
			}
		}
		const sources = {
			cpu: "procfs",
			mem: "procfs",
			procs: "ps"
		};
		let degraded = void 0;
		let gpu = void 0;
		if (gpuRes.ok && gpuRes.gpus.length > 0) {
			sources.gpu = "linux-smi";
			gpu = gpuRes.gpus;
		} else degraded = { gpu: gpuRes.reason || "nvidia-smi unavailable" };
		const pmon = await this.queryPmon(gpuRes.ok);
		if (pmon.size > 0) {
			sources.procs = "ps+pmon";
			for (let i = 0; i < procs.length; i++) {
				const sm = pmon.get(procs[i].pid);
				if (sm !== void 0) {
					procs[i].gpuUtilPct = sm;
					procs[i].gpu = sm;
				}
			}
		}
		return {
			ts,
			platform: "linux",
			sources,
			gpu,
			cpu,
			mem: mem || {
				totalMiB: null,
				availableMiB: null
			},
			procs,
			degraded
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
};
//#endregion
//#region lib/types/sampler/windows-paths.js
/**
* interop 完整路径 + 编码策略常量表（来源：t10 §4 通道契约表 + 08-sampling-empirical.md 实证）
* 1. 全部完整路径（裸名不在 WSL PATH，实证 1.4）
* 2. 编码分通道：nvidia-smi 纯 ASCII 免处理 / PowerShell chcp+UTF8 / tasklist GBK→iconv
* 3. 频率分级：dmon 流 1s / query 40-60ms（TTL 500ms 内复用）/ CIM·tasklist ≥5s
*/
/** 完整路径常量（实证：/mnt/c 可用，裸名不在 PATH） */
const NVIDIA_SMI = "/mnt/c/Windows/System32/nvidia-smi.exe";
const POWERSHELL = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
const TASKLIST = "/mnt/c/Windows/System32/tasklist.exe";
/**
* WSL interop 路径 → 原生 Windows 路径（'/mnt/c/x/y' → 'C:\\x\\y'）；非 /mnt/ 前缀原样返回。
* 原生 Windows（windows-native 后端）child_process 不识别 /mnt/c 形式——2026-10-22 崩溃复盘：
* spawn('/mnt/c/.../nvidia-smi.exe') ENOENT 且未挂 error 监听 → 未捕获异常打崩 DSH 宿主。
*/
function toWinPath(p) {
	const m = /^\/mnt\/([A-Za-z])\/(.*)$/.exec(p);
	if (!m) return p;
	return m[1].toUpperCase() + ":\\" + m[2].replace(/\//g, "\\");
}
/** 频率分级（ms）：慢通道集中化/缓存复用 */
const TTL = {
	QUERY: 500,
	CIM: 5e3,
	TASKLIST: 5e3
};
/** GPU 快照（query）：实测 40-60ms；CSV noheader 行：index,name,driver,util.gpu(%),memory.used(MiB),memory.total(MiB),temp(C),power(W) */
const QUERY_ARGS = ["--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw", "--format=csv,noheader"];
/** GPU 长驻流（dmon）：1s 行流，-s pucvmet；列：pwr gtemp mtemp sm mem enc dec clocks ... */
const DMON_ARGS = [
	"dmon",
	"-d",
	"1",
	"-s",
	"pucvmet"
];
/** 每进程 GPU 利用率（pmon）：-c 3 多帧窗口（R2 防单帧 `-` 低估）；-s u 只取 util 列，输出更短 */
const PMON_ARGS = [
	"pmon",
	"-c",
	"3",
	"-s",
	"u"
];
/**
* Windows CPU/内存/进程树（CIM，TTL 5s）：输出 "cpuLoadPct;totalMemKB;freeMemKB" 首行
* + 每进程 "pid;ppid;name" 行（Win32_Process.ProcessId/ParentProcessId，进程树骨架，实证 55884→47680）
*/
const PS_SYSMEM = [
	"-NoProfile",
	"-Command",
	"chcp 65001|Out-Null; [Console]::OutputEncoding=[Text.Encoding]::UTF8; $p=Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average; $m=Get-CimInstance Win32_OperatingSystem; \"{0};{1};{2}\" -f $p.Average,$m.TotalVisibleMemorySize,$m.FreePhysicalMemory; Get-CimInstance Win32_Process | ForEach-Object { \"{0};{1};{2};{3}\" -f $_.ProcessId,$_.ParentProcessId,$_.Name,[DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds() }"
];
/** Windows 进程表（tasklist）：CSV 含头部 */
const TASKLIST_ARGS = [
	"/FO",
	"CSV",
	"/NH"
];
//#endregion
//#region lib/types/sampler/backend-windows.js
var WindowsBackend = class {
	id = "wsl";
	cacheTtlMs = 500;
	lastCpuTimes = null;
	runner;
	spawned = [];
	cimCache = null;
	taskCache = null;
	gpuQueryCache = null;
	pmonCache = null;
	restarts = 0;
	lastRestartAt = 0;
	fallbackMode = false;
	closed = false;
	constructor(runner) {
		this.runner = runner;
	}
	now() {
		return Date.now();
	}
	/** 缓存命中判断 */
	cacheGet(cache, ttl) {
		if (cache && this.now() - cache.at < ttl) return cache.data;
	}
	cacheSet(slot, data) {
		this[slot] = {
			at: this.now(),
			data
		};
	}
	/**
	* 解析 nvidia-smi CSV noheader 行（7 列，实测）：
	*   "0, NVIDIA GeForce RTX 5060 Ti, 7 %, 1867 MiB, 16311 MiB, 43, 20.77 W\r"
	*   → { id, name, utilPct, memUsedMiB, memTotalMiB, tempC, powerW }（单位后缀剥离；\r 容忍）
	* 2026-08-20：数值字段安全解析——nvidia-smi 在异常/驱动降级时会输出 "N/A"，parseFloat 得
	* NaN 后直达工具输出破坏 lossless JSON 校验；非有限数一律视为 0（该通道不可用降级语义）。
	*/
	parseSmiLine(line) {
		const f = line.replace(/\r$/, "").split(",").map((s) => s.trim());
		if (f.length < 7) return null;
		const num = (s) => {
			const n = parseFloat(String(s).split(" ")[0]);
			return Number.isFinite(n) ? n : 0;
		};
		return {
			id: String(parseInt(f[0], 10)),
			name: f[1],
			utilPct: num(f[2]),
			memUsedMiB: num(f[3]),
			memTotalMiB: num(f[4]),
			tempC: num(f[5]),
			powerW: num(f[6])
		};
	}
	/** ① probe：interop 通道可用性（失败只降级该项，不整体失败） */
	async probe() {
		const detail = {
			gpu: { available: false },
			interop: false
		};
		const out = {};
		try {
			out.gpu = await this.runner.execArgs(NVIDIA_SMI, ["--query-gpu=driver_version,count", "--format=csv,noheader"]);
		} catch (e) {
			out.gpu = {
				code: -1,
				stderr: e.message
			};
		}
		try {
			out.ps = await this.runner.execArgs(POWERSHELL, [
				"-NoProfile",
				"-Command",
				"1"
			]);
		} catch (e) {
			out.ps = {
				code: -1,
				stderr: e.message
			};
		}
		try {
			out.tasklist = await this.runner.execArgs(TASKLIST, ["/NH"]);
		} catch (e) {
			out.tasklist = {
				code: -1,
				stderr: e.message
			};
		}
		const gpuDetail = detail.gpu;
		gpuDetail.available = !!out.gpu && out.gpu.code === 0;
		if (gpuDetail.available) {
			const parts = (out.gpu.stdout || "").trim().split("\n")[0].split(",");
			gpuDetail.driver = parts.length > 0 ? parts[0].trim() : null;
			gpuDetail.count = parts.length > 1 ? parseInt(parts[1].trim(), 10) : null;
		}
		detail.interop = !!out.ps && out.ps.code === 0 || !!out.tasklist && out.tasklist.code === 0;
		const ok = gpuDetail.available || detail.interop;
		return {
			ok,
			reason: ok ? void 0 : "interop 全部通道不可用: gpu=" + (out.gpu && out.gpu.code) + " ps=" + (out.ps && out.ps.code) + " tasklist=" + (out.tasklist && out.tasklist.code),
			detail
		};
	}
	/** GPU 快照（query，TTL 500ms 缓存） */
	async queryGpu() {
		const cached = this.cacheGet(this.gpuQueryCache, TTL.QUERY);
		if (cached !== void 0) return cached;
		const r = await this.runner.execArgs(NVIDIA_SMI, QUERY_ARGS);
		if (r.code !== 0) {
			this.gpuQueryCache = null;
			return {
				ok: false,
				gpus: [],
				reason: "nvidia-smi query 失败 code=" + r.code + " " + (r.stderr || "")
			};
		}
		const gpus = [];
		for (const line of (r.stdout || "").split("\n")) {
			if (!line.trim()) continue;
			const g = this.parseSmiLine(line);
			if (g) gpus.push(g);
		}
		const res = {
			ok: true,
			gpus
		};
		this.cacheSet("_gpuQueryCache", res);
		return res;
	}
	/**
	* CPU/内存/进程树（CIM，TTL 5s；interop 断 → 回退 /proc，D1-1）
	* 输出：首行 "cpuLoad;totalKB;freeKB"，随后每进程 "pid;ppid;name" 行 → ppidMap（进程树骨架，A4）
	*/
	async sysMemCim() {
		const cached = this.cacheGet(this.cimCache, TTL.CIM);
		if (cached !== void 0) return cached;
		const r = await this.runner.execArgs(POWERSHELL, PS_SYSMEM);
		if (r.code !== 0) return {
			ok: false,
			cpuPercent: null,
			totalMiB: 0,
			availableMiB: 0,
			ppidMap: {},
			startTsMap: {},
			reason: "CIM 失败 code=" + r.code
		};
		const lines = (r.stdout || "").trim().split("\n");
		const parts = lines.length ? lines[0].trim().split(";") : [];
		if (parts.length < 3) return {
			ok: false,
			cpuPercent: null,
			totalMiB: 0,
			availableMiB: 0,
			ppidMap: {},
			startTsMap: {},
			reason: "CIM 输出格式异常: " + r.stdout
		};
		const ppidMap = {};
		const startTsMap = {};
		for (let i = 1; i < lines.length; i++) {
			const f = lines[i].trim().split(";");
			if (f.length >= 3) {
				const pid = parseInt(f[0], 10);
				const ppid = parseInt(f[1], 10);
				if (Number.isFinite(pid) && Number.isFinite(ppid)) ppidMap[pid] = ppid;
				if (f.length >= 4) {
					const t = parseInt(f[3], 10);
					if (Number.isFinite(t) && t > 0) startTsMap[pid] = t;
				}
			}
		}
		const res = {
			ok: true,
			cpuPercent: (() => {
				const n = parseFloat(parts[0]);
				return Number.isFinite(n) ? n : null;
			})(),
			totalMiB: (() => {
				const n = parseInt(parts[1], 10);
				return Number.isFinite(n) ? Math.round(n / 1024) : 0;
			})(),
			availableMiB: (() => {
				const n = parseInt(parts[2], 10);
				return Number.isFinite(n) ? Math.round(n / 1024) : 0;
			})(),
			ppidMap,
			startTsMap
		};
		this.cacheSet("_cimCache", res);
		return res;
	}
	/**
	* 每进程 GPU 利用率（pmon，TTL 5s 低频，辅助证据——A1）
	* `nvidia-smi pmon -c 3 -s u` 多帧窗口：跳过 # 注释行，列 pid/type/sm/mem/enc/dec/command；
	* sm（compute%）`-` 视 0；同 pid 多帧取 max（R2：防单帧 `-` 低估）。
	* 失败/驱动不支持 → { ok:false }，上层 gpuUtilPct 留空（整卡指标不受影响）。
	* 2026-08-20 修复：新版 pmon 表头为 `gpu pid type sm mem enc dec jpg ofa command`（9 列，
	* 首列 gpu 索引 + jpg/ofa 列），旧版为 `pid type sm mem enc dec command`（6 列）。解析
	* 不再按固定列序，改为**按表头列名映射索引**——兼容两种格式，避免把 gpu 索引当 pid、
	* 把 type（C+G）当 sm 导致全部行被过滤（GPU 占用列恒 '-' 的根因）。
	*/
	async queryPmon() {
		const cached = this.cacheGet(this.pmonCache, TTL.CIM);
		if (cached !== void 0) return cached;
		const r = await this.runner.execArgs(NVIDIA_SMI, PMON_ARGS);
		if (r.code !== 0) {
			this.pmonCache = null;
			return {
				ok: false,
				byPid: /* @__PURE__ */ new Map(),
				reason: "pmon 失败 code=" + r.code + " " + (r.stderr || "")
			};
		}
		const byPid = /* @__PURE__ */ new Map();
		let colIdx = null;
		for (const line of (r.stdout || "").split("\n")) {
			const t = line.trim();
			if (!t) continue;
			if (t.startsWith("#")) {
				const names = t.replace(/^#+\s*/, "").split(/\s+/);
				if (names.includes("pid") && names.includes("sm")) {
					colIdx = {};
					for (let i = 0; i < names.length; i++) colIdx[names[i]] = i;
				}
				continue;
			}
			if (!colIdx || colIdx.pid === void 0 || colIdx.sm === void 0) continue;
			const f = t.split(/\s+/);
			if (f.length <= Math.max(colIdx.pid, colIdx.sm)) continue;
			const pid = parseInt(f[colIdx.pid], 10);
			const smRaw = f[colIdx.sm];
			const sm = smRaw === "-" || smRaw === "" || smRaw === void 0 ? 0 : parseFloat(smRaw);
			if (!Number.isFinite(pid) || !Number.isFinite(sm)) continue;
			const prev = byPid.get(pid);
			if (prev === void 0 || sm > prev) byPid.set(pid, sm);
		}
		const res = {
			ok: true,
			byPid
		};
		this.cacheSet("_pmonCache", res);
		return res;
	}
	/** interop 断时的 /proc 回退（WSL 内核视角仍真实，sources 标 procfs） */
	async sysMemProc() {
		const r = await this.runner.exec("cat /proc/meminfo 2>/dev/null");
		if (r.code !== 0) return {
			ok: false,
			totalMiB: 0,
			availableMiB: 0,
			reason: "/proc/meminfo 不可读"
		};
		const m = {};
		for (const line of (r.stdout || "").split("\n")) {
			const mm = line.match(/^(\w+):\s+(\d+)\s*kB/);
			if (mm) m[mm[1]] = parseInt(mm[2], 10);
		}
		if (!m.MemTotal) return {
			ok: false,
			totalMiB: 0,
			availableMiB: 0,
			reason: "MemTotal 缺失"
		};
		return {
			ok: true,
			totalMiB: Math.round(m.MemTotal / 1024),
			availableMiB: m.MemAvailable ? Math.round(m.MemAvailable / 1024) : Math.round((m.MemFree || 0) / 1024)
		};
	}
	async cpuFromProc() {
		const r = await this.runner.exec("cat /proc/stat 2>/dev/null | head -1");
		if (r.code !== 0) return null;
		const parts = (r.stdout || "").trim().split(/\s+/).slice(1).map(Number);
		if (parts.length < 4) return null;
		const cur = {
			idle: parts[3] + (parts[4] || 0),
			total: parts.reduce((a, b) => a + b, 0),
			at: Date.now()
		};
		const prev = this.lastCpuTimes;
		this.lastCpuTimes = cur;
		if (!prev) return null;
		const dTotal = cur.total - prev.total;
		if (dTotal <= 0) return 0;
		const dIdle = cur.idle - prev.idle;
		return Math.round(Math.max((1 - Math.max(dIdle, 0) / dTotal) * 100, 0) * 10) / 10;
	}
	/** 进程表（tasklist GBK→iconv，TTL 5s） */
	async procsTasklist() {
		const cached = this.cacheGet(this.taskCache, TTL.TASKLIST);
		if (cached !== void 0) return cached;
		const r = await this.runner.execArgsEnc(TASKLIST, TASKLIST_ARGS, "GBK");
		if (r.code !== 0) return {
			ok: false,
			procs: [],
			reason: "tasklist 失败 code=" + r.code
		};
		const procs = [];
		for (const line of (r.stdout || "").split("\n")) {
			const mm = line.match(/"([^"]*)","(\d+)","([^"]*)","(\d+)","([^"]*)"/);
			if (mm) {
				const memStr = mm[5].replace(/[, ]/g, "");
				const memKB = parseInt(memStr, 10);
				procs.push({
					pid: parseInt(mm[2], 10),
					cmd: mm[1],
					cpuPct: null,
					memMiB: isNaN(memKB) ? null : Math.round(memKB / 1024)
				});
			}
		}
		const res = {
			ok: true,
			procs
		};
		this.cacheSet("_taskCache", res);
		return res;
	}
	/** ② snapshot：全量规范化输出 */
	async snapshot() {
		const ts = this.now();
		const sources = {
			cpu: "cim",
			mem: "cim",
			procs: "tasklist"
		};
		let degraded = null;
		const gpuRes = await this.queryGpu();
		let gpu;
		if (gpuRes.ok) {
			sources.gpu = "query";
			gpu = gpuRes.gpus.map((g) => g);
		} else sources.gpu = "unavailable";
		const sys = await this.sysMemCim();
		const cpu = {
			percent: null,
			cores: null
		};
		const mem = {
			totalMiB: null,
			availableMiB: null
		};
		if (sys.ok) {
			cpu.percent = sys.cpuPercent;
			mem.totalMiB = sys.totalMiB;
			mem.availableMiB = sys.availableMiB;
		} else {
			sources.cpu = "procfs";
			sources.mem = "procfs";
			const procMem = await this.sysMemProc();
			if (procMem.ok) {
				mem.totalMiB = procMem.totalMiB;
				mem.availableMiB = procMem.availableMiB;
				cpu.percent = await this.cpuFromProc();
			}
			if (degraded === null) degraded = { reason: "CIM 不可用回退 /proc" };
		}
		let procs = [];
		const procsRes = await this.procsTasklist();
		if (procsRes.ok) procs = procsRes.procs;
		else {
			sources.procs = "ps";
			const psOut = await this.runner.exec("ps -eo pid=,ppid=,pcpu=,rss=,args= --no-headers 2>/dev/null | head -100");
			if (psOut.code === 0) for (const line of (psOut.stdout || "").split("\n")) {
				const mm = line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/);
				if (mm) procs.push({
					pid: parseInt(mm[1], 10),
					ppid: parseInt(mm[2], 10),
					cmd: mm[5],
					cpuPct: parseFloat(mm[3]),
					memMiB: Math.round(parseInt(mm[4], 10) / 1024)
				});
			}
		}
		const pmon = await this.queryPmon();
		if (pmon.ok) {
			sources.procs = (sources.procs === "tasklist" ? "tasklist" : "ps") + "+pmon";
			if (procs.length === 0 && pmon.byPid.size > 0) sources.procs = "pmon";
		}
		if (sys.ok && Object.keys(sys.ppidMap).length > 0) for (let i = 0; i < procs.length; i++) {
			const pp = sys.ppidMap[procs[i].pid];
			if (pp !== void 0) procs[i].ppid = pp;
		}
		if (sys.ok && Object.keys(sys.startTsMap).length > 0) for (let i = 0; i < procs.length; i++) {
			const st = sys.startTsMap[procs[i].pid];
			if (st !== void 0) procs[i].startTs = st;
		}
		if (pmon.byPid.size > 0) for (let i = 0; i < procs.length; i++) {
			const sm = pmon.byPid.get(procs[i].pid);
			if (sm !== void 0) {
				procs[i].gpuUtilPct = sm;
				procs[i].gpu = sm;
			}
		}
		procs = this.purgeSamplerSelf(procs);
		const snap = {
			ts,
			platform: "wsl",
			sources,
			cpu,
			mem,
			procs
		};
		if (gpu !== void 0) snap.gpu = gpu;
		if (this.fallbackMode) {
			if (degraded === null) degraded = {};
			degraded.gpu = "query-fallback";
		}
		if (degraded !== null) snap.degraded = degraded;
		return snap;
	}
	/**
	* 剔除采样自曝进程（重名进程优化 ③）：
	* 1. 采样工具自身：tasklist.exe（快照窗口自采）/ nvidia-smi.exe（含 dmon 长驻流，每帧必现）
	* 2. 它们的控制台宿主 conhost.exe（ppid 指向采样工具）——用户程序的 conhost 保留
	* 匹配按 Windows 侧映像名，大小写不敏感（tasklist 输出实测小写）。
	*/
	purgeSamplerSelf(procs) {
		const SELF = /* @__PURE__ */ new Set(["tasklist.exe", "nvidia-smi.exe"]);
		const selfPids = /* @__PURE__ */ new Set();
		for (const p of procs) {
			const name = (p.cmd || "").trim().toLowerCase();
			if (SELF.has(name)) selfPids.add(p.pid);
		}
		if (selfPids.size === 0) return procs;
		return procs.filter((p) => {
			if (selfPids.has(p.pid)) return false;
			if ((p.cmd || "").trim().toLowerCase() === "conhost.exe" && p.ppid !== void 0 && p.ppid !== null && selfPids.has(p.ppid)) return false;
			return true;
		});
	}
	/** ③ stream：dmon 长驻流（指数退避重启 → query-fallback） */
	stream() {
		const self = this;
		return { [Symbol.asyncIterator]() {
			return self.streamIterator();
		} };
	}
	async *streamIterator() {
		while (true) {
			if (this.closed) break;
			let proc = null;
			try {
				proc = this.runner.spawnArgs(NVIDIA_SMI, DMON_ARGS);
				this.spawned.push(proc);
			} catch (e) {
				this.fallbackMode = true;
				break;
			}
			let eof = false;
			let buf = "";
			const readLine = () => {
				const delta = proc ? proc.readOutput() : "";
				buf += delta;
				const nl = buf.indexOf("\n");
				if (nl < 0) return null;
				const line = buf.slice(0, nl).replace(/\r$/, "");
				buf = buf.slice(nl + 1);
				return line;
			};
			while (true) {
				if (proc && proc.done()) {
					eof = true;
					break;
				}
				const line = readLine();
				if (line !== null && line.trim()) {
					yield {
						ts: Date.now(),
						raw: line
					};
					continue;
				}
				if (proc && proc.done()) {
					eof = true;
					break;
				}
				await this.runner.sleep(200);
			}
			if (proc) {
				const idx = this.spawned.indexOf(proc);
				if (idx >= 0) this.spawned.splice(idx, 1);
				try {
					proc.kill();
				} catch (e) {}
			}
			if (!eof) break;
			if (this.closed) break;
			const now = Date.now();
			if (now - this.lastRestartAt > 3e5) this.restarts = 0;
			this.restarts++;
			if (this.restarts > 3) {
				this.fallbackMode = true;
				break;
			}
			const delay = Math.min(1e3 * Math.pow(2, this.restarts - 1), 4e3);
			this.lastRestartAt = now;
			await this.runner.sleep(delay);
		}
	}
	/** ④ close：杀 interop 子进程（D2-1 防孤儿），幂等 */
	async close() {
		this.closed = true;
		for (let i = 0; i < this.spawned.length; i++) try {
			this.spawned[i].kill();
		} catch (e) {}
		this.spawned = [];
		this.cimCache = null;
		this.taskCache = null;
		this.gpuQueryCache = null;
		this.pmonCache = null;
		this.lastCpuTimes = null;
		this.fallbackMode = false;
		this.restarts = 0;
	}
};
//#endregion
//#region lib/types/sampler/backend-windows-native.js
/**
* WindowsNativeBackend —— 原生 Windows 场景（DSH 直接跑在 Windows，无 WSL interop）
*
* 实现方式（#15，2026-08-24）：**委托复用 WindowsBackend 全部通道逻辑**
* （tasklist GBK→iconv / PowerShell CIM / nvidia-smi query+dmon / pmon），
* 唯一差异是命令执行方式——原生 Windows 用 child_process 直接本地执行，
* 不经 WSL interop（WSL 下 runner.exec 走 wsl.exe 桥，Windows 原生不需要）。
*
* 前置：detectPlatform 增加 process.platform==='win32' → 'windows-native'；
*       createBackend mode='windows-native' 或 auto+win32 时实例化本类。
*/
/** 原生 Windows 本地执行 runner：直接 spawn 命令（不经 WSL interop） */
function localWinRunner() {
	const enc = (buf) => {
		try {
			return new TextDecoder("gbk").decode(buf);
		} catch (e) {
			return buf.toString("utf8");
		}
	};
	return {
		async exec(cmd) {
			try {
				return {
					code: 0,
					stdout: execFileSync("cmd.exe", ["/c", cmd], {
						encoding: "buffer",
						timeout: 8e3
					}).toString("utf8"),
					stderr: ""
				};
			} catch (e) {
				const err = e;
				return {
					code: err.status ?? 1,
					stdout: (err.stdout || "").toString("utf8"),
					stderr: (err.stderr || "").toString("utf8")
				};
			}
		},
		async execArgs(cmd, args) {
			try {
				return {
					code: 0,
					stdout: execFileSync(toWinPath(cmd), args, {
						encoding: "utf8",
						timeout: 1e4
					}),
					stderr: ""
				};
			} catch (e) {
				const err = e;
				return {
					code: err.status ?? 1,
					stdout: (err.stdout || "").toString("utf8"),
					stderr: (err.stderr || "").toString("utf8")
				};
			}
		},
		async execArgsEnc(cmd, args, fromEncoding) {
			try {
				const out = spawnSync(toWinPath(cmd), args, {
					encoding: "buffer",
					timeout: 1e4
				});
				const raw = out.stdout || Buffer.alloc(0);
				const text = fromEncoding === "GBK" ? enc(raw) : raw.toString("utf8");
				return {
					code: out.status ?? (out.error ? 1 : 0),
					stdout: text,
					stderr: (out.stderr || "").toString("utf8")
				};
			} catch (e) {
				return {
					code: 1,
					stdout: "",
					stderr: String(e)
				};
			}
		},
		spawnArgs(file, args) {
			let acc = "";
			let failed = false;
			const child = spawn(toWinPath(file), args, { windowsHide: true });
			child.on("error", () => {
				failed = true;
			});
			child.stdout.on("data", (d) => {
				acc += d.toString("utf8");
			});
			child.stderr.on("data", () => {});
			return {
				pid: child.pid ?? null,
				readOutput() {
					const s = acc;
					acc = "";
					return s;
				},
				done() {
					return failed || child.exitCode !== null || child.signalCode !== null;
				},
				kill() {
					try {
						child.kill();
					} catch (e) {}
				}
			};
		},
		async sleep(ms) {
			await new Promise((r) => setTimeout(r, ms));
		}
	};
}
var WindowsNativeBackend = class {
	id = "windows-native";
	cacheTtlMs = 500;
	lastCpuTimes = null;
	delegate;
	constructor(_runner) {
		this.delegate = new WindowsBackend(localWinRunner());
	}
	async probe() {
		return this.delegate.probe();
	}
	async snapshot() {
		return {
			...await this.delegate.snapshot(),
			platform: "windows-native"
		};
	}
	stream() {
		return this.delegate.stream();
	}
	async close() {
		await this.delegate.close();
	}
};
//#endregion
//#region lib/types/sampler/runner-ssh.js
var SshRunner = class {
	config;
	socketPath;
	base;
	closed = false;
	constructor(config, baseRunner) {
		this.config = config;
		this.base = baseRunner;
		this.socketPath = config.socketPath || `/tmp/lab_mon_ssh_${config.host}_${config.port || 22}_${config.user}.sock`;
	}
	buildSshCommand(remoteCmd) {
		const b64 = Buffer.from(remoteCmd).toString("base64");
		const timeout = this.config.connectTimeoutSec || 5;
		const parts = ["ssh"];
		if (this.config.keyPath) parts.push(`-i '${this.config.keyPath}'`);
		if (this.config.port) parts.push(`-p ${this.config.port}`);
		parts.push("-o BatchMode=yes");
		parts.push("-o StrictHostKeyChecking=no");
		parts.push(`-o ConnectTimeout=${timeout}`);
		parts.push("-o ControlMaster=auto");
		parts.push(`-o ControlPath='${this.socketPath}'`);
		parts.push("-o ControlPersist=600");
		parts.push(`'${this.config.user}@${this.config.host}'`);
		parts.push(`"echo ${b64} | base64 -d | /bin/bash"`);
		return parts.join(" ");
	}
	async exec(cmdStr) {
		if (this.closed) return {
			code: -1,
			stdout: "",
			stderr: "SshRunner is closed"
		};
		try {
			const sshCmd = this.buildSshCommand(cmdStr);
			const res = await this.base.exec(sshCmd);
			if (res.code !== 0 && (res.stderr.includes("Control socket connect") || res.stderr.includes("Connection refused") || res.stderr.includes("Broken pipe"))) {
				try {
					if (fs.existsSync(this.socketPath)) fs.unlinkSync(this.socketPath);
				} catch (e) {}
				const retryCmd = this.buildSshCommand(cmdStr);
				return await this.base.exec(retryCmd);
			}
			return res;
		} catch (e) {
			return {
				code: -1,
				stdout: "",
				stderr: String(e.message || e)
			};
		}
	}
	async execArgs(file, args) {
		const cmd = [file, ...args].join(" ");
		return this.exec(cmd);
	}
	async execArgsEnc(file, args, _enc) {
		const cmd = [file, ...args].join(" ");
		return this.exec(cmd);
	}
	spawnArgs(_file, _args) {
		return {
			pid: null,
			readOutput() {
				return "";
			},
			done() {
				return true;
			},
			kill() {}
		};
	}
	async sleep(ms) {
		return this.base.sleep(ms);
	}
	async close() {
		this.closed = true;
		try {
			const exitCmd = `ssh -O exit -o ControlPath='${this.socketPath}' '${this.config.user}@${this.config.host}' 2>/dev/null || true`;
			await this.base.exec(exitCmd);
			if (fs.existsSync(this.socketPath)) try {
				fs.unlinkSync(this.socketPath);
			} catch (e) {}
		} catch (e) {}
	}
};
//#endregion
//#region lib/types/sampler/index.js
/** 平台探测：#15 原生 Windows（process.platform==='win32'，无 /proc）→ 'windows-native'；
*  否则 /proc/version 含 microsoft → 'wsl'；其余 'linux' */
async function detectPlatform(runner) {
	if (typeof process !== "undefined" && process.platform === "win32") return "windows-native";
	const r = await runner.exec("cat /proc/version 2>/dev/null | head -1");
	const v = (r.stdout || "") + " " + (r.stderr || "");
	if (/microsoft/i.test(v)) return "wsl";
	return "linux";
}
/**
* 平台分发：返回 { backend, platform }。
* #14 backendMode 覆盖自动判定：
*   auto（默认）= WSL→WindowsBackend、linux→LinuxBackend（现状）
*   windows = 强制 WindowsBackend（WSL 或纯 Linux 上都试 Windows interop，失败由 probe 降级）
*   linux   = 强制 LinuxBackend（WSL 下监控 WSL 内 Linux 进程，实验同 pid 空间）
*   windows-native = 原生 Windows 后端（#15；当前为桩）
*/
async function createBackend(runner, mode = "auto") {
	if (mode === "linux") return {
		backend: new LinuxBackend(runner),
		platform: "linux"
	};
	if (mode === "windows") return {
		backend: new WindowsBackend(runner),
		platform: "wsl"
	};
	if (mode === "windows-native") return {
		backend: new WindowsNativeBackend(runner),
		platform: "windows-native"
	};
	const platform = await detectPlatform(runner);
	if (platform === "windows-native") return {
		backend: new WindowsNativeBackend(runner),
		platform
	};
	if (platform === "wsl") return {
		backend: new WindowsBackend(runner),
		platform
	};
	return {
		backend: new LinuxBackend(runner),
		platform
	};
}
/** 快照聚合：backend.snapshot() 已输出规范化结构（含 ts/platform/sources）；上层直接消费 */
async function collectSnapshot(backend) {
	return backend.snapshot();
}
/** probe 封装：后端可用性（上层启动时调用，失败只降级对应通道） */
function probeBackend(backend) {
	return backend.probe();
}
//#endregion
//#region lib/types/core/constants.js
/** 采集周期（核心层固定 2s；UI 轮询见 pollMs） */
const SAMPLE_MS = 2e3;
/** R-3：实验 running 期扩容至 2h */
const RING_EXPAND_POINTS = 2e3;
const RING_EXPAND_MS = 72e5;
const THRESHOLD_DEFAULTS = {
	utilWarn: 90,
	memWarn: 95,
	tempWarn: 85,
	pollMs: 5e3,
	procTopN: 30,
	wGpu: 1,
	wCpu: 1,
	wMem: 1
};
/**
* 训练命令识别表（T4-1 + 2026-08-23 精度修复）
* 误报实证（T2 §2.4，~/.dsh/settings.yaml history）：grep 模式串含 "torchrun" 被命中、
* gh issue heredoc 含 torchrun 字样命中、python3 -c "import zipfile" 工具脚本全被记为实验。
* 修复原则（docs/research/21-t2 §2.4 + 22-issue5 §3.3）：
*   - torchrun/deepspeed 不再裸词匹配：要求后跟 脚本文件 或 训练器句式（-m torch.distributed 等）
*   - python -c/-m 增加排除特征：常见工具/检查形态（import zipfile/docx 检查、打印环境等）不命中
*   - 未命中 = null（不猜），防误报优先
*/
const TRAIN_PATTERNS = [
	{
		name: "python train*.py",
		re: /(?:^|[^a-z0-9._-])(?:python3?|uv)\s+(?:\S+[\/\\])?train[^\s'" ]*\.py/i
	},
	{
		name: "torchrun",
		re: /(?:^|[^a-z0-9._-])torchrun\b(?:\s+--?[a-z0-9_=-]+)*\s+(?:\S+[\/\\])?[a-zA-Z0-9_.-]+\.(?:py|sh)\b|(?:^|[^a-z0-9._-])torchrun\b[\s\S]*?-m\s+torch\.distributed\b/i
	},
	{
		name: "deepspeed",
		re: /(?:^|[^a-z0-9._-])deepspeed\b(?:\s+--?[a-z0-9_=-]+)*\s+(?:\S+[\/\\])?[a-zA-Z0-9_.-]+\.(?:py|sh)\b/i
	},
	{
		name: "python -m",
		re: /(?:^|[^a-z0-9._-])(?:python3?|uv)\s+-m\s+(?:torch\.distributed|accelerate|deepspeed)\b/i
	},
	{
		name: "python -c",
		re: /(?:^|[^a-z0-9._-])python3?\s+-c\s+["'][\s\S]{0,400}?(?:torch\.distributed|nn\.Module|backward|epochs?|\btrain(?![a-z_])|\btraining\b)/i
	}
];
function matchTrainFeature(cmdStr) {
	if (typeof cmdStr !== "string") return null;
	for (let i = 0; i < TRAIN_PATTERNS.length; i++) if (TRAIN_PATTERNS[i].re.test(cmdStr)) return TRAIN_PATTERNS[i].name;
	return null;
}
/**
* M2（issue#6，docs/research/22 §3.3）：实验类型自动层识别正则（保守，未命中不猜）。
* 判定顺序（classifyExpType）：smoke/regression/full 明确形态 → gpu-train（matchTrainFeature 门控）
* → gpu-calc（推理/渲染/仿真，非 train）→ long（serve/batch 类长驻）。gpu-train 不在本表，
* 由 TRAIN_PATTERNS（2026-08-23 精度修复，11/11 验证）门控，避免与 calc 关键字冲突。
*/
const EXP_TYPE_PATTERNS = [
	{
		type: "smoke",
		re: /\b(smoke|冒烟|--smoke|test_smoke|smoke_test)\b/i
	},
	{
		type: "regression",
		re: /\b(regression|回归|run_regression|regress)\b/i
	},
	{
		type: "full",
		re: /\b(full|全量|run_all|--full|e2e_all)\b/i
	},
	{
		type: "gpu-calc",
		re: /\b(?:infer|inference|render|sim|simulate)[\w-]*\.py\b|(?:推理|渲染)/i
	},
	{
		type: "long",
		re: /\b(?:serve|batch|daemon|watch)[\w-]*\.py\b/i
	}
];
/**
* M2（issue#6，docs/research/22 §3.4）：类型 × notifyLevel 出厂默认矩阵。
* 语义：类型矩阵 = 配置（experimentTypes 可覆盖），本表只是出厂建议值，不硬编码代码分支。
* unknown 走全局 fallback（critical→notice 起点，不给类型特权）。
*/
const EXP_TYPE_DEFAULT_NOTIFY = {
	smoke: {
		critical: "notice",
		warn: "off"
	},
	regression: {
		critical: "notice",
		warn: "off"
	},
	full: {
		critical: "wake",
		warn: "notice"
	},
	short: {
		critical: "wake",
		warn: "notice"
	},
	long: {
		critical: "wake",
		warn: "notice"
	},
	"gpu-calc": {
		critical: "wake",
		warn: "notice"
	},
	"gpu-train": {
		critical: "wake",
		warn: "wake"
	},
	unknown: {
		critical: "notice",
		warn: "notice"
	}
};
/**
* 命令指纹：ps 关联 / result 配对用的特征串（T1-1/T1-2）
* v1.4.5（e2e 实证）：python -c 内联形态用「pyc: + 归一化命令从 -c 起的完整后缀前 28 字符」，
* ps 行 indexOf 可匹配（findAliveProc 同归一化）；不可用 m[1]（分号处截断）。
* 2026-08-20（A2 多轨修复）：28 → 48 字符——v1 单跟踪时指纹只匹配自身（长度无碍），
* 多轨下两个相似命令（如 sleep(30) vs sleep(35)）在 28 字符处差异恰好被截掉 → 指纹相同
* → 都关联到第一个进程（pid/procGroup 重叠，实证 run-001/run-002 共享进程组）。
* 48 字符保留更多区分信息，且 ps cmdline 一般长于此，indexOf 匹配不受影响。
*/
function cmdFingerprint(cmdStr) {
	const norm = String(cmdStr || "").trim().replace(/\s+/g, " ");
	const m = norm.match(/(?:^|[^a-z0-9._-])([a-zA-Z0-9_.\-]+\.py)\b/i);
	if (m) return m[1];
	const mc = norm.match(/-c\s+["']?([\s\S]+?)["']?\s*(?:$|;)/);
	if (/python3?\s+-c\b/.test(norm) && mc) return "pyc:" + norm.slice(norm.indexOf("-c")).replace(/["']/g, "").replace(/\s+/g, " ").slice(0, 48);
	const mm = norm.match(/(?:^|\s)(?:[^\s]*[\\/])?(?:python[0-9.]*|uv(?:\s+run)?)(?:\.exe)?\s+-m\s+([a-zA-Z0-9_.]+)/i);
	if (mm) return "pym:" + mm[1];
	if (/torchrun|deepspeed/.test(norm)) return norm.split(/\s+/).slice(0, 6).join(" ").slice(0, 80);
	const tok = norm.split(/\s+/)[0] || "";
	if (/(?:^|[\\/])(python[0-9.]*|uv|node|bash|sh)(?:\.exe)?$/i.test(tok)) return "bin:" + tok.slice(0, 40);
	return tok.slice(0, 40) || String(cmdStr).slice(0, 40);
}
/** ps 行归一化：与 cmdFingerprint 的归一化对齐（引号剥离、空白折叠） */
function normalizeCmdForMatch(s) {
	return String(s || "").replace(/["']/g, "").trim().replace(/\s+/g, " ");
}
let RUN_ID_COUNTER = 0;
/**
* runId（settings 持久化主键 / 告警 runId 关联 / history 去重）
* 2026-08-24（实测修复）：原实现仅日期+计数器，重启后计数器归零 → 同日重启多次会与
* settings 恢复的旧记录 runId 重复（实测 run-20260824-001 出现两条：恢复的历史 + 新 run）。
* 仿 makeTagId 修复：日期 + HHMMSS + 计数器（同一秒内最多 999 条，重启后同秒并发概率可忽略）。
*/
function makeRunId() {
	RUN_ID_COUNTER += 1;
	const d = /* @__PURE__ */ new Date();
	const y = d.getFullYear();
	const mo = ("0" + (d.getMonth() + 1)).slice(-2);
	const dd = ("0" + d.getDate()).slice(-2);
	const hh = ("0" + d.getHours()).slice(-2);
	const mm = ("0" + d.getMinutes()).slice(-2);
	const ss = ("0" + d.getSeconds()).slice(-2);
	return "run-" + y + mo + dd + "-" + hh + mm + ss + "-" + ("000" + RUN_ID_COUNTER).slice(-3);
}
let TAG_ID_COUNTER = 0;
/**
* 标签规则 id（与 runId 区分前缀；settings 持久化主键）
* 2026-08-20（持久化修复）：id 必须跨重启唯一——之前仅日期+计数器，重启后计数器归零
* → 新规则与磁盘已有规则 id 重复（实测 tag-20260820-001 重复两条，remove 会删错）。
* 改为日期 + HHMMSS + 计数器（同一秒内最多 999 条，足够；重启后同秒并发概率可忽略）。
*/
function makeTagId() {
	TAG_ID_COUNTER += 1;
	const d = /* @__PURE__ */ new Date();
	const y = d.getFullYear();
	const mo = ("0" + (d.getMonth() + 1)).slice(-2);
	const dd = ("0" + d.getDate()).slice(-2);
	const hh = ("0" + d.getHours()).slice(-2);
	const mm = ("0" + d.getMinutes()).slice(-2);
	const ss = ("0" + d.getSeconds()).slice(-2);
	return "tag-" + y + mo + dd + "-" + hh + mm + ss + "-" + ("000" + TAG_ID_COUNTER).slice(-3);
}
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
function isGhostRun(run, now) {
	if (run.pid !== null && run.pid !== void 0) return false;
	if (run.procGroup && run.procGroup.size > 0) return false;
	if (((now ?? Date.now()) - run.startTs) / 1e3 >= 30) return false;
	const s = run.sampleStats;
	if (!s) return true;
	if (typeof s.utilMax === "number" && s.utilMax >= 10) return false;
	if (typeof s.groupCpuMax === "number" && s.groupCpuMax >= 5) return false;
	return true;
}
//#endregion
//#region lib/types/core/ring.js
/**
* ring-buffer（双条件封顶 + 查询降采样）—— 迁移自 host/index.js §3
*/
function createRing(maxPoints, maxMs) {
	const points = [];
	let capPoints = maxPoints;
	let capMs = maxMs;
	return {
		push(s) {
			points.push(s);
			while (points.length > capPoints || points.length > 1 && points[points.length - 1].ts - points[0].ts > capMs) points.shift();
		},
		expand() {
			capPoints = RING_EXPAND_POINTS;
			capMs = RING_EXPAND_MS;
		},
		size() {
			return points.length;
		},
		history(sinceMs, bucketMs) {
			const bm = bucketMs || 1e4;
			const buckets = [];
			let cur = null;
			for (let i = 0; i < points.length; i++) {
				const p = points[i];
				if (p.ts < sinceMs) continue;
				const bk = Math.floor(p.ts / bm) * bm;
				if (!cur || cur.bucket !== bk) {
					cur = {
						bucket: bk,
						ts: bk,
						gpuUtilSum: 0,
						gpuUtilN: 0,
						gpuMemSum: 0,
						gpuMemN: 0,
						cpuSum: 0,
						cpuN: 0,
						memUsedSum: 0,
						memUsedN: 0,
						groupCpuSum: 0,
						groupCpuN: 0,
						groupMemSum: 0,
						groupMemN: 0
					};
					buckets.push(cur);
				}
				const g = p.gpu && p.gpu.length ? p.gpu[0] : null;
				if (g && typeof g.utilPct === "number") {
					cur.gpuUtilSum += g.utilPct;
					cur.gpuUtilN += 1;
				}
				if (g && typeof g.memUsedMiB === "number") {
					cur.gpuMemSum += g.memUsedMiB;
					cur.gpuMemN += 1;
				}
				if (p.cpuPct !== null && typeof p.cpuPct === "number") {
					cur.cpuSum += p.cpuPct;
					cur.cpuN += 1;
				}
				if (typeof p.memUsedMiB === "number") {
					cur.memUsedSum += p.memUsedMiB;
					cur.memUsedN += 1;
				}
				if (p.group && typeof p.group.cpuPct === "number") {
					cur.groupCpuSum += p.group.cpuPct;
					cur.groupCpuN += 1;
				}
				if (p.group && typeof p.group.memMiB === "number") {
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
				groupMem: b.groupMemN ? Math.round(b.groupMemSum / b.groupMemN) : null
			}));
			if (out.length > 500) out = out.slice(out.length - 500);
			return {
				points: out,
				truncated: out.length >= 500
			};
		}
	};
}
const EXP_TYPES_SET = /* @__PURE__ */ new Set([
	"smoke",
	"regression",
	"full",
	"short",
	"long",
	"gpu-calc",
	"gpu-train",
	"unknown"
]);
function classifyExpType(cmdStr, opts) {
	const c = String(cmdStr || "").trim();
	if (!c) return {
		type: "unknown",
		layer: "unknown"
	};
	const rules = opts?.rules;
	if (rules && rules.length) for (const r of rules) {
		if (!r || typeof r.type !== "string" || !Array.isArray(r.patterns)) continue;
		for (const p of r.patterns) {
			if (typeof p !== "string" || !p) continue;
			try {
				if (new RegExp(p, "i").test(c)) return {
					type: r.type,
					layer: "config"
				};
			} catch {}
		}
	}
	for (const { type, re } of EXP_TYPE_PATTERNS) if (re.test(c)) return {
		type,
		layer: "auto"
	};
	if (matchTrainFeature(c)) return {
		type: "gpu-train",
		layer: "auto"
	};
	if (opts?.learning !== false && opts?.history && opts.history.length) {
		const fp = cmdFingerprint(c);
		const durs = opts.history.filter((h) => h && h.fingerprint === fp && typeof h.durationSec === "number" && h.durationSec > 0).map((h) => h.durationSec).sort((a, b) => a - b);
		if (durs.length >= 2) {
			if (durs[Math.min(durs.length - 1, Math.floor(durs.length * .9))] >= 3600) return {
				type: "long",
				layer: "learn"
			};
		}
	}
	return {
		type: opts?.defaultType || "unknown",
		layer: "unknown"
	};
}
//#endregion
//#region lib/types/core/state-machine.js
/**
* state-machine（实验生命周期：idle/running/done/crashed/alerting/aborted）—— §4
* 迁移自 host/index.js §4，逻辑等价（含 v1.4.3 / v1.4.5 会话内验收实证修正）
*/
/** ps 行解析（Linux/WSL 实验进程视角；与采样 procs 通道解耦）
* 1.2：5 列（pid ppid pcpu rss args，rss KiB→MiB）；兼容 3 列（pid ppid args）、2 列（pid args） */
function parsePs(out) {
	const procs = [];
	if (!out || out.code !== 0 || !out.stdout) return procs;
	const lines = out.stdout.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		const m5 = line.match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S.*)$/);
		if (m5) {
			procs.push({
				pid: parseInt(m5[1], 10),
				ppid: parseInt(m5[2], 10),
				cpuPct: parseFloat(m5[3]),
				memMiB: Math.round(parseInt(m5[4], 10) / 1024),
				cmd: m5[5]
			});
			continue;
		}
		const m3 = line.match(/^(\d+)\s+(\d+)\s+(\S.*)$/);
		if (m3) {
			procs.push({
				pid: parseInt(m3[1], 10),
				ppid: parseInt(m3[2], 10),
				cmd: m3[3]
			});
			continue;
		}
		const m2 = line.match(/^(\d+)\s+(\S.*)$/);
		if (m2) procs.push({
			pid: parseInt(m2[1], 10),
			cmd: m2[2]
		});
	}
	return procs;
}
/** 候选进程存活检测（归一化对比；pyc: 前缀仅标记形态，匹配时剥离；僵尸进程不算存活） */
function findAliveProc(run, procs) {
	if (!procs || !procs.length) return null;
	const fp = run.fingerprint;
	for (let i = 0; i < procs.length; i++) {
		const p = procs[i];
		if (p.cmd && p.cmd.indexOf("<defunct>") !== -1) continue;
		if (run.pid && p.pid === run.pid) return p;
		if (p.cmd && fp) {
			if (fp.startsWith("bin:")) continue;
			const c = normalizeCmdForMatch(p.cmd);
			const mfp = fp.startsWith("pyc:") ? fp.slice(4) : fp.startsWith("pym:") ? fp.slice(4) : fp;
			if (c.indexOf(mfp) !== -1) return p;
		}
	}
	return null;
}
/** 成员与 run 指纹是否匹配（R3：pid 复用防护——同 pid 但 cmd 不符 → 剔除；僵尸进程不算存活） */
function memberMatches(run, p) {
	if (p.cmd && p.cmd.indexOf("<defunct>") !== -1) return false;
	if (run.pid && p.pid === run.pid) return true;
	if (!p.cmd || !run.fingerprint || run.fingerprint.startsWith("bin:")) return false;
	const c = normalizeCmdForMatch(p.cmd);
	const mfp = run.fingerprint.startsWith("pyc:") ? run.fingerprint.slice(4) : run.fingerprint.startsWith("pym:") ? run.fingerprint.slice(4) : run.fingerprint;
	return c.indexOf(mfp) !== -1;
}
function createStateMachine(deps) {
	const state = {
		runs: /* @__PURE__ */ new Map(),
		history: []
	};
	function cur() {
		let latest = null;
		for (const run of state.runs.values()) if (run.state === "running" && (!latest || run.startTs >= latest.startTs)) latest = run;
		return latest;
	}
	function all() {
		const out = [];
		for (const run of state.runs.values()) if (run.state === "running") out.push(run);
		return out;
	}
	function buildSummary(run) {
		const s = run.sampleStats;
		return {
			gpuUtilMax: s && s.utilMax,
			gpuUtilAvg: s && s.utilN ? Math.round(s.utilSum / s.utilN) : null,
			memPeak: s && s.memPeakMiB,
			groupCpuMax: s && s.groupCpuMax !== void 0 ? s.groupCpuMax : null,
			groupMemPeakMiB: s && s.groupMemPeakMiB !== void 0 ? s.groupMemPeakMiB : null,
			otherMemPeakMiB: s && s.otherMemPeakMiB !== void 0 ? s.otherMemPeakMiB : null,
			durationSec: Math.max(0, Math.round(((run.endTs || Date.now()) - run.startTs) / 1e3)),
			dataPartial: !!(deps.ring && deps.ring.size() >= 1 && (run.endTs || Date.now()) - run.startTs > 18e5)
		};
	}
	function archive(run, endReason) {
		run.endTs = Date.now();
		run.endReason = endReason;
		run.state = endReason === "aborted" ? "aborted" : endReason === "switched_away" ? "switched_away" : endReason === "done" ? "done" : "crashed";
		run.summary = run.summary || buildSummary(run);
		state.runs.delete(run.runId);
		state.history.unshift(run);
		if (state.history.length > 20) state.history.length = 20;
		deps.emitLab("lab/experiment-end", {
			runId: run.runId,
			state: run.state,
			endTs: run.endTs,
			summary: run.summary || null,
			type: run.type,
			agentId: run.agentId
		});
	}
	function conclude(run, reason) {
		if (!run || run.state !== "running") return;
		if (reason === "done") archive(run, "done");
		else if (reason === "crashed") {
			archive(run, "crashed");
			deps.emitAlert({
				level: "critical",
				rule: "experiment-crash",
				msg: "实验进程意外退出，无配对 result（可能被 kill 或崩溃）",
				confidence: .9,
				actions: ["检查日志/最近 kill 操作"]
			}, run.runId);
		}
	}
	function start(cmdStr, feature, agent, opts) {
		const running = all();
		if (running.length >= 4) archive(running.reduce((a, b) => a.startTs <= b.startTs ? a : b), "aborted");
		const devId = opts?.deviceId || "local";
		const typeInfo = deps.expType ? classifyExpType(cmdStr, {
			...deps.expType(),
			history: (() => {
				const devHist = state.history.filter((r) => (r.deviceId || "local") === devId);
				return (devHist.length ? devHist : state.history).map((r) => ({
					fingerprint: r.fingerprint,
					durationSec: r.summary && typeof r.summary.durationSec === "number" ? r.summary.durationSec : 0
				}));
			})()
		}) : {
			type: "unknown",
			layer: "unknown"
		};
		const run = {
			runId: makeRunId(),
			cmd: cmdStr,
			cmdFeature: feature,
			pid: null,
			procGroup: null,
			startTs: Date.now(),
			endTs: null,
			state: "running",
			endReason: null,
			resultSeen: false,
			fingerprint: cmdFingerprint(cmdStr),
			deviceId: devId,
			type: typeInfo.type,
			agentId: agent?.agentId ?? null,
			agentRole: agent?.agentRole,
			parentId: agent?.parentId ?? null,
			explicit: opts?.explicit === true,
			graceTicks: 0,
			alerting: false,
			procGone: false,
			pidMissingStreak: 0,
			groupStats: null,
			sampleStats: null
		};
		state.runs.set(run.runId, run);
		if (deps.ring) deps.ring.expand();
		deps.emitLab("lab/experiment-start", {
			runId: run.runId,
			cmd: cmdStr,
			cmdFeature: feature,
			startTs: run.startTs,
			type: run.type,
			expTypeLayer: typeInfo.layer,
			agentId: run.agentId,
			agentRole: run.agentRole
		});
		return run;
	}
	function associateProc(pid, runId) {
		const run = runId && state.runs.has(runId) ? state.runs.get(runId) : cur();
		if (run && pid) {
			if (!run.pid) run.pid = pid;
			if (!run.procGroup) run.procGroup = /* @__PURE__ */ new Set();
			run.procGroup.add(pid);
			run.pidMissingStreak = 0;
		}
	}
	function associatePid(pid, runId) {
		associateProc(pid, runId);
	}
	function markResult(paired, runId) {
		let run = null;
		if (runId && state.runs.has(runId)) run = state.runs.get(runId);
		else if (paired) run = cur();
		if (!run) return;
		if (!paired) return;
		run.resultSeen = true;
		if (run.procGone) conclude(run, "done");
	}
	function tick(aliveProcs) {
		const runs = all();
		if (!runs.length) return;
		for (const run of runs) tickRun(run, aliveProcs);
	}
	function tickRun(run, aliveProcs) {
		const main = findAliveProc(run, aliveProcs);
		const roots = [];
		if (main) roots.push(main.pid);
		else if (run.procGroup) for (const pid of run.procGroup) {
			const p = aliveProcs.find((q) => q.pid === pid);
			if (p && memberMatches(run, p)) roots.push(pid);
		}
		const G = /* @__PURE__ */ new Set();
		const queue = [...roots];
		while (queue.length) {
			const pid = queue.pop();
			if (G.has(pid)) continue;
			G.add(pid);
			for (let i = 0; i < aliveProcs.length; i++) {
				const p = aliveProcs[i];
				if (p.ppid === pid && !G.has(p.pid)) queue.push(p.pid);
			}
		}
		run.procGroup = G;
		if (G.size > 0) {
			if (main) run.pid = main.pid;
			else if (!run.pid) run.pid = roots[0];
			run.pidMissingStreak = 0;
			run.procGone = false;
			run.graceTicks = 0;
			return;
		}
		run.procGone = true;
		if (run.resultSeen) {
			conclude(run, "done");
			return;
		}
		run.pidMissingStreak += 1;
		if (run.pidMissingStreak >= 2) {
			if (!run.explicit && isGhostRun(run)) {
				console.warn("[lab-monitor] 幽灵 run 豁免（无进程/资源活动证据，疑似误判）→ aborted: runId=" + run.runId + " cmd=" + String(run.cmd).slice(0, 80));
				archive(run, "aborted");
				return;
			}
			conclude(run, "crashed");
		}
	}
	function tickGrace(run) {
		if (!run || run.state !== "running" || !run.resultSeen) return;
		run.graceTicks += 1;
		if (run.graceTicks >= 2) conclude(run, "done");
	}
	function setAlerting(on, runId) {
		const run = runId && state.runs.has(runId) ? state.runs.get(runId) : cur();
		if (run) run.alerting = on;
	}
	function toSnapshot(run) {
		return {
			runId: run.runId,
			state: run.alerting ? "alerting" : "running",
			cmd: run.cmd,
			cmdFeature: run.cmdFeature,
			pid: run.pid,
			procGroup: run.procGroup ? [...run.procGroup] : null,
			groupStats: run.groupStats || null,
			startTs: run.startTs,
			summary: null,
			endReason: null,
			type: run.type,
			agentId: run.agentId,
			agentRole: run.agentRole,
			parentId: run.parentId,
			source: run.explicit ? "explicit" : "auto",
			deviceId: run.deviceId || "local",
			swanlab: run.swanlab ? { ...run.swanlab } : void 0
		};
	}
	function toEndedSnapshot(run) {
		return {
			runId: run.runId,
			state: run.state === "done" ? "done" : run.state === "aborted" ? "aborted" : run.state === "switched_away" ? "switched_away" : "crashed",
			cmd: run.cmd,
			cmdFeature: run.cmdFeature,
			startTs: run.startTs,
			endTs: run.endTs,
			summary: run.summary || null,
			type: run.type,
			fingerprint: run.fingerprint,
			agentId: run.agentId,
			source: run.explicit ? "explicit" : "auto",
			deviceId: run.deviceId || "local",
			swanlab: run.swanlab ? { ...run.swanlab } : void 0
		};
	}
	function restoreEnded(snapshots) {
		if (!Array.isArray(snapshots) || !snapshots.length) return;
		const known = new Set(state.history.map((r) => r.runId));
		for (const s of snapshots) {
			if (!s || typeof s.runId !== "string" || known.has(s.runId)) continue;
			if (state.history.length >= 20) break;
			known.add(s.runId);
			state.history.push({
				runId: s.runId,
				cmd: typeof s.cmd === "string" ? s.cmd : null,
				cmdFeature: typeof s.cmdFeature === "string" ? s.cmdFeature : null,
				pid: null,
				procGroup: null,
				startTs: typeof s.startTs === "number" ? s.startTs : 0,
				endTs: typeof s.endTs === "number" ? s.endTs : null,
				state: s.state === "done" ? "done" : s.state === "aborted" ? "aborted" : s.state === "switched_away" ? "switched_away" : "crashed",
				endReason: s.state || null,
				resultSeen: s.state === "done",
				fingerprint: typeof s.fingerprint === "string" ? s.fingerprint : "",
				type: s.type,
				agentId: typeof s.agentId === "string" ? s.agentId : null,
				explicit: s.source === "explicit",
				deviceId: s.deviceId || "local",
				graceTicks: 0,
				alerting: false,
				pidMissingStreak: 0,
				groupStats: null,
				sampleStats: null,
				summary: s.summary && typeof s.summary === "object" ? s.summary : void 0,
				swanlab: s.swanlab && typeof s.swanlab === "object" ? { ...s.swanlab } : void 0
			});
		}
	}
	function markSwanLabSynced(runId, info) {
		const run = state.runs.get(runId) || state.history.find((r) => r.runId === runId);
		if (!run) return false;
		const curStatus = run.swanlab && run.swanlab.status || "pending";
		const nextStatus = info.status || curStatus;
		run.swanlab = {
			...run.swanlab,
			...info,
			status: nextStatus
		};
		return true;
	}
	function removeRun(runId) {
		const idx = state.history.findIndex((r) => r.runId === runId);
		if (idx < 0) return false;
		state.history.splice(idx, 1);
		return true;
	}
	function clearHistory(keep = 0) {
		const n = Math.max(0, Math.min(20, Math.round(keep)));
		const removed = state.history.slice(n);
		state.history.splice(n);
		return removed;
	}
	function switchAwayAll(reason = "switched_away") {
		const list = Array.from(state.runs.values());
		for (const r of list) archive(r, reason);
		return list;
	}
	function snapshot() {
		const runs = all();
		const ended = state.history.map(toEndedSnapshot);
		if (!runs.length) return {
			main: null,
			all: [],
			ended
		};
		return {
			main: toSnapshot(cur()),
			all: runs.map(toSnapshot),
			ended
		};
	}
	return {
		start,
		associatePid,
		associateProc,
		markResult,
		tick,
		tickGrace,
		setAlerting,
		snapshot,
		restoreEnded,
		markSwanLabSynced,
		removeRun,
		clearHistory,
		switchAwayAll,
		cur,
		all,
		history: state.history
	};
}
//#endregion
//#region lib/types/core/balancer.js
/**
* balancer（纯代码平衡引擎：诊断 + 归属仲裁 + 分级防抖）—— §5
* 1.2（进程级跟踪 Phase C）：
*   - 规则输入从「全系统首卡」升级为「实验进程组 G 自身 + GPU 整卡交叉验证 + 归属仲裁」
*   - oom 三分支：G 活跃 → critical；G 不活跃 → 降级 warn「疑似他人占用」；无实验 → other-occupancy
*   - io-bottleneck：实验组 CPU 满载 + GPU 空闲为主判；G.cpuPct 不可得（Windows）降级整机
*   - thermal：整卡物理量 + G 活跃度上下文
*   - Alert.evidence：进程级证据（CPU/内存为主，GPU 每进程辅助）
* + thresholds（host 内存事实来源；M3 last-write-wins）—— §6
*/
function createThresholds() {
	const t = { ...THRESHOLD_DEFAULTS };
	let overrides = {};
	let appliedAt = 0;
	return {
		get() {
			return {
				utilWarn: t.utilWarn,
				memWarn: t.memWarn,
				tempWarn: t.tempWarn,
				pollMs: t.pollMs,
				procTopN: t.procTopN,
				wGpu: t.wGpu,
				wCpu: t.wCpu,
				wMem: t.wMem
			};
		},
		effectiveTimestamp() {
			return appliedAt;
		},
		apply(patch, isDirect) {
			if (!patch || typeof patch !== "object") return false;
			if (!isDirect && Date.now() < appliedAt) return false;
			const keys = [
				"utilWarn",
				"memWarn",
				"tempWarn",
				"pollMs",
				"procTopN",
				"wGpu",
				"wCpu",
				"wMem"
			];
			let changed = false;
			for (let n = 0; n < keys.length; n++) {
				const k = keys[n];
				if (typeof patch[k] === "number" && isFinite(patch[k])) {
					t[k] = patch[k];
					changed = true;
				}
			}
			if (changed) appliedAt = Date.now();
			return changed;
		},
		setOverrides(o) {
			overrides = o && typeof o === "object" ? o : {};
		},
		getOverrides() {
			return overrides;
		}
	};
}
/** #13-3 差异化阈值：解析当前生效阈值——覆盖链 全局 → 实验类型 → 标签组（后级覆盖前级同名键） */
function resolveThresholds(w, thr, overrides) {
	const ov = { ...thr };
	const byExp = overrides.byExpType || {};
	const byTag = overrides.byTag || {};
	if (w.experimentType && byExp[w.experimentType]) Object.assign(ov, byExp[w.experimentType]);
	if (w.tagHits && w.tagHits.length) {
		for (const label of w.tagHits) if (byTag[label]) Object.assign(ov, byTag[label]);
	}
	return ov;
}
function fmtGiB(mib) {
	if (!Number.isFinite(mib)) return "0";
	const g = mib / 1024;
	return g >= 100 ? String(Math.round(g)) : String(Math.round(g * 10) / 10);
}
/** 实验组活跃度判据（CPU/内存/存在性为主，pmon 为辅——设计 §2.3 队长约束） */
function groupActive(gs) {
	if (!gs || gs.memberCount <= 0) return false;
	if (gs.cpuPct !== null && gs.cpuPct >= 30) return true;
	if (gs.memMiB !== null && gs.memMiB >= 2048) return true;
	if (gs.gpuUtilPct !== null && gs.gpuUtilPct !== void 0 && gs.gpuUtilPct >= 30) return true;
	return false;
}
/** M1（issue#5 §1.4 trend=falling）：提取 rule 的触发指标（窗口首尾对比用）——
*  返回 null 表示该 rule 无单体指标（如 imbalance 多卡差、io 无单体）→ 不做回落判断（视为 steady）。
*  metric 值越大 = 越严重；末值 < 首值×0.9 → falling（缓解中）。 */
function metricOf(rule) {
	const gpuOf = (w) => w.gpu && w.gpu.length ? w.gpu[0] : null;
	switch (rule) {
		case "oom":
		case "other-occupancy": return (w) => {
			const g = gpuOf(w);
			if (!g || !g.memTotalMiB) return null;
			return g.memUsedMiB / g.memTotalMiB * 100;
		};
		case "thermal": return (w) => {
			const g = gpuOf(w);
			return g && typeof g.tempC === "number" ? g.tempC : null;
		};
		case "imbalance": return (w) => {
			if (!w.gpu || w.gpu.length < 2) return null;
			const us = w.gpu.map((g) => g.utilPct);
			return Math.max(...us) - Math.min(...us);
		};
		case "io-bottleneck": return (w) => {
			const g = gpuOf(w);
			return g ? g.utilPct : null;
		};
		default: return () => null;
	}
}
/** 进程证据（告警触发时附 Top 相关进程；实验组内优先，系统其他补充）
* 1.2 增强：WSL 双 pid 空间下，SamplePoint.procs 是 backend procs（tasklist，Windows 侧）——
* 补充 Windows 侧 GPU 占卡进程（llama-server.exe/vmmemWSL 等）到 evidence，弥补 system.topN 的 Linux 侧局限 */
function evidenceOf(w, preferGroup) {
	const list = [];
	if (preferGroup && w.group && w.group.members.length) list.push(...w.group.members.slice(0, 3));
	if (w.system && w.system.topN.length) list.push(...w.system.topN.slice(0, preferGroup ? 2 : 5));
	const gp = w.group ? w.group.members : [];
	const others = (w.procs || []).filter((p) => !gp.some((m) => m.pid === p.pid)).sort((a, b) => (b.memMiB ?? 0) - (a.memMiB ?? 0)).slice(0, preferGroup ? 2 : 3);
	for (let i = 0; i < others.length; i++) {
		const p = others[i];
		list.push({
			pid: p.pid,
			cmd: p.cmd ?? null,
			cpuPct: typeof p.cpuPct === "number" ? p.cpuPct : null,
			memMiB: typeof p.memMiB === "number" ? p.memMiB : null,
			gpuUtilPct: typeof p.gpuUtilPct === "number" ? p.gpuUtilPct : null
		});
	}
	return list.length ? { procs: list.slice(0, 5) } : void 0;
}
const RULES = [
	{
		rule: "oom",
		level: "critical",
		check(w, thr) {
			const g = w.gpu && w.gpu.length ? w.gpu[0] : null;
			if (!g || !g.memTotalMiB) return { ok: false };
			const usedPct = g.memUsedMiB / g.memTotalMiB * 100;
			if (usedPct < thr.memWarn) return { ok: false };
			const gs = w.group;
			const expActive = !!w.experimentActive;
			const memStr = fmtGiB(g.memUsedMiB) + "/" + fmtGiB(g.memTotalMiB);
			const otherN = w.system && w.system.topN ? w.system.topN.length : 0;
			const otherTop = w.system && w.system.topN[0] ? w.system.topN[0] : null;
			if (expActive && gs && gs.memberCount > 0) {
				const active = groupActive(gs);
				const ev = evidenceOf(w, true);
				if (active) return {
					ok: true,
					level: "critical",
					msg: `整卡显存 ${Math.round(usedPct)}%（${memStr}G）达阈值；实验进程组活跃（${gs.memberCount} 进程，CPU ${gs.cpuPct ?? "-"}%，内存 ${gs.memMiB ?? "-"}MiB）`,
					actions: ["降低 batch size", "检查实验进程内存占用"],
					evidence: ev
				};
				return {
					ok: true,
					level: "warn",
					msg: `整卡显存 ${Math.round(usedPct)}%（${memStr}G）达阈值但实验进程活跃度低（CPU ${gs.cpuPct ?? "-"}%，内存 ${gs.memMiB ?? "-"}MiB），系统其他 ${otherN} 进程占卡，疑似他人负载`,
					actions: [otherTop ? `检查 pid ${otherTop.pid} (${otherTop.cmd || "?"}) 等其他进程占卡` : "检查系统其他进程占卡"],
					evidence: ev
				};
			}
			return { ok: false };
		},
		msg: "显存占用超阈值且利用率高，存在 OOM 风险",
		actions: ["降低 batch size", "关闭其他占用显存的进程"],
		severity: 4,
		urgencyBase: 2,
		resource: "vram",
		origin: "self"
	},
	{
		rule: "io-bottleneck",
		level: "warn",
		check(w, thr) {
			const g = w.gpu && w.gpu.length ? w.gpu[0] : null;
			if (!g || g.utilPct === null || g.utilPct >= 30) return { ok: false };
			if (!w.experimentActive) return { ok: false };
			if (w.experimentType && !w.experimentType.includes("gpu") && w.experimentType !== "full" && w.experimentType !== "long") return { ok: false };
			const gs = w.group;
			if (gs && gs.cpuPct !== null) {
				if (gs.cpuPct < 90) return { ok: false };
				return {
					ok: true,
					msg: `实验进程组 CPU ${gs.cpuPct}% 满载且 GPU 利用率 ${g.utilPct}% 低，疑似数据管线瓶颈`,
					actions: ["增加 num_workers", "检查数据管线磁盘 IO"],
					evidence: evidenceOf(w, true)
				};
			}
			if (w.cpuPct !== null && w.cpuPct >= 90) return {
				ok: true,
				msg: `GPU 利用率 ${g.utilPct}% 低但全机 CPU ${w.cpuPct}% 满载（无法按进程拆分 CPU，基于全机判断）`,
				actions: ["增加 num_workers", "检查数据管线磁盘 IO"],
				evidence: evidenceOf(w, false)
			};
			return { ok: false };
		},
		msg: "GPU 利用率低但 CPU 满载，疑似数据加载瓶颈",
		actions: ["增加 num_workers", "检查数据管线磁盘 IO"],
		severity: 3,
		urgencyBase: 2,
		resource: "io",
		origin: "self"
	},
	{
		rule: "thermal",
		level: "warn",
		check(w, thr) {
			const g = w.gpu && w.gpu.length ? w.gpu[0] : null;
			if (!g || typeof g.tempC !== "number" || g.tempC < thr.tempWarn) return { ok: false };
			const gs = w.group;
			const act = gs ? `实验进程组活跃度 CPU ${gs.cpuPct ?? "-"}%/内存 ${gs.memMiB ?? "-"}MiB` : "无实验";
			return {
				ok: true,
				msg: `GPU 温度 ${g.tempC}°C 达阈值（整卡物理量；${act}——若实验进程活跃度低则非实验负载引起）`,
				actions: ["降低功耗目标", "检查散热/风扇"],
				evidence: evidenceOf(w, true)
			};
		},
		msg: "GPU 温度接近墙值，存在降频风险",
		actions: ["降低功耗目标", "检查散热/风扇"],
		severity: 4,
		urgencyBase: 2,
		resource: "temp",
		origin: "self"
	},
	{
		rule: "imbalance",
		level: "info",
		check(w) {
			if (!w.gpu || w.gpu.length < 2) return { ok: false };
			const us = w.gpu.map((g) => g.utilPct);
			return { ok: Math.max(...us) - Math.min(...us) >= 40 };
		},
		msg: "多 GPU 负载不均",
		actions: ["调整 batch/流水线分配", "检查 DDP 数据切分"],
		severity: 2,
		urgencyBase: 1,
		resource: "gpu-util",
		origin: "self"
	},
	{
		rule: "other-occupancy",
		level: "info",
		check(w, thr) {
			const g = w.gpu && w.gpu.length ? w.gpu[0] : null;
			if (!g || !g.memTotalMiB) return { ok: false };
			const usedPct = g.memUsedMiB / g.memTotalMiB * 100;
			if (usedPct < thr.memWarn || w.experimentActive) return { ok: false };
			const gp = w.group ? w.group.members : [];
			const gpuCandidates = (w.procs || []).filter((p) => !gp.some((m) => m.pid === p.pid) && typeof p.gpuUtilPct === "number" && p.gpuUtilPct > 0).sort((a, b) => (b.gpuUtilPct ?? 0) - (a.gpuUtilPct ?? 0));
			const memCandidates = (w.procs || []).filter((p) => !gp.some((m) => m.pid === p.pid) && !(typeof p.gpuUtilPct === "number" && p.gpuUtilPct > 0)).sort((a, b) => (b.memMiB ?? 0) - (a.memMiB ?? 0));
			const topStat = [...gpuCandidates, ...memCandidates].slice(0, 3).map((p) => ({
				pid: p.pid,
				cmd: p.cmd ?? null,
				cpuPct: typeof p.cpuPct === "number" ? p.cpuPct : null,
				memMiB: typeof p.memMiB === "number" ? p.memMiB : null,
				gpuUtilPct: typeof p.gpuUtilPct === "number" ? p.gpuUtilPct : null
			}));
			const topStr = topStat.length ? "（Top: " + topStat.map((p) => p.pid + " " + (p.cmd || "?")).join(", ") + "）" : "";
			return {
				ok: true,
				msg: `当前无实验但 GPU 显存占用 ${Math.round(usedPct)}%（${fmtGiB(g.memUsedMiB)}/${fmtGiB(g.memTotalMiB)}G），系统其他进程占卡${topStr}`,
				actions: [topStat[0] ? `检查 pid ${topStat[0].pid} (${topStat[0].cmd || "?"}) 等占卡进程` : "检查系统其他进程占卡"],
				evidence: { procs: topStat.slice(0, 5) }
			};
		},
		msg: "当前无实验但 GPU 显存被系统其他进程占用",
		actions: ["检查系统其他进程占卡"],
		severity: 2,
		urgencyBase: 1,
		resource: "vram",
		origin: "other"
	}
];
const MIN_HITS = Math.max(1, Math.round(1e4 / SAMPLE_MS));
const MIN_INTERVAL_MS = 3e5;
/** 告警 TTL（2026-08-22：告警生命周期——超过 24h 的旧告警自动过期，不再永久堆积污染 badge/advice） */
const ALERT_TTL_MS = 864e5;
/** M1（issue#5）：trend 由持续时长映射——≥30s 视为 steady（持续），<30s 视为 rising（刚过防抖线） */
const TREND_STEADY_MS = 3e4;
function createBalancer(deps) {
	const alerts = [];
	let criticalCount = 0;
	const hitByRule = {};
	const lastByRule = {};
	/** 2026-08-22：过期清理——alerts 倒序存放（unshift 最新到头、尾部最旧），
	* 尾部连续超过 TTL 的旧告警弹出，同步扣减 criticalCount（count 只统计未过期告警）。
	* O(1) 均摊（通常尾部 0~1 条过期）。 */
	function pruneExpired() {
		if (!alerts.length) return { removed: 0 };
		const now = Date.now();
		let removed = 0;
		while (alerts.length) {
			const last = alerts[alerts.length - 1];
			if (now - last.ts <= ALERT_TTL_MS) break;
			alerts.pop();
			if (last.level === "critical") criticalCount = Math.max(0, criticalCount - 1);
			removed += 1;
		}
		return { removed };
	}
	/** 2026-08-22：容量截断（alerts.length > ALERT_MAX 时丢最旧）——同步扣减被截 critical 计数 */
	function truncate() {
		if (alerts.length <= 20) return;
		const dropped = alerts.slice(20);
		for (let i = 0; i < dropped.length; i++) if (dropped[i].level === "critical") criticalCount = Math.max(0, criticalCount - 1);
		alerts.length = 20;
	}
	function clear(filter) {
		pruneExpired();
		let cleared = 0;
		if (filter && (filter.runId || filter.rule)) {
			const keep = [];
			let removedCritical = 0;
			for (let i = 0; i < alerts.length; i++) {
				const a = alerts[i];
				if (filter.runId && a.runId === filter.runId || filter.rule && a.rule === filter.rule) {
					cleared += 1;
					if (a.level === "critical") removedCritical += 1;
				} else keep.push(a);
			}
			if (cleared) {
				alerts.length = 0;
				for (let i = 0; i < keep.length; i++) alerts.push(keep[i]);
				criticalCount = Math.max(0, criticalCount - removedCritical);
			}
		} else {
			cleared = alerts.length;
			alerts.length = 0;
			criticalCount = 0;
		}
		return {
			cleared,
			remaining: alerts.length,
			criticalCount
		};
	}
	function setNotifyLevel(runId, rule, level) {
		let written = 0;
		for (let i = 0; i < alerts.length; i++) {
			const a = alerts[i];
			if (a.rule !== rule) continue;
			if (a.runId !== runId) continue;
			a.notifyLevel = level;
			written += 1;
			break;
		}
		return written;
	}
	function evaluate(windowSnaps, runId) {
		if (!windowSnaps || !windowSnaps.length) return [];
		const w = windowSnaps[windowSnaps.length - 1];
		const thr = resolveThresholds(w, deps.thresholds(), deps.thresholdOverrides());
		const out = [];
		for (let i = 0; i < RULES.length; i++) {
			const R = RULES[i];
			let res = { ok: false };
			try {
				res = R.check(w, thr);
			} catch (e) {}
			if (!res.ok) {
				hitByRule[R.rule] = 0;
				continue;
			}
			hitByRule[R.rule] = (hitByRule[R.rule] || 0) + 1;
			const hitCount = hitByRule[R.rule];
			const sustainedMs = hitCount * SAMPLE_MS;
			const wFirst = windowSnaps && windowSnaps.length ? windowSnaps[0] : w;
			const wLast = w;
			const metric = metricOf(R.rule);
			const mFirst = metric(wFirst);
			const mLast = metric(wLast);
			const trend = typeof mFirst === "number" && typeof mLast === "number" && mFirst > 0 && mLast < mFirst * .9 ? "falling" : sustainedMs < TREND_STEADY_MS ? "rising" : "steady";
			if (hitCount < MIN_HITS) continue;
			const now = Date.now();
			if (lastByRule[R.rule] && now - lastByRule[R.rule] < MIN_INTERVAL_MS) continue;
			lastByRule[R.rule] = now;
			hitByRule[R.rule] = 0;
			const level = res.level || R.level;
			const escalate = level === "warn" && deps.escalateAfterMs() > 0 && sustainedMs >= deps.escalateAfterMs();
			const origin = R.origin === "other" ? "other" : level === "warn" && R.rule === "oom" && res.level === "warn" ? "other" : R.origin;
			const alert = {
				level,
				rule: R.rule,
				msg: res.msg || R.msg,
				confidence: level === "critical" ? .85 : .7,
				actions: res.actions || R.actions,
				evidence: res.evidence,
				ts: now,
				runId: runId || null,
				severity: R.severity,
				urgency: Math.min(3, R.urgencyBase + (trend === "rising" ? 1 : 0)),
				trend,
				sustainedMs,
				resource: R.resource,
				origin,
				notifyLevel: void 0,
				escalate: escalate || void 0
			};
			alerts.unshift(alert);
			if (alert.level === "critical") criticalCount += 1;
			truncate();
			deps.emitLab("lab/alert", {
				level: alert.level,
				rule: alert.rule,
				msg: alert.msg,
				confidence: alert.confidence,
				actions: alert.actions,
				evidence: alert.evidence,
				severity: alert.severity,
				urgency: alert.urgency,
				trend: alert.trend,
				sustainedMs: alert.sustainedMs,
				resource: alert.resource,
				origin: alert.origin,
				escalate: alert.escalate
			});
			out.push(alert);
		}
		return out;
	}
	function snapshotAlerts() {
		pruneExpired();
		return alerts.slice(0, 10);
	}
	function pushExternal(alert) {
		const isCrash = alert.rule === "experiment-crash" || (alert.msg || "").indexOf("意外退出") !== -1;
		const a = {
			level: alert.level || "warn",
			rule: alert.rule || "external",
			msg: alert.msg || "",
			confidence: alert.confidence !== void 0 && alert.confidence !== null ? alert.confidence : .9,
			actions: Array.isArray(alert.actions) ? alert.actions : [],
			evidence: alert.evidence,
			ts: Date.now(),
			runId: alert.runId || null,
			severity: alert.severity ?? (isCrash ? 5 : 3),
			urgency: alert.urgency ?? (isCrash ? 3 : 2),
			trend: alert.trend ?? "steady",
			sustainedMs: alert.sustainedMs ?? 0,
			resource: alert.resource ?? "process",
			origin: alert.origin ?? "self",
			notifyLevel: alert.notifyLevel,
			escalate: alert.escalate
		};
		alerts.unshift(a);
		if (a.level === "critical") criticalCount += 1;
		truncate();
		return a;
	}
	function advice() {
		pruneExpired();
		return {
			advice: alerts.slice(0, 5).map((a) => ({
				level: a.level,
				rule: a.rule,
				msg: a.msg,
				confidence: a.confidence,
				actions: a.actions,
				evidence: a.evidence,
				runId: a.runId,
				severity: a.severity,
				urgency: a.urgency,
				trend: a.trend,
				sustainedMs: a.sustainedMs,
				resource: a.resource,
				origin: a.origin,
				notifyLevel: a.notifyLevel,
				escalate: a.escalate
			})),
			generatedAt: Date.now()
		};
	}
	return {
		evaluate,
		snapshotAlerts,
		advice,
		count: () => {
			pruneExpired();
			return criticalCount;
		},
		pushExternal,
		clear,
		setNotifyLevel
	};
}
//#endregion
//#region lib/types/core/proc-aggregator.js
const TOP_N = 5;
/** ProcSample → ProcStat（GPU 每进程仅在有值（pmon 活动进程）时附） */
function toProcStat(p) {
	return {
		pid: p.pid,
		cmd: p.cmd ?? null,
		cpuPct: typeof p.cpuPct === "number" ? p.cpuPct : null,
		memMiB: typeof p.memMiB === "number" ? p.memMiB : null,
		gpuUtilPct: typeof p.gpuUtilPct === "number" ? p.gpuUtilPct : null
	};
}
/** 数值求和（2026-08-20：`Number.isFinite` 取代 `typeof number`——NaN 也会通过 typeof 检查并
* 污染聚合结果，直达工具输出破坏 lossless JSON 校验）。 */
function sumCpu(ps) {
	let s = 0;
	let n = 0;
	for (let i = 0; i < ps.length; i++) {
		const v = ps[i].cpuPct;
		if (typeof v === "number" && Number.isFinite(v)) {
			s += v;
			n += 1;
		}
	}
	return n ? Math.round(s * 10) / 10 : null;
}
function sumMem(ps) {
	let s = 0;
	let n = 0;
	for (let i = 0; i < ps.length; i++) {
		const v = ps[i].memMiB;
		if (typeof v === "number" && Number.isFinite(v)) {
			s += v;
			n += 1;
		}
	}
	return n ? Math.round(s) : null;
}
function sumGpu(ps) {
	let s = 0;
	let n = 0;
	for (let i = 0; i < ps.length; i++) {
		const v = ps[i].gpuUtilPct;
		if (typeof v === "number" && Number.isFinite(v)) {
			s += v;
			n += 1;
		}
	}
	return n ? Math.min(Math.round(s * 10) / 10, 100) : null;
}
/** 拆分聚合：G（实验进程组） vs 非 G（系统其他进程） */
function aggregateProcStats(input) {
	const groupSet = input.runActive && input.group ? input.group : null;
	const members = [];
	const others = [];
	for (let i = 0; i < input.procs.length; i++) {
		const p = input.procs[i];
		const stat = toProcStat(p);
		if (groupSet && groupSet.has(p.pid)) members.push(stat);
		else others.push(stat);
	}
	let group = null;
	if (groupSet) group = {
		cpuPct: sumCpu(members),
		memMiB: sumMem(members),
		memberCount: members.length,
		alive: members.length > 0,
		gpuUtilPct: sumGpu(members),
		gpuMemMiB: null,
		members: members.slice(0, 20)
	};
	others.sort((a, b) => (b.memMiB ?? 0) - (a.memMiB ?? 0) || (b.cpuPct ?? 0) - (a.cpuPct ?? 0));
	const system = {
		cpuPct: sumCpu(others),
		memMiB: sumMem(others),
		gpuUtilPct: sumGpu(others),
		gpuMemMiB: null,
		topN: others.slice(0, TOP_N)
	};
	return {
		group,
		system
	};
}
//#endregion
//#region lib/types/sync/swanlab.js
/**
* SwanLab 按需同步模块（写入通道、脱敏、Ring 降级、门控与并发锁）
*/
const activeSyncLocks = /* @__PURE__ */ new Set();
function acquireSyncLock(runId) {
	if (activeSyncLocks.has(runId)) return false;
	activeSyncLocks.add(runId);
	return true;
}
function releaseSyncLock(runId) {
	activeSyncLocks.delete(runId);
}
/**
* 脱敏命令行中的 token, api_key, password, secret 等敏感参数
*/
function sanitizeCmd(cmd) {
	if (!cmd || typeof cmd !== "string") return "";
	let sanitized = cmd;
	sanitized = sanitized.replace(/(https?:\/\/)[^:\s]+:[^@\s]+@/gi, "$1***:***@");
	sanitized = sanitized.replace(/\b(bearer\s+)[a-zA-Z0-9_\-\.]+/gi, "$1***");
	sanitized = sanitized.replace(/(--(?:token|api[-_]?key|apikey|secret(?:[-_]?key)?|password|auth[-_]?token|access[-_]?token))([=\s])(["']?)[^"'\s]+\3/gi, "$1$2***");
	sanitized = sanitized.replace(/(-p\s+)(["']?)[^"'\s]+\2/gi, "$1***");
	sanitized = sanitized.replace(/\b([a-zA-Z0-9_-]*(?:token|api[-_]?key|secret|password)[a-zA-Z0-9_-]*)\s*(=|:\s*)(["']?)[^"'\s]+\3/gi, "$1$2***");
	return sanitized;
}
function matchSyncConditions(run, conditions, tagHits) {
	if (!conditions) return { matched: true };
	if (conditions.allowedStates && conditions.allowedStates.length > 0) {
		if (!conditions.allowedStates.includes(run.state)) return {
			matched: false,
			reason: `run state "${run.state}" is not in allowedStates [${conditions.allowedStates.join(", ")}]`
		};
	}
	if (typeof conditions.minDurationSec === "number" && conditions.minDurationSec > 0) {
		const durSec = run.summary && typeof run.summary.durationSec === "number" ? run.summary.durationSec : run.endTs ? Math.max(0, Math.round((run.endTs - run.startTs) / 1e3)) : 0;
		if (durSec < conditions.minDurationSec) return {
			matched: false,
			reason: `run duration (${durSec}s) is less than minDurationSec (${conditions.minDurationSec}s)`
		};
	}
	if (conditions.includeTypes && conditions.includeTypes.length > 0) {
		const runType = run.type || "unknown";
		if (!conditions.includeTypes.includes(runType)) return {
			matched: false,
			reason: `run type "${runType}" is not in includeTypes [${conditions.includeTypes.join(", ")}]`
		};
	}
	if (conditions.requireTags && conditions.requireTags.length > 0) {
		const hits = tagHits || [];
		if (!conditions.requireTags.some((t) => hits.includes(t))) return {
			matched: false,
			reason: `run tags [${hits.join(", ")}] do not match requireTags [${conditions.requireTags.join(", ")}]`
		};
	}
	return { matched: true };
}
async function checkSwanLabAvailable(pythonBin = "python3") {
	return new Promise((resolve) => {
		execFile(pythonBin, ["-c", "import swanlab"], { timeout: 1e4 }, (error, _stdout, stderr) => {
			if (error) resolve({
				available: false,
				error: `SwanLab dependency check failed: Python package "swanlab" is not installed. Please install it with "pip install swanlab". (${(stderr || error.message || "").trim()})`
			});
			else resolve({ available: true });
		});
	});
}
/**
* 提取时间窗口内历史点并生成 SwanLab 标量指标
* 若点数不足或被 Ring 覆盖，降级为 summary-only 上报，标记 seriesAvailable: false
*/
function extractMetricsForRun(run, ring) {
	const s = run.summary;
	const durationSec = s && typeof s.durationSec === "number" ? s.durationSec : run.endTs ? Math.max(0, Math.round((run.endTs - run.startTs) / 1e3)) : 0;
	const summary = {
		gpuUtilMax: s && typeof s.gpuUtilMax === "number" ? s.gpuUtilMax : null,
		gpuUtilAvg: s && typeof s.gpuUtilAvg === "number" ? s.gpuUtilAvg : null,
		memPeak: s && typeof s.memPeak === "number" ? s.memPeak : null,
		groupCpuMax: s && typeof s.groupCpuMax === "number" ? s.groupCpuMax : null,
		durationSec
	};
	if (!ring || ring.size() === 0 || s?.dataPartial === true) return {
		seriesAvailable: false,
		series: [],
		summary
	};
	const hist = ring.history(run.startTs, 1e4);
	const endTs = run.endTs || Date.now();
	const pts = (hist.points || []).filter((p) => p.ts >= run.startTs && p.ts <= endTs + 1e4);
	if (pts.length < 2) return {
		seriesAvailable: false,
		series: [],
		summary
	};
	const series = [];
	for (const p of pts) {
		const step = Math.round((p.ts - run.startTs) / 1e4);
		const metrics = {};
		if (typeof p.gpuUtil === "number") metrics["lab-monitor/gpu.util"] = p.gpuUtil;
		if (typeof p.gpuMem === "number") metrics["lab-monitor/gpu.mem"] = p.gpuMem;
		if (typeof p.cpu === "number") metrics["lab-monitor/cpu.util"] = p.cpu;
		if (typeof p.memUsed === "number") metrics["lab-monitor/mem.used"] = p.memUsed;
		if (typeof p.groupCpu === "number") metrics["lab-monitor/group.cpu"] = p.groupCpu;
		if (typeof p.groupMem === "number") metrics["lab-monitor/group.mem"] = p.groupMem;
		if (Object.keys(metrics).length > 0) series.push({
			step,
			metrics
		});
	}
	if (series.length === 0) return {
		seriesAvailable: false,
		series: [],
		summary
	};
	return {
		seriesAvailable: true,
		series,
		summary
	};
}
const EMBEDDED_WORKER_SCRIPT = `#!/usr/bin/env python3
import sys, os, json

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "Missing input payload file"}))
        sys.exit(1)
    try:
        with open(sys.argv[1], "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        print(json.dumps({"success": False, "error": f"Failed to parse payload: {e}"}))
        sys.exit(1)
    try:
        import swanlab
    except ImportError as e:
        print(json.dumps({"success": False, "error": f"swanlab is not installed: {e}"}))
        sys.exit(1)

    api_key = data.get("apiKey")
    project = data.get("project") or "lab-monitor"
    workspace = data.get("workspace")
    log_dir = data.get("logDir")
    mode = data.get("mode") or ("cloud" if api_key else "local")
    experiment_name = data.get("experimentName")
    description = data.get("description")
    config = data.get("config") or {}
    series_available = bool(data.get("seriesAvailable"))
    series = data.get("series") or []
    summary = data.get("summary") or {}

    if api_key:
        try:
            swanlab.login(api_key=api_key, save=False)
        except Exception as e:
            print(json.dumps({"success": False, "error": f"SwanLab login failed: {e}"}))
            sys.exit(1)

    init_kwargs = {
        "project": project,
        "name": experiment_name,
        "description": description,
        "config": config,
    }
    if log_dir:
        init_kwargs["log_dir"] = log_dir
    if workspace:
        init_kwargs["workspace"] = workspace
    if mode in ("local", "offline", "disabled"):
        init_kwargs["mode"] = mode

    run = None
    try:
        run = swanlab.init(**init_kwargs)
        if series_available and isinstance(series, list):
            for item in series:
                step = item.get("step")
                metrics = item.get("metrics")
                if metrics and isinstance(metrics, dict):
                    if step is not None:
                        swanlab.log(metrics, step=int(step))
                    else:
                        swanlab.log(metrics)

        summary_metrics = {}
        if summary.get("gpuUtilMax") is not None:
            summary_metrics["lab-monitor/summary.gpu_util_max"] = summary["gpuUtilMax"]
        if summary.get("gpuUtilAvg") is not None:
            summary_metrics["lab-monitor/summary.gpu_util_avg"] = summary["gpuUtilAvg"]
        if summary.get("memPeak") is not None:
            summary_metrics["lab-monitor/summary.mem_peak"] = summary["memPeak"]
        if summary.get("groupCpuMax") is not None:
            summary_metrics["lab-monitor/summary.group_cpu_max"] = summary["groupCpuMax"]
        if summary.get("durationSec") is not None:
            summary_metrics["lab-monitor/summary.duration_sec"] = summary["durationSec"]

        if summary_metrics:
            swanlab.log(summary_metrics)

        run_id = getattr(run, "id", None)
        run_url = None
        try:
            run_url = getattr(run, "url", None) or getattr(run, "public_url", None)
        except Exception:
            pass
        if not run_url and run_id and workspace:
            run_url = f"https://swanlab.cn/@{workspace}/{project}/runs/{run_id}"

        swanlab.finish()
        print(json.dumps({"success": True, "runId": run_id, "runUrl": run_url}))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    main()
`;
async function resolveWorkerScript(customPath) {
	if (customPath && fs$1.existsSync(customPath)) return {
		scriptPath: customPath,
		isTemp: false
	};
	try {
		const curFile = fileURLToPath(import.meta.url);
		const curDir = path.dirname(curFile);
		const candidates = [
			path.resolve(curDir, "../../scripts/swanlab-sync-worker.py"),
			path.resolve(curDir, "../scripts/swanlab-sync-worker.py"),
			path.resolve(process.cwd(), "scripts/swanlab-sync-worker.py")
		];
		for (const cand of candidates) if (fs$1.existsSync(cand)) return {
			scriptPath: cand,
			isTemp: false
		};
	} catch (_e) {}
	const tempScript = path.join(os.tmpdir(), `swanlab_worker_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.py`);
	await fs$1.promises.writeFile(tempScript, EMBEDDED_WORKER_SCRIPT, { mode: 493 });
	return {
		scriptPath: tempScript,
		isTemp: true
	};
}
/**
* 触发单个实验上报 SwanLab
*/
async function syncRunToSwanLab(run, options = {}) {
	const runId = run.runId;
	if (!acquireSyncLock(runId)) return {
		ok: false,
		status: "syncing",
		error: `Sync already in progress for run ${runId}`,
		skipped: true
	};
	let tempPayloadPath = null;
	let tempWorkerPath = null;
	const tempLogDir = path.join(options.customLogDir || os.tmpdir(), `swanlog_${runId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
	try {
		if (!options.force) {
			const match = matchSyncConditions(run, options.config?.conditions, options.activeTags);
			if (!match.matched) return {
				ok: false,
				error: match.reason,
				skipped: true
			};
		}
		options.stateMachine?.markSwanLabSynced(runId, {
			status: "syncing",
			attemptTs: Date.now()
		});
		const pythonBin = options.pythonBin || "python3";
		if (!options.skipDepCheck) {
			const dep = await checkSwanLabAvailable(pythonBin);
			if (!dep.available) {
				const errMsg = dep.error || "swanlab not installed";
				options.stateMachine?.markSwanLabSynced(runId, {
					status: "failed",
					attemptTs: Date.now(),
					error: errMsg
				});
				if (options.persistState) await options.persistState();
				return {
					ok: false,
					status: "failed",
					error: errMsg
				};
			}
		}
		const { seriesAvailable, series, summary } = extractMetricsForRun(run, options.ring);
		const experimentName = `[lab-monitor] ${run.fingerprint || "run"}-${run.startTs}`;
		const sanitizedCmd = sanitizeCmd(run.cmd);
		const payload = {
			apiKey: options.config?.apiKey || process.env.SWANLAB_API_KEY || "",
			project: options.config?.project || "lab-monitor",
			workspace: options.config?.workspace,
			logDir: tempLogDir,
			mode: options.config?.apiKey || process.env.SWANLAB_API_KEY ? "cloud" : "local",
			experimentName,
			description: `lab-monitor auto-synced run ${runId} (type: ${run.type || "unknown"}, state: ${run.state})`,
			config: {
				runId,
				deviceId: run.deviceId || "local",
				cmd: sanitizedCmd,
				state: run.state,
				type: run.type || "unknown",
				startTs: run.startTs,
				endTs: run.endTs,
				durationSec: summary.durationSec,
				seriesAvailable
			},
			seriesAvailable,
			series,
			summary
		};
		tempPayloadPath = path.join(os.tmpdir(), `swanlab_payload_${runId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.json`);
		await fs$1.promises.writeFile(tempPayloadPath, JSON.stringify(payload), "utf-8");
		const workerInfo = await resolveWorkerScript(options.workerScriptPath);
		if (workerInfo.isTemp) tempWorkerPath = workerInfo.scriptPath;
		const execResult = await new Promise((resolve) => {
			execFile(pythonBin, [workerInfo.scriptPath, tempPayloadPath], { timeout: 6e4 }, (error, stdout, stderr) => {
				resolve({
					code: error ? typeof error.code === "number" ? error.code : 1 : 0,
					stdout: stdout || "",
					stderr: stderr || ""
				});
			});
		});
		let parsedOut = {};
		try {
			parsedOut = JSON.parse(execResult.stdout.trim());
		} catch (_e) {
			parsedOut = {
				success: false,
				error: execResult.stderr.trim() || execResult.stdout.trim() || `Worker exited with code ${execResult.code}`
			};
		}
		if (parsedOut.success) {
			options.stateMachine?.markSwanLabSynced(runId, {
				status: "synced",
				runId: parsedOut.runId,
				runUrl: parsedOut.runUrl,
				syncTs: Date.now(),
				error: void 0
			});
			if (options.persistState) await options.persistState();
			return {
				ok: true,
				status: "synced",
				runId: parsedOut.runId,
				runUrl: parsedOut.runUrl
			};
		} else {
			const errMsg = parsedOut.error || "SwanLab sync failed";
			options.stateMachine?.markSwanLabSynced(runId, {
				status: "failed",
				attemptTs: Date.now(),
				error: errMsg
			});
			if (options.persistState) await options.persistState();
			return {
				ok: false,
				status: "failed",
				error: errMsg
			};
		}
	} catch (err) {
		const errMsg = err.message || String(err);
		options.stateMachine?.markSwanLabSynced(runId, {
			status: "failed",
			attemptTs: Date.now(),
			error: errMsg
		});
		if (options.persistState) await options.persistState();
		return {
			ok: false,
			status: "failed",
			error: errMsg
		};
	} finally {
		releaseSyncLock(runId);
		if (tempPayloadPath) await fs$1.promises.rm(tempPayloadPath, { force: true }).catch(() => {});
		if (tempWorkerPath) await fs$1.promises.rm(tempWorkerPath, { force: true }).catch(() => {});
		await fs$1.promises.rm(tempLogDir, {
			recursive: true,
			force: true
		}).catch(() => {});
	}
}
async function syncAllEligibleRuns(runs, options = {}) {
	const results = [];
	let synced = 0;
	let failed = 0;
	let skipped = 0;
	for (const r of runs) {
		if (!options.force && r.swanlab?.status === "synced") {
			skipped += 1;
			continue;
		}
		const res = await syncRunToSwanLab(r, options);
		if (res.skipped) skipped += 1;
		else if (res.ok) synced += 1;
		else failed += 1;
		results.push({
			runId: r.runId,
			ok: res.ok,
			status: res.status,
			error: res.error,
			runUrl: res.runUrl
		});
	}
	return {
		total: runs.length,
		synced,
		failed,
		skipped,
		results
	};
}
//#endregion
//#region lib/types/index.js
const DEFAULT_DEVICES = [{
	id: "gpu220",
	label: "gpu220 (RTX 3090)",
	host: "10.100.104.22",
	port: 22,
	user: "daichuang",
	keyPath: "/home/dc/.ssh/dc_gpu220_ed25519"
}];
function shq(s) {
	return "'" + String(s).replace(/'/g, "'\\''") + "'";
}
function makeRunner(shell, ctx) {
	function cmdLine(file, args) {
		const parts = [shq(file)];
		for (let i = 0; i < args.length; i++) parts.push(shq(args[i]));
		return parts.join(" ");
	}
	function resolveSpec(command, timeoutMs) {
		const spec = shell.resolve({
			command,
			timeoutMs: timeoutMs === void 0 ? 15e3 : timeoutMs
		});
		spec.sandboxPolicy = { mode: "danger-full-access" };
		return spec;
	}
	function resolveBackgroundSpec(command) {
		const spec = shell.resolve({
			command,
			onExpiry: "none"
		});
		spec.sandboxPolicy = { mode: "danger-full-access" };
		return spec;
	}
	return {
		async exec(cmdStr) {
			try {
				const spec = resolveSpec(cmdStr);
				let r;
				if (typeof shell.execute === "function") r = await (await shell.execute(spec)).result();
				else if (typeof shell.run === "function") r = await shell.run(spec);
				else throw new Error("shell service has neither execute nor run method");
				return {
					code: r.exitCode === null || r.exitCode === void 0 ? -1 : r.exitCode,
					stdout: r.stdout && r.stdout.text || "",
					stderr: r.stderr && r.stderr.text || ""
				};
			} catch (e) {
				return {
					code: -1,
					stdout: "",
					stderr: String(e && e.message ? e.message : e)
				};
			}
		},
		execArgs(file, args) {
			return this.exec(cmdLine(file, args));
		},
		execArgsEnc(file, args, enc) {
			return this.exec(cmdLine(file, args) + " | iconv -f " + shq(enc) + " -t UTF-8");
		},
		spawnArgs(file, args) {
			const cmd = cmdLine(file, args);
			let proc = null;
			Promise.resolve(typeof shell.execute === "function" ? shell.execute(resolveBackgroundSpec(cmd)) : shell.start(resolveSpec(cmd))).then((h) => {
				proc = h;
			}).catch(() => {
				proc = null;
			});
			return {
				pid: null,
				readOutput() {
					try {
						const rd = proc.readOutput();
						return rd && rd.delta || "";
					} catch (e) {
						return "";
					}
				},
				done() {
					if (!proc) return false;
					return proc.status ? proc.status !== "running" : proc.exitCode !== null;
				},
				kill() {
					try {
						proc.kill();
					} catch (e) {}
				}
			};
		},
		sleep(ms) {
			return new Promise((resolve) => {
				try {
					ctx.timeout(resolve, ms);
				} catch (e) {
					resolve();
				}
			});
		}
	};
}
function toSamplePoint(snap) {
	const m = snap.mem;
	const total = m ? m.totalMiB : null;
	const avail = m ? m.availableMiB : null;
	const memUsed = total != null ? total - (avail == null ? 0 : avail) : null;
	return {
		ts: snap.ts,
		gpu: snap.gpu || [],
		gpuState: snap.gpu && snap.gpu.length ? "ok" : snap.sources && snap.sources.gpu === "unavailable" ? "unavailable" : "ok",
		cpuPct: snap.cpu ? snap.cpu.percent : null,
		cores: snap.cpu && snap.cpu.cores !== void 0 ? snap.cpu.cores : null,
		memUsedMiB: memUsed,
		memTotalMiB: total,
		procs: snap.procs || [],
		group: null,
		system: null,
		experimentActive: false,
		degraded: snap.degraded || null
	};
}
function fmtGiBx(mib) {
	if (mib === null || mib === void 0 || Number.isNaN(mib)) return "-";
	const g = mib / 1024;
	return g >= 100 ? String(Math.round(g)) : String(Math.round(g * 10) / 10);
}
/**
* 递归 JSON 清洗（2026-08-20 修复：lab_status/lab_advice 报 `value is not lossless JSON`）。
* dsh-tools 工具注册表对返回值做 lossless JSON 校验（NaN/Infinity/undefined/BigInt/-0/循环
* 一律拒绝，见 dsh-tools lib/index.js `isJsonValue`）。采样/解析层偶发非有限数（nvidia-smi
* 的 "N/A"、CIM 空字段等）会直达工具输出 → 完整版 lab_status/lab_advice 调用失败（brief 文本
* 模式不受影响）。本函数在对外输出边界递归清洗：非有限数 → null、undefined → null、-0 → 0；
* 返回**新对象**（复制语义，不污染 balancer/backend 内部共享引用）。
*/
function sanitizeJson(value, depth = 0, seen) {
	if (depth > 12) return null;
	if (value === void 0) return null;
	if (typeof value === "number") {
		if (Number.isFinite(value)) return value === 0 ? 0 : value;
		return null;
	}
	if (Array.isArray(value)) {
		const src = value;
		if (!seen) seen = /* @__PURE__ */ new WeakSet();
		if (seen.has(src)) return null;
		seen.add(src);
		const out = new Array(src.length);
		for (let i = 0; i < src.length; i++) out[i] = sanitizeJson(src[i], depth + 1, seen);
		seen.delete(src);
		return out;
	}
	if (value !== null && typeof value === "object") {
		const src = value;
		if (!seen) seen = /* @__PURE__ */ new WeakSet();
		if (seen.has(src)) return null;
		seen.add(src);
		const out = {};
		for (const k of Object.keys(src)) out[k] = sanitizeJson(src[k], depth + 1, seen);
		seen.delete(src);
		return out;
	}
	return value;
}
function promptLine(snap) {
	const g = snap.gpu && snap.gpu.length ? snap.gpu[0] : null;
	const parts = [];
	if (g && snap.gpuState !== "unavailable") {
		const mem = g.memTotalMiB ? fmtGiBx(g.memUsedMiB) + "/" + fmtGiBx(g.memTotalMiB) + "G" : "";
		parts.push("GPU" + g.id + " " + (g.utilPct !== null ? g.utilPct + "%" : "-") + (mem ? " · " + mem : ""));
	} else parts.push("GPU 无");
	if (snap.cpu && typeof snap.cpu.percent === "number") parts.push("CPU " + Math.round(snap.cpu.percent) + "%");
	if (snap.experiment) {
		const mins = Math.max(0, Math.round((Date.now() - snap.experiment.startTs) / 6e4));
		parts.push("实验 " + snap.experiment.runId + " (" + snap.experiment.state + " " + mins + "min)");
		const gs = snap.experiment.groupStats;
		if (gs) parts.push("实验组 " + (gs.cpuPct ?? "-") + "%CPU/" + fmtGiBx(gs.memMiB) + "G · " + gs.memberCount + " 进程");
	}
	if (snap.system && snap.system.topN.length) parts.push("他占 " + (snap.system.topN[0].cmd || "?") + " " + fmtGiBx(snap.system.topN[0].memMiB) + "G");
	parts.push("告警: " + (snap.alertsCriticalCount ? snap.alertsCriticalCount + "条" : "无"));
	return "[Lab Monitor] " + parts.join(" · ");
}
function resolveAction(level, targetState) {
	if (level === "off" || targetState === "absent") return level === "off" ? "off" : "escalate-root";
	if (level === "notice") return targetState === "running" ? "inject" : "send-nq";
	return targetState === "running" ? "steer" : "followup";
}
const name = "lab-monitor";
/** 依赖声明：shell/timer/webServer/tools 硬依赖（与官方 better-sidebar 一致，inject 后属性直访）；settings/systemPrompt 可选 */
const inject = [
	"shell",
	"timer",
	"webServer",
	"tools"
];
function apply(ctx, config = {}) {
	const cfg = {
		promptInjection: config.promptInjection ?? false,
		backendMode: config.backendMode === "windows" || config.backendMode === "linux" || config.backendMode === "windows-native" ? config.backendMode : "auto",
		sampleMs: config.sampleMs ?? 2e3,
		pollMs: config.pollMs ?? THRESHOLD_DEFAULTS.pollMs,
		watchProcs: Array.isArray(config.watchProcs) ? config.watchProcs.slice() : [],
		tags: Array.isArray(config.tags) ? config.tags.slice() : [],
		trackRules: Array.isArray(config.trackRules) ? config.trackRules.slice() : [],
		alertNotify: config.alertNotify ?? "notice",
		alertTargets: Array.isArray(config.alertTargets) ? config.alertTargets.slice() : [],
		notifyThrottleMs: typeof config.notifyThrottleMs === "number" && config.notifyThrottleMs > 0 ? config.notifyThrottleMs : 6e4,
		escalateAfterSec: typeof config.escalateAfterSec === "number" && config.escalateAfterSec > 0 ? config.escalateAfterSec : 600,
		notifyTimeoutMs: typeof process !== "undefined" && process.env && Number(process.env.LAB_MONITOR_NOTIFY_TIMEOUT_MS) > 0 ? Number(process.env.LAB_MONITOR_NOTIFY_TIMEOUT_MS) : typeof config.notifyTimeoutMs === "number" && config.notifyTimeoutMs > 0 ? config.notifyTimeoutMs : 6e5,
		broadcast: config.broadcast === true,
		experimentTypes: Array.isArray(config.experimentTypes) ? config.experimentTypes.slice() : [],
		expTypeDefault: config.expTypeDefault || "unknown",
		expTypeLearning: config.expTypeLearning !== false,
		subagentPolicy: config.subagentPolicy || "readonly",
		devices: Array.isArray(config.devices) && config.devices.length > 0 ? config.devices.slice() : DEFAULT_DEVICES.slice(),
		currentDevice: typeof config.currentDevice === "string" ? config.currentDevice : "local",
		swanlab: {
			enabled: config.swanlab?.enabled ?? false,
			apiKey: typeof config.swanlab?.apiKey === "string" ? config.swanlab.apiKey : "",
			project: typeof config.swanlab?.project === "string" && config.swanlab.project ? config.swanlab.project : "lab-monitor",
			workspace: typeof config.swanlab?.workspace === "string" ? config.swanlab.workspace : "",
			logDir: typeof config.swanlab?.logDir === "string" ? config.swanlab.logDir : "",
			triggerMode: config.swanlab?.triggerMode === "auto" || config.swanlab?.triggerMode === "scheduled" ? config.swanlab.triggerMode : "manual",
			scheduleIntervalMs: typeof config.swanlab?.scheduleIntervalMs === "number" && config.swanlab.scheduleIntervalMs > 0 ? config.swanlab.scheduleIntervalMs : 6e4,
			conditions: {
				allowedStates: Array.isArray(config.swanlab?.conditions?.allowedStates) ? config.swanlab.conditions.allowedStates.slice() : ["done", "crashed"],
				minDurationSec: typeof config.swanlab?.conditions?.minDurationSec === "number" ? config.swanlab.conditions.minDurationSec : 10,
				includeTypes: Array.isArray(config.swanlab?.conditions?.includeTypes) ? config.swanlab.conditions.includeTypes.slice() : [],
				requireTags: Array.isArray(config.swanlab?.conditions?.requireTags) ? config.swanlab.conditions.requireTags.slice() : []
			}
		}
	};
	const runtimeWatch = /* @__PURE__ */ new Set();
	function watchSet() {
		return Array.from(/* @__PURE__ */ new Set([...cfg.watchProcs, ...runtimeWatch]));
	}
	function tagSet() {
		return cfg.tags;
	}
	/** cmdline 是否命中某标签规则（正则全串匹配；任一 pattern 命中即 true） */
	function tagMatches(rule, cmd) {
		if (!cmd || !rule || !Array.isArray(rule.patterns)) return false;
		for (const p of rule.patterns) {
			if (!p) continue;
			try {
				if (new RegExp(p, "i").test(cmd)) return true;
			} catch (e) {}
		}
		return false;
	}
	let enabled = true;
	const backendState = {
		backend: null,
		platform: "unknown",
		runner: null,
		sshRunner: null,
		currentDevice: "local",
		lastSnap: null,
		stopped: false,
		psAt: 0
	};
	let lastGroupStats = null;
	let lastSystemStats = null;
	const labListeners = [];
	function emitLab(type, data) {
		const runIdVal = data && data.runId || null;
		const ev = {
			type,
			ts: Date.now(),
			runId: typeof runIdVal === "string" ? runIdVal : null,
			data: data || {}
		};
		for (let i = 0; i < labListeners.length; i++) try {
			labListeners[i](ev);
		} catch (e) {
			console.error("[lab-monitor] lab 事件监听错误:", e);
		}
		console.log("[lab-monitor] " + type, JSON.stringify(data || {}));
	}
	const ring = createRing(1e3, 18e5);
	const thresholds = createThresholds();
	const recentWindow = [];
	const balancer = createBalancer({
		thresholds: () => thresholds.get(),
		thresholdOverrides: () => thresholds.getOverrides(),
		emitLab,
		escalateAfterMs: () => cfg.escalateAfterSec > 0 ? cfg.escalateAfterSec * 1e3 : 0
	});
	const machine = createStateMachine({
		ring,
		emitLab,
		emitAlert: (alert, runId) => {
			balancer.pushExternal({
				...alert,
				runId: runId || null
			});
			emitLab("lab/alert", {
				level: alert.level,
				rule: alert.rule,
				msg: alert.msg,
				confidence: alert.confidence,
				actions: alert.actions
			});
		},
		expType: () => ({
			rules: cfg.experimentTypes,
			learning: cfg.expTypeLearning,
			defaultType: cfg.expTypeDefault
		})
	});
	const agentDir = /* @__PURE__ */ new Map();
	/** 实验 start 时关联发起 agent（agentDir 条目存在才记——冷启动缺失时路由回退 roots） */
	function touchAgentRun(agentId, runId) {
		const e = agentDir.get(agentId);
		if (e) e.runs.add(runId);
	}
	/** isSubagent 判定（I4：delegationDepth>0 || origin==='subagent'；不用 parentSession 防 fork 误伤） */
	function isSubagentAgent(a) {
		const h = a?.session?.header;
		return !!h && ((h.delegationDepth ?? 0) > 0 || h.origin === "subagent");
	}
	/** 根祖先链（沿 parentId 向上；不含自己；最多 8 层防环） */
	function rootAncestors(sessionId) {
		const out = [];
		let cur = agentDir.get(sessionId);
		let guard = 0;
		while (cur && cur.parentId && guard < 8) {
			const p = agentDir.get(cur.parentId);
			if (!p || p.disposed) break;
			if (p.role === "root") {
				out.push(p.id);
				break;
			}
			out.push(p.id);
			cur = p;
			guard += 1;
		}
		return out;
	}
	const agentSessionId = (a) => {
		const x = a;
		return x && x.session && x.session.id || x && x.id || null;
	};
	function onAgentCreated(ev) {
		const sid = agentSessionId(ev.agent);
		if (!sid) return;
		const prev = agentDir.get(sid);
		agentDir.set(sid, {
			id: sid,
			role: isSubagentAgent(ev.agent) ? "subagent" : "root",
			parentId: ev.agent?.session?.header?.parentSession || null,
			status: String(ev.agent?.status || "unknown"),
			runs: prev ? prev.runs : /* @__PURE__ */ new Set(),
			disposed: false
		});
	}
	function onAgentDisposed(ev) {
		const sid = agentSessionId(ev.agent);
		const e = sid && agentDir.get(sid);
		if (e) e.disposed = true;
	}
	function onAgentStatus(ev) {
		const sid = agentSessionId(ev.agent);
		const e = sid && agentDir.get(sid);
		if (e && ev.status) e.status = String(ev.status);
	}
	const notifyFingerprints = /* @__PURE__ */ new Set();
	const notifyBudget = /* @__PURE__ */ new Map();
	let lastNotifyAt = 0;
	const agentsSvc = ctx.get("agents");
	/** roots() 实时视图（M3 共享：路由目标兜底 / 消息链升根） */
	const rootsList = () => agentsSvc && typeof agentsSvc.roots === "function" ? agentsSvc.roots().map((r) => ({
		id: r.id,
		status: r.status
	})) : [];
	/** 构造 user 消息（form:'notice'：一次性事件语义） */
	function buildNotifyMessage(alerts) {
		const text = alerts.map((a) => `[${a.level}:${a.rule}] ${a.msg}` + (a.actions && a.actions.length ? "\n建议: " + a.actions.join(" / ") : "")).join("\n\n");
		return {
			id: randomUUID(),
			role: "user",
			content: [{
				type: "text",
				text: `⚠️ [Lab Monitor 异常告警]\n${text}`
			}],
			source: {
				kind: "plugin",
				plugin: "lab-monitor",
				form: "notice",
				summary: `Lab Monitor: ${alerts.length} 条告警`
			}
		};
	}
	/** 有效级别计算（设计 §1.4：不动 Alert.level，只影响通知档位） */
	function effectiveLevel(a) {
		if (a.level === "critical") return "critical";
		if (a.level === "warn") {
			if (a.escalate === true) return "critical";
			if (a.trend === "falling") return "info";
			return "warn";
		}
		if (a.level === "info") {
			if (a.origin === "other") return "off";
			return "info";
		}
		return "info";
	}
	/**
	* 策略矩阵（设计 §2.2；M2 起启用——类型识别 + 子代理路由后按场景行计算）
	* M1 简化：目标仅 roots（主代理），档位由 notifyAlerts 内批量计算（critical→notice/wake、warn→notice）。
	* 保留此函数供 M2 实现场景行矩阵（gpu-train/smoke 等类型覆盖与子代理路径）。
	*/
	/** 投递（含目标状态解析 + 节流/指纹/预算） */
	function notifyAlerts() {
		try {
			const batch = (balancer.advice().advice || []).slice(0, 5);
			if (!batch.length || cfg.alertNotify === "off") return;
			const now = Date.now();
			if (now - lastNotifyAt < cfg.notifyThrottleMs) return;
			lastNotifyAt = now;
			const fp = batch.map((a) => `${a.level}:${a.rule}:${a.msg}`).join("|");
			const hasEscalated = batch.some((a) => a.escalate === true);
			if (notifyFingerprints.has(fp) && !hasEscalated) return;
			const batchEff = batch.map((a) => ({
				a,
				eff: effectiveLevel(a)
			}));
			const runOf = (runId) => {
				if (!runId) return null;
				return machine.all().find((r) => r.runId === runId) || machine.history.find((r) => r.runId === runId) || null;
			};
			const typeNotifyLevel = (type, eff) => {
				if (!type || type === "unknown") return eff === "critical" ? cfg.alertNotify === "wake" ? "wake" : "notice" : cfg.alertNotify === "off" ? "off" : "notice";
				const over = (cfg.experimentTypes || []).find((r) => r.type === type)?.notify;
				const base = EXP_TYPE_DEFAULT_NOTIFY[type] || EXP_TYPE_DEFAULT_NOTIFY.unknown;
				return eff === "critical" ? over && over.critical || base.critical : over && over.warn || base.warn;
			};
			const levelOf = (a, eff) => {
				if (a.origin === "other" || eff === "off" || eff === "info") return "off";
				return typeNotifyLevel(runOf(a.runId)?.type, eff);
			};
			const levels = batchEff.map(({ a, eff }) => levelOf(a, eff));
			const rootLevel = levels.includes("wake") ? "wake" : levels.includes("notice") ? "notice" : "off";
			for (let bi = 0; bi < batchEff.length; bi++) {
				const { a, eff } = batchEff[bi];
				try {
					balancer.setNotifyLevel(a.runId ?? null, a.rule, levelOf(a, eff));
				} catch (e) {}
			}
			const targets = [];
			const seenTargets = /* @__PURE__ */ new Set();
			const addTarget = (id, status, level) => {
				if (!id || seenTargets.has(id)) return;
				seenTargets.add(id);
				targets.push({
					id,
					status,
					level
				});
			};
			if (Array.isArray(cfg.alertTargets) && cfg.alertTargets.length > 0) for (const tid of cfg.alertTargets) {
				const direct = agentsSvc && typeof agentsSvc.get === "function" ? agentsSvc.get(tid) : void 0;
				const entry = agentDir.get(tid);
				if (direct || entry && !entry.disposed) addTarget(tid, direct?.status || entry?.status || "idle", rootLevel);
			}
			else {
				for (const { a, eff } of batchEff) {
					if (a.origin === "other" || eff === "off") continue;
					const run = runOf(a.runId);
					const runLevel = levelOf(a, eff);
					const crashed = !!run && run.state === "crashed";
					if (run && run.agentId) {
						const entry = agentDir.get(run.agentId);
						if (entry && !entry.disposed) {
							if (entry.role === "subagent") {
								addTarget(run.agentId, entry.status, crashed ? "notice" : runLevel);
								for (const rootId of rootAncestors(run.agentId)) {
									const re = agentDir.get(rootId);
									addTarget(rootId, re ? re.status : "idle", crashed ? "wake" : "notice");
								}
							} else addTarget(run.agentId, entry.status, crashed ? "wake" : runLevel);
						} else {
							const direct = agentsSvc && typeof agentsSvc.get === "function" ? agentsSvc.get(run.agentId) : void 0;
							if (direct) {
								const st = direct.status || (entry && !entry.disposed ? entry.status : "idle");
								addTarget(run.agentId, st, crashed ? "wake" : runLevel);
							} else if (cfg.broadcast === true) for (const r of rootsList()) addTarget(r.id, r.status, crashed ? "wake" : runLevel);
							else console.log(`[lab-monitor] 发起会话 ${run.agentId} 不在线且 broadcast=false，跳过向无关根会话广播`);
						}
					} else if (cfg.broadcast === true && (a.runId || !targets.length)) for (const r of rootsList()) addTarget(r.id, r.status, runLevel);
				}
				if (!targets.length && cfg.broadcast === true) {
					for (const r of rootsList()) addTarget(r.id, r.status, rootLevel);
					if (agentsSvc && !rootsList().length) console.log("[lab-monitor] 通知跳过：无可用目标 agent（agents 服务存在但 roots 为空）");
				}
			}
			for (const t of targets) {
				if (t.level === "off") continue;
				const action = resolveAction(t.level, t.status || "idle");
				if (action === "off") continue;
				const key = t.id;
				const used = notifyBudget.get(key) || 0;
				if (used >= 2) {
					console.warn("[lab-monitor] 投递预算超限（同告警×同目标 >2，实现缺陷）:", key);
					continue;
				}
				const agent = agentsSvc && agentsSvc.get ? agentsSvc.get(t.id) : void 0;
				if (!agent || typeof agent.followup !== "function") {
					console.log("[lab-monitor] 通知目标不可用（无 followup 能力），跳过:", t.id);
					continue;
				}
				const msg = buildNotifyMessage(batch);
				try {
					if (action === "followup") agent.followup?.(msg);
					else if (action === "steer") agent.steer?.(msg);
					else if (action === "inject") agent.inject?.(msg);
					else if (action === "send-nq") agent.send?.(msg, "next-turn", false);
					else continue;
					notifyBudget.set(key, used + 1);
					notifyFingerprints.add(fp);
					if (t.level === "wake" && action === "followup" && agentDir.get(t.id)?.role === "subagent") scheduleWakeEscalate(t.id);
					console.log(`[lab-monitor] 告警通知已投递 → ${t.id}（action=${action}, level=${t.level}, ${batch.length} 条）`);
				} catch (e) {
					console.error("[lab-monitor] 告警通知投递失败:", e.message);
				}
			}
		} catch (e) {
			console.error("[lab-monitor] notifyAlerts 错误:", e.message);
		}
	}
	labListeners.push((ev) => {
		if (ev.type === "lab/alert") notifyAlerts();
	});
	const SSE_BUFFER_MAX = 20;
	const sseBuffer = [];
	const sseClients = /* @__PURE__ */ new Set();
	function sseWrite(res, event, payload) {
		try {
			res.write(`event: ${event}\n`);
			res.write(`data: ${JSON.stringify(payload)}\n\n`);
		} catch (e) {}
	}
	labListeners.push((ev) => {
		const eventName = ev.type.indexOf("lab/") === 0 ? ev.type.slice(4) : null;
		if (!eventName) return;
		const payload = {
			ts: ev.ts,
			runId: ev.runId,
			...ev.data || {}
		};
		sseBuffer.unshift({
			type: eventName,
			data: payload,
			ts: ev.ts
		});
		if (sseBuffer.length > SSE_BUFFER_MAX) sseBuffer.length = SSE_BUFFER_MAX;
		for (const res of sseClients) sseWrite(res, eventName, payload);
	});
	function sseHandler(req, res) {
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			"Connection": "keep-alive",
			"X-Accel-Buffering": "no"
		});
		for (let i = sseBuffer.length - 1; i >= 0; i--) {
			const b = sseBuffer[i];
			sseWrite(res, b.type, b.data);
		}
		sseClients.add(res);
		const heartbeat = setInterval(() => {
			try {
				res.write(": ping\n\n");
			} catch (e) {
				clearInterval(heartbeat);
			}
		}, 15e3);
		req.on("close", () => {
			sseClients.delete(res);
			clearInterval(heartbeat);
		});
		req.on("error", () => {
			sseClients.delete(res);
			clearInterval(heartbeat);
		});
	}
	const claimedTargets = /* @__PURE__ */ new Set();
	function scheduleWakeEscalate(targetId) {
		if (!(cfg.notifyTimeoutMs > 0)) return;
		setTimeout(() => {
			try {
				if (claimedTargets.has(targetId)) return;
				const entry = agentDir.get(targetId);
				if (entry && entry.disposed) return;
				const key = "root:" + targetId;
				const used = notifyBudget.get(key) || 0;
				if (used >= 2) return;
				const agent = agentsSvc && agentsSvc.get ? agentsSvc.get(targetId) : void 0;
				if (agent && typeof agent.followup === "function") {
					agent.followup(buildNotifyMessage([{
						level: "critical",
						rule: "notify-undelivered",
						msg: "前一条告警通知（wake 档）在超时窗口内未被领取（疑似未送达），根代理请确认处理状态",
						actions: ["检查目标 agent 运行状态 / 人工接管相关实验"]
					}]));
					notifyBudget.set(key, used + 1);
					console.log(`[lab-monitor] 链断裂兜底（证据1）：告警未领取超时升根 → ${targetId}`);
				}
			} catch (e) {
				console.error("[lab-monitor] 未领取超时升根错误:", e.message);
			}
		}, cfg.notifyTimeoutMs);
	}
	function onSubagentEnd(ev) {
		try {
			const payload = ev?.payload;
			const p = payload && typeof payload === "object" ? payload : ev;
			const sid = p.id || p.local;
			if (!sid) return;
			const entry = agentDir.get(sid);
			if (!entry || entry.role !== "subagent") return;
			if (!(p.stopReason === "max-tokens" || p.stopReason === "error" || p.stopReason === "cancelled")) return;
			const pendingRuns = machine.all().filter((r) => r.agentId === sid && r.state === "running");
			if (!pendingRuns.length) return;
			const msg = buildNotifyMessage([{
				level: "critical",
				rule: "subagent-abnormal-end",
				msg: `子代理 ${sid} 异常结算（${p.stopReason}），其发起实验 ${pendingRuns.map((x) => x.runId).join("/")} 仍在运行，需人工接管（检查日志/重跑决策）`
			}]);
			const ancestors = rootAncestors(sid);
			const targetRoots = ancestors.length > 0 ? ancestors.map((id) => ({ id })) : cfg.broadcast === true ? rootsList() : [];
			for (const r of targetRoots) {
				const key = "root:" + r.id;
				const used = notifyBudget.get(key) || 0;
				if (used >= 2) continue;
				const agent = agentsSvc && agentsSvc.get ? agentsSvc.get(r.id) : void 0;
				if (agent && typeof agent.followup === "function") try {
					agent.followup(msg);
					notifyBudget.set(key, used + 1);
					console.log(`[lab-monitor] 链断裂兜底（证据3）：子代理异常结算升根 → ${r.id}`);
				} catch (e) {
					console.error("[lab-monitor] 升根投递失败:", e.message);
				}
			}
		} catch (e) {
			console.error("[lab-monitor] subagent/end 处理错误:", e.message);
		}
	}
	const runner = makeRunner(ctx.shell, ctx);
	let tickBusy = false;
	async function sampleTick() {
		if (tickBusy || !enabled || !backendState.backend) return;
		tickBusy = true;
		try {
			const snap = await collectSnapshot(backendState.backend);
			if (!snap) return;
			backendState.lastSnap = snap;
			const pt = toSamplePoint(snap);
			ring.push(pt);
			recentWindow.push(pt);
			while (recentWindow.length > 5) recentWindow.shift();
			const runsNow = machine.all();
			const g0 = pt.gpu && pt.gpu.length ? pt.gpu[0] : null;
			for (const run of runsNow) {
				const st = run.sampleStats || (run.sampleStats = {
					utilSum: 0,
					utilN: 0,
					utilMax: 0,
					memPeakMiB: 0
				});
				if (g0 && typeof g0.utilPct === "number") {
					st.utilSum += g0.utilPct;
					st.utilN += 1;
					if (g0.utilPct > st.utilMax) st.utilMax = g0.utilPct;
				}
				if (g0 && typeof g0.memUsedMiB === "number" && g0.memUsedMiB > st.memPeakMiB) st.memPeakMiB = g0.memUsedMiB;
			}
			if (Date.now() - backendState.psAt >= 5e3) {
				backendState.psAt = Date.now();
				const procs = parsePs(await (backendState.runner || runner).exec("ps -eo pid=,ppid=,pcpu=,rss=,args= --no-headers 2>/dev/null"));
				machine.tick(procs);
				const curRun = machine.cur();
				const aggProcs = procs.map((p) => ({
					pid: p.pid,
					cmd: p.cmd ?? null,
					ppid: p.ppid ?? null,
					cpuPct: typeof p.cpuPct === "number" ? p.cpuPct : null,
					memMiB: typeof p.memMiB === "number" ? p.memMiB : null
				}));
				const agg = aggregateProcStats({
					procs: aggProcs,
					group: curRun ? curRun.procGroup : null,
					runActive: !!curRun
				});
				lastGroupStats = agg.group;
				lastSystemStats = agg.system;
				pt.group = agg.group;
				pt.system = agg.system;
				pt.experimentActive = !!curRun;
				pt.experimentType = curRun ? curRun.type ?? null : null;
				if (curRun) {
					const tagHits = tagSet().filter((r) => r.kind === "experiment" && curRun.cmd && tagMatches(r, curRun.cmd)).map((r) => r.label);
					pt.tagHits = tagHits.length ? tagHits : null;
				} else pt.tagHits = null;
				for (const r of machine.all()) {
					if (!r.procGroup || !r.procGroup.size || r.runId === (curRun ? curRun.runId : null)) continue;
					const gAgg = aggregateProcStats({
						procs: aggProcs,
						group: r.procGroup,
						runActive: true
					});
					if (gAgg.group) r.groupStats = gAgg.group;
				}
				if (curRun) {
					const st = curRun.sampleStats || (curRun.sampleStats = {
						utilSum: 0,
						utilN: 0,
						utilMax: 0,
						memPeakMiB: 0
					});
					if (agg.group && typeof agg.group.memMiB === "number" && agg.group.memMiB > (st.groupMemPeakMiB ?? 0)) st.groupMemPeakMiB = agg.group.memMiB;
					if (agg.group && typeof agg.group.cpuPct === "number" && agg.group.cpuPct > (st.groupCpuMax ?? 0)) st.groupCpuMax = agg.group.cpuPct;
					if (agg.system && typeof agg.system.memMiB === "number" && agg.system.memMiB > (st.otherMemPeakMiB ?? 0)) st.otherMemPeakMiB = agg.system.memMiB;
				}
				for (const r of machine.all()) if (r.resultSeen) machine.tickGrace(r);
			}
			if (recentWindow.length) {
				const wLast = recentWindow[recentWindow.length - 1];
				wLast.group = lastGroupStats;
				wLast.system = lastSystemStats;
				wLast.experimentActive = !!machine.cur();
				const cur = machine.cur();
				wLast.experimentType = cur ? cur.type ?? null : null;
				wLast.tagHits = cur ? (() => {
					const hits = tagSet().filter((r) => r.kind === "experiment" && cur.cmd && tagMatches(r, cur.cmd)).map((r) => r.label);
					return hits.length ? hits : null;
				})() : null;
			}
			const mainRun = machine.cur();
			balancer.evaluate(recentWindow, mainRun ? mainRun.runId : null);
		} catch (e) {
			console.error("[lab-monitor] 采样 tick 错误:", e);
		} finally {
			tickBusy = false;
		}
	}
	ctx.interval(sampleTick, cfg.sampleMs);
	async function switchDevice(targetDeviceId) {
		const t0 = Date.now();
		console.log("[lab-monitor] 切换监控设备 -> " + targetDeviceId);
		let devConfig = null;
		if (targetDeviceId !== "local") {
			devConfig = cfg.devices.find((d) => d.id === targetDeviceId) || null;
			if (!devConfig) return {
				ok: false,
				device: cfg.currentDevice,
				error: "未找到设备配置: " + targetDeviceId
			};
		}
		const switchedRuns = machine.switchAwayAll("switched_away");
		if (switchedRuns.length) console.log("[lab-monitor] 平稳归档 " + switchedRuns.length + " 个在途实验为 switched_away");
		try {
			if (backendState.backend) await backendState.backend.close();
			if (backendState.sshRunner) {
				await backendState.sshRunner.close();
				backendState.sshRunner = null;
			}
		} catch (e) {
			console.warn("[lab-monitor] 关闭旧后端出错:", e);
		}
		backendState.lastSnap = null;
		backendState.psAt = 0;
		lastGroupStats = null;
		lastSystemStats = null;
		recentWindow.length = 0;
		if (targetDeviceId === "local" || !devConfig) {
			backendState.runner = runner;
			backendState.currentDevice = "local";
			try {
				const res = await createBackend(runner, cfg.backendMode);
				backendState.backend = res.backend;
				backendState.platform = res.platform;
				cfg.currentDevice = "local";
				persistState();
				const ms = Date.now() - t0;
				console.log("[lab-monitor] 切换到本地设备成功 (耗时 " + ms + "ms)");
				return {
					ok: true,
					device: "local",
					platform: res.platform
				};
			} catch (e) {
				return {
					ok: false,
					device: "local",
					error: e.message
				};
			}
		} else {
			const ssh = new SshRunner(devConfig, runner);
			const remoteBackend = new LinuxBackend(ssh);
			const probe = await remoteBackend.probe();
			if (!probe.ok) console.warn("[lab-monitor] 远程设备 " + targetDeviceId + " probe 失败:", probe.reason);
			backendState.sshRunner = ssh;
			backendState.runner = ssh;
			backendState.backend = remoteBackend;
			backendState.platform = "linux";
			backendState.currentDevice = targetDeviceId;
			cfg.currentDevice = targetDeviceId;
			persistState();
			const ms = Date.now() - t0;
			console.log("[lab-monitor] 切换到远程设备 " + targetDeviceId + " 成功 (耗时 " + ms + "ms)");
			return {
				ok: true,
				device: targetDeviceId,
				platform: "linux"
			};
		}
	}
	let streamTask = null;
	async function startBackend() {
		try {
			if (cfg.currentDevice && cfg.currentDevice !== "local") {
				const sw = await switchDevice(cfg.currentDevice);
				if (sw.ok) return;
				console.warn("[lab-monitor] 启动时切换到配置设备失败，回退本地:", sw.error);
			}
			backendState.runner = runner;
			backendState.currentDevice = "local";
			const res = await createBackend(runner, cfg.backendMode);
			backendState.backend = res.backend;
			backendState.platform = res.platform;
			const probe = await probeBackend(res.backend);
			console.log("[lab-monitor] 采样后端就绪 platform=", res.platform, "probe=", JSON.stringify(probe && probe.detail ? probe.detail : probe));
			if (res.backend && typeof res.backend.stream === "function") streamTask = (async () => {
				try {
					const stream = res.backend.stream();
					if (!stream) return;
					const it = stream[Symbol.asyncIterator]();
					while (!backendState.stopped) if ((await it.next()).done) break;
				} catch (e) {
					console.error("[lab-monitor] dmon 流退出:", e);
				}
			})();
		} catch (e) {
			console.error("[lab-monitor] 采样后端初始化失败（降级为只读空快照）:", e);
		}
	}
	startBackend();
	ctx.effect(() => {
		return () => {
			backendState.stopped = true;
			if (streamTask) try {
				const st = streamTask;
				if (typeof st.return === "function") st.return();
			} catch (e) {}
			if (backendState.sshRunner) try {
				backendState.sshRunner.close().catch(() => {});
			} catch (e) {}
			if (backendState.backend) try {
				backendState.backend.close().then(() => console.log("[lab-monitor] 采样后端已关闭，无孤儿进程")).catch((e) => console.error("[lab-monitor] close 出错:", e));
			} catch (e) {
				console.error("[lab-monitor] close 出错:", e);
			}
		};
	}, "lab-monitor:collector-cleanup");
	let callCount = 0;
	/**
	* GPU 活动进程优先排序（2026-08-20 修复：tasklist 输出按 pid 序，前 15 行全是系统进程，
	* 真实 GPU 活动进程（chrome/explorer/llama-server…）排在数百行之后被 slice(0,15) 截断，
	* 导致 GPU% 列恒 '-'。改为：有 gpu 值（或 gpuUtilPct）的进程置顶、按利用率降序，再补足到 N）。
	*/
	function prioritizeGpuProcs(procs, n) {
		const gpuVal = (p) => {
			const v = p.gpuUtilPct !== void 0 && p.gpuUtilPct !== null ? p.gpuUtilPct : p.gpu;
			return typeof v === "number" && !Number.isNaN(v) ? v : -1;
		};
		const gpuOnes = procs.filter((p) => gpuVal(p) >= 0);
		const gpuOff = procs.filter((p) => gpuVal(p) < 0);
		gpuOnes.sort((a, b) => gpuVal(b) - gpuVal(a));
		return [...gpuOnes, ...gpuOff].slice(0, n);
	}
	function buildSnapshot() {
		callCount += 1;
		const base = backendState.lastSnap || {
			ts: Date.now(),
			platform: "linux",
			sources: {
				cpu: "procfs",
				mem: "procfs",
				procs: "ps"
			},
			cpu: {
				percent: null,
				cores: null
			},
			mem: {
				totalMiB: null,
				availableMiB: null
			},
			procs: []
		};
		const gpu = base.gpu || [];
		const gpuState = gpu.length ? "ok" : base.sources && base.sources.gpu === "unavailable" ? "unavailable" : "ok";
		const expView = machine.snapshot();
		const exp = expView.main;
		const exps = expView.all;
		if (exp) exp.groupStats = exp.groupStats || lastGroupStats;
		for (const e of exps) if (!e.groupStats) e.groupStats = lastGroupStats;
		const watchList = watchSet();
		const watchedPids = [];
		if (watchList.length && Array.isArray(base.procs)) for (let i = 0; i < base.procs.length; i++) {
			const cmd = base.procs[i].cmd || "";
			for (let j = 0; j < watchList.length; j++) if (cmd.toLowerCase().includes(watchList[j].toLowerCase())) {
				watchedPids.push(base.procs[i].pid);
				break;
			}
		}
		const baseProcsFull = Array.isArray(base.procs) ? base.procs : [];
		const watchPidSet = new Set(watchedPids);
		const watchedFirst = baseProcsFull.filter((p) => watchPidSet.has(p.pid));
		const others = baseProcsFull.filter((p) => !watchPidSet.has(p.pid));
		const procsAll = [...prioritizeGpuProcs(watchedFirst, baseProcsFull.length), ...prioritizeGpuProcs(others, baseProcsFull.length)];
		const tagGroups = [];
		const rules = tagSet();
		if (rules.length && baseProcsFull.length) for (const rule of rules) {
			const pids = [];
			const members = [];
			for (const p of baseProcsFull) if (p.cmd && tagMatches(rule, p.cmd)) {
				pids.push(p.pid);
				members.push({
					pid: p.pid,
					ppid: typeof p.ppid === "number" ? p.ppid : null,
					cmd: p.cmd,
					cpuPct: typeof p.cpuPct === "number" ? p.cpuPct : null,
					memMiB: typeof p.memMiB === "number" ? p.memMiB : null,
					gpuUtilPct: typeof p.gpuUtilPct === "number" ? p.gpuUtilPct : null,
					startTs: typeof p.startTs === "number" ? p.startTs : void 0
				});
			}
			if (!pids.length) continue;
			let gpuSum = 0, gpuN = 0, cpuSum = 0, cpuN = 0, memSum = 0, memN = 0;
			for (const m of members) {
				if (typeof m.gpuUtilPct === "number" && !Number.isNaN(m.gpuUtilPct)) {
					gpuSum += m.gpuUtilPct;
					gpuN++;
				}
				if (typeof m.cpuPct === "number" && !Number.isNaN(m.cpuPct)) {
					cpuSum += m.cpuPct;
					cpuN++;
				}
				if (typeof m.memMiB === "number" && !Number.isNaN(m.memMiB)) {
					memSum += m.memMiB;
					memN++;
				}
			}
			const tg = {
				rule,
				pids,
				procs: members,
				gpuUtilPct: gpuN ? Math.round(gpuSum / gpuN) : null,
				cpuPct: cpuN ? Math.round(cpuSum / cpuN) : null,
				memMiB: memN ? Math.round(memSum / memN) : null
			};
			if (rule.kind === "experiment") {
				const runIds = exps.filter((e) => e.cmd && tagMatches(rule, e.cmd)).map((e) => e.runId);
				if (runIds.length) tg.runIds = runIds;
			}
			tagGroups.push(tg);
		}
		const snap = {
			ts: Date.now(),
			platform: base.platform || "linux",
			sources: {
				gpu: base.sources && base.sources.gpu || (gpu.length ? "query" : "unavailable"),
				cpu: base.sources && base.sources.cpu || "procfs",
				mem: base.sources && base.sources.mem || "procfs",
				procs: base.sources && base.sources.procs || "ps"
			},
			gpu: gpu.map((g) => g),
			gpuState,
			cpu: base.cpu ? {
				percent: base.cpu.percent,
				cores: base.cpu.cores !== void 0 ? base.cpu.cores : null
			} : {
				percent: null,
				cores: null
			},
			mem: base.mem ? {
				totalMiB: base.mem.totalMiB,
				availableMiB: base.mem.availableMiB
			} : {
				totalMiB: null,
				availableMiB: null
			},
			procs: procsAll,
			system: lastSystemStats,
			watchedPids,
			watchProcs: watchSet(),
			tags: tagGroups,
			alerts: balancer.snapshotAlerts(),
			alertsCriticalCount: balancer.count(),
			experiment: exp,
			experiments: exps,
			ended: expView.ended,
			thresholds: thresholds.get(),
			thresholdOverrides: thresholds.getOverrides(),
			backendMode: cfg.backendMode,
			currentDevice: backendState.currentDevice || "local",
			devices: (cfg.devices || []).map((d) => ({
				id: d.id,
				label: d.label,
				host: d.host
			})),
			enabled,
			notify: {
				alertNotify: cfg.alertNotify,
				alertTargets: cfg.alertTargets,
				notifyThrottleMs: cfg.notifyThrottleMs,
				escalateAfterSec: cfg.escalateAfterSec,
				notifyTimeoutMs: cfg.notifyTimeoutMs,
				broadcast: cfg.broadcast,
				agentsAvailable: !!agentsSvc,
				notifiedFingerprints: notifyFingerprints.size
			},
			callCount,
			ui: { betterSidebarVisible: uiVisible() },
			swanlab: {
				enabled: cfg.swanlab?.enabled ?? false,
				apiKeyConfigured: !!(cfg.swanlab?.apiKey && cfg.swanlab.apiKey.trim().length > 0),
				project: cfg.swanlab?.project,
				workspace: cfg.swanlab?.workspace,
				triggerMode: cfg.swanlab?.triggerMode || "manual"
			}
		};
		if (base.degraded) snap.degraded = base.degraded;
		maybePersistHistory();
		return sanitizeJson(snap);
	}
	let uiVisibleVal = true;
	function uiVisible() {
		return uiVisibleVal;
	}
	try {
		const settings = ctx.get("settings");
		if (settings && typeof settings.get === "function") {
			const ns = settings.get("aionui-panel");
			uiVisibleVal = !(ns && ns.rightPanel === "aionui-panel");
			if (typeof settings.on === "function") settings.on("settings/updated", (ns2) => {
				if (ns2 === "aionui-panel") {
					const v = settings.get("aionui-panel");
					uiVisibleVal = !(v && v.rightPanel === "aionui-panel");
				}
			});
		}
	} catch (e) {}
	let settingsScope = null;
	let lastPersistedEndKey = "none";
	const settingsRetry = (attempt) => {
		if (settingsScope) return;
		try {
			const settingsSvc = ctx.get("settings");
			if (settingsSvc && typeof settingsSvc.register === "function") {
				const persistSchema = Schema.object({
					thresholds: Schema.object({
						utilWarn: Schema.number().default(THRESHOLD_DEFAULTS.utilWarn),
						memWarn: Schema.number().default(THRESHOLD_DEFAULTS.memWarn),
						tempWarn: Schema.number().default(THRESHOLD_DEFAULTS.tempWarn),
						pollMs: Schema.number().default(THRESHOLD_DEFAULTS.pollMs),
						procTopN: Schema.number().default(THRESHOLD_DEFAULTS.procTopN),
						wGpu: Schema.number().default(THRESHOLD_DEFAULTS.wGpu),
						wCpu: Schema.number().default(THRESHOLD_DEFAULTS.wCpu),
						wMem: Schema.number().default(THRESHOLD_DEFAULTS.wMem)
					}),
					thresholdOverrides: Schema.any().default({}),
					backendMode: Schema.union([
						Schema.const("auto"),
						Schema.const("windows"),
						Schema.const("linux")
					]).default("auto"),
					watchProcs: Schema.array(Schema.string()).default([]),
					tags: Schema.array(Schema.object({
						id: Schema.string(),
						label: Schema.string(),
						patterns: Schema.array(Schema.string()),
						kind: Schema.union([Schema.const("experiment"), Schema.const("process")]),
						color: Schema.any()
					})).default([]),
					trackRules: Schema.array(Schema.object({
						id: Schema.string(),
						label: Schema.string(),
						patterns: Schema.array(Schema.string()),
						color: Schema.any()
					})).default([]),
					history: Schema.array(Schema.object({
						runId: Schema.string(),
						state: Schema.union([
							Schema.const("done"),
							Schema.const("crashed"),
							Schema.const("aborted"),
							Schema.const("switched_away")
						]),
						cmd: Schema.any(),
						cmdFeature: Schema.any(),
						startTs: Schema.number(),
						endTs: Schema.any(),
						summary: Schema.any(),
						type: Schema.any(),
						fingerprint: Schema.any(),
						agentId: Schema.any(),
						deviceId: Schema.any(),
						swanlab: Schema.any()
					})).default([]),
					alertNotify: Schema.union([
						Schema.const("off"),
						Schema.const("notice"),
						Schema.const("wake")
					]).default("notice"),
					alertTargets: Schema.array(Schema.string()).default([]),
					notifyThrottleMs: Schema.number().default(6e4),
					escalateAfterSec: Schema.number().default(600),
					notifyTimeoutMs: Schema.number().default(6e5),
					broadcast: Schema.boolean().default(false),
					experimentTypes: Schema.array(Schema.object({
						type: Schema.string(),
						patterns: Schema.array(Schema.string()),
						notify: Schema.any(),
						expectedMaxSec: Schema.any()
					})).default([]),
					expTypeDefault: Schema.string().default("unknown"),
					expTypeLearning: Schema.boolean().default(true),
					subagentPolicy: Schema.union([
						Schema.const("readonly"),
						Schema.const("restricted"),
						Schema.const("full")
					]).default("readonly"),
					devices: Schema.array(Schema.object({
						id: Schema.string(),
						label: Schema.any(),
						host: Schema.string(),
						port: Schema.any(),
						user: Schema.string(),
						keyPath: Schema.any(),
						pollMs: Schema.any()
					})).default([]),
					currentDevice: Schema.string().default("local"),
					swanlab: Schema.any().default({})
				});
				settingsScope = settingsSvc.register("lab-monitor", persistSchema, { applies: "live" });
				const stored = settingsScope.get();
				if (stored && stored.thresholds) thresholds.apply(stored.thresholds, true);
				if (stored && stored.thresholdOverrides && typeof stored.thresholdOverrides === "object") thresholds.setOverrides(stored.thresholdOverrides);
				if (stored && (stored.backendMode === "windows" || stored.backendMode === "linux" || stored.backendMode === "windows-native")) cfg.backendMode = stored.backendMode;
				if (stored && Array.isArray(stored.devices) && stored.devices.length > 0) cfg.devices = stored.devices;
				else cfg.devices = DEFAULT_DEVICES.slice();
				if (stored && typeof stored.currentDevice === "string") cfg.currentDevice = stored.currentDevice;
				if (stored && Array.isArray(stored.watchProcs)) cfg.watchProcs = stored.watchProcs.filter((k) => typeof k === "string" && k.length > 0);
				if (stored && Array.isArray(stored.tags)) cfg.tags = stored.tags.filter(isValidTagRule);
				if (stored && Array.isArray(stored.trackRules)) cfg.trackRules = stored.trackRules.filter(isValidTrackRule);
				if (stored && typeof stored.alertNotify === "string" && (stored.alertNotify === "off" || stored.alertNotify === "notice" || stored.alertNotify === "wake")) cfg.alertNotify = stored.alertNotify;
				if (stored && Array.isArray(stored.alertTargets)) cfg.alertTargets = stored.alertTargets.filter((k) => typeof k === "string" && k.length > 0);
				if (stored && typeof stored.notifyThrottleMs === "number" && stored.notifyThrottleMs > 0) cfg.notifyThrottleMs = stored.notifyThrottleMs;
				if (stored && typeof stored.escalateAfterSec === "number") cfg.escalateAfterSec = stored.escalateAfterSec;
				if (stored && typeof stored.notifyTimeoutMs === "number" && stored.notifyTimeoutMs > 0) cfg.notifyTimeoutMs = stored.notifyTimeoutMs;
				if (stored && typeof stored.broadcast === "boolean") cfg.broadcast = stored.broadcast;
				if (stored && Array.isArray(stored.experimentTypes)) cfg.experimentTypes = stored.experimentTypes.filter((r) => {
					const rr = r;
					return !!rr && typeof rr.type === "string" && Array.isArray(rr.patterns);
				});
				if (stored && typeof stored.expTypeDefault === "string" && EXP_TYPES_SET.has(stored.expTypeDefault)) cfg.expTypeDefault = stored.expTypeDefault;
				if (stored && typeof stored.expTypeLearning === "boolean") cfg.expTypeLearning = stored.expTypeLearning;
				if (stored && (stored.subagentPolicy === "readonly" || stored.subagentPolicy === "restricted" || stored.subagentPolicy === "full")) cfg.subagentPolicy = stored.subagentPolicy;
				if (stored && stored.swanlab && typeof stored.swanlab === "object") {
					const sw = stored.swanlab;
					cfg.swanlab = {
						...cfg.swanlab,
						...sw,
						conditions: {
							...cfg.swanlab?.conditions,
							...sw.conditions || {}
						}
					};
				}
				if (stored && Array.isArray(stored.history) && typeof machine.restoreEnded === "function") {
					machine.restoreEnded(stored.history);
					lastPersistedEndKey = machine.history && machine.history.length ? String(machine.history[0].endTs) : "none";
				}
				if (typeof settingsScope.watch === "function") settingsScope.watch((next) => {
					const v = next;
					if (v && v.thresholds) thresholds.apply(v.thresholds, true);
					if (v && v.thresholdOverrides && typeof v.thresholdOverrides === "object") thresholds.setOverrides(v.thresholdOverrides);
					if (v && (v.backendMode === "auto" || v.backendMode === "windows" || v.backendMode === "linux")) cfg.backendMode = v.backendMode;
					if (v && Array.isArray(v.devices) && v.devices.length > 0) cfg.devices = v.devices;
					if (v && typeof v.currentDevice === "string" && v.currentDevice !== cfg.currentDevice) switchDevice(v.currentDevice);
					if (v && Array.isArray(v.watchProcs)) cfg.watchProcs = v.watchProcs.filter((k) => typeof k === "string" && k.length > 0);
					if (v && Array.isArray(v.tags)) cfg.tags = v.tags.filter(isValidTagRule);
					if (v && typeof v.alertNotify === "string" && (v.alertNotify === "off" || v.alertNotify === "notice" || v.alertNotify === "wake")) cfg.alertNotify = v.alertNotify;
					if (v && Array.isArray(v.alertTargets)) cfg.alertTargets = v.alertTargets.filter((k) => typeof k === "string" && k.length > 0);
					if (v && typeof v.notifyThrottleMs === "number" && v.notifyThrottleMs > 0) cfg.notifyThrottleMs = v.notifyThrottleMs;
					if (v && typeof v.escalateAfterSec === "number") cfg.escalateAfterSec = v.escalateAfterSec;
					if (v && typeof v.broadcast === "boolean") cfg.broadcast = v.broadcast;
					if (v && v.swanlab && typeof v.swanlab === "object") {
						const sw = v.swanlab;
						cfg.swanlab = {
							...cfg.swanlab,
							...sw,
							conditions: {
								...cfg.swanlab?.conditions,
								...sw.conditions || {}
							}
						};
						setupScheduledSync();
					}
				});
				console.log("[lab-monitor] 阈值/watchlist/标签持久化已启用（settings 命名空间 lab-monitor）");
			} else if (attempt < 10) ctx.setTimeout(() => settingsRetry(attempt + 1), 500);
		} catch (e) {
			if (attempt < 10) ctx.setTimeout(() => settingsRetry(attempt + 1), 500);
			else console.warn("[lab-monitor] settings 持久化不可用，回退内存模式（阈值/watchlist/标签重启即还原）:", e.message);
		}
	};
	settingsRetry(0);
	async function persistState() {
		if (!settingsScope || typeof settingsScope.update !== "function") return;
		try {
			const endKey = machine.history && machine.history.length ? String(machine.history[0].endTs) : "none";
			await settingsScope.update({
				thresholds: thresholds.get(),
				thresholdOverrides: thresholds.getOverrides(),
				backendMode: cfg.backendMode,
				devices: cfg.devices && cfg.devices.length > 0 ? cfg.devices : DEFAULT_DEVICES,
				currentDevice: cfg.currentDevice,
				watchProcs: watchSet(),
				tags: tagSet(),
				trackRules: cfg.trackRules,
				history: (machine.history || []).map((r) => ({
					runId: r.runId,
					deviceId: r.deviceId || "local",
					state: r.state === "done" ? "done" : r.state === "aborted" ? "aborted" : r.state === "switched_away" ? "switched_away" : "crashed",
					cmd: r.cmd,
					cmdFeature: r.cmdFeature,
					startTs: r.startTs,
					endTs: r.endTs,
					summary: r.summary || null,
					type: r.type,
					fingerprint: r.fingerprint,
					agentId: r.agentId ?? null,
					swanlab: r.swanlab ? { ...r.swanlab } : void 0
				})),
				alertNotify: cfg.alertNotify,
				alertTargets: cfg.alertTargets,
				notifyThrottleMs: cfg.notifyThrottleMs,
				escalateAfterSec: cfg.escalateAfterSec,
				notifyTimeoutMs: cfg.notifyTimeoutMs,
				broadcast: cfg.broadcast,
				experimentTypes: cfg.experimentTypes,
				expTypeDefault: cfg.expTypeDefault,
				expTypeLearning: cfg.expTypeLearning,
				subagentPolicy: cfg.subagentPolicy,
				swanlab: cfg.swanlab
			});
			lastPersistedEndKey = endKey;
		} catch (e) {
			console.warn("[lab-monitor] 设置持久化写入失败（保留内存值）:", e.message);
		}
	}
	/** P2：history 变化惰性持久化——buildSnapshot 出口检测（新 ended 归档后 ≤1 轮询周期落盘） */
	function maybePersistHistory() {
		if (!settingsScope) return;
		const endKey = machine.history && machine.history.length ? String(machine.history[0].endTs) : "none";
		if (endKey !== lastPersistedEndKey) {
			lastPersistedEndKey = endKey;
			persistState();
		}
	}
	/** 标签规则合法性过滤（settings 读回 / lab_ctl tag add 的守卫） */
	function isValidTagRule(t) {
		if (!t || typeof t !== "object") return false;
		const r = t;
		if (typeof r.id !== "string" || !r.id) return false;
		if (typeof r.label !== "string" || !r.label) return false;
		if (!Array.isArray(r.patterns) || !r.patterns.length) return false;
		for (const p of r.patterns) {
			if (typeof p !== "string" || !p) return false;
			try {
				new RegExp(p);
			} catch (e) {
				return false;
			}
		}
		if (r.kind !== "experiment" && r.kind !== "process") return false;
		if (r.color !== void 0 && typeof r.color !== "string") return false;
		return true;
	}
	/** 跟踪规则合法性过滤（settings 读回 / lab_ctl track add 的守卫；仿 isValidTagRule） */
	function isValidTrackRule(t) {
		if (!t || typeof t !== "object") return false;
		const r = t;
		if (typeof r.id !== "string" || !r.id) return false;
		if (typeof r.label !== "string" || !r.label) return false;
		if (!Array.isArray(r.patterns) || !r.patterns.length) return false;
		for (const p of r.patterns) {
			if (typeof p !== "string" || !p) return false;
			try {
				new RegExp(p);
			} catch (e) {
				return false;
			}
		}
		if (r.color !== void 0 && typeof r.color !== "string") return false;
		return true;
	}
	/** cmdline 是否命中显式跟踪规则（正则全串匹配；任一 pattern 命中即 true） */
	function trackRuleMatches(rule, cmd) {
		if (!cmd || !rule || !Array.isArray(rule.patterns)) return false;
		for (const p of rule.patterns) {
			if (!p) continue;
			try {
				if (new RegExp(p, "i").test(cmd)) return true;
			} catch (e) {}
		}
		return false;
	}
	/** 显式跟踪命中查找：返回第一个命中的规则（无则 null）——pre-execute 显式注册优先于 TRAIN_PATTERNS */
	function matchTrackRule(cmd) {
		if (!cmd || !cfg.trackRules.length) return null;
		for (const r of cfg.trackRules) if (trackRuleMatches(r, cmd)) return r;
		return null;
	}
	function rpcSnapshot(args) {
		if (args && args.thresholds) {
			if (thresholds.apply(args.thresholds, false)) persistState();
		}
		return buildSnapshot();
	}
	function rpcHistory(args) {
		const a = args || {};
		const sinceMs = typeof a.sinceMs === "number" ? a.sinceMs : Date.now() - 18e5;
		const bucketMs = typeof a.bucketMs === "number" ? a.bucketMs : 1e4;
		return ring.history(sinceMs, bucketMs);
	}
	function rpcSetThresholds(args) {
		const a = args || {};
		const applied = {};
		const keys = [
			"utilWarn",
			"memWarn",
			"tempWarn",
			"pollMs",
			"procTopN",
			"wGpu",
			"wCpu",
			"wMem"
		];
		for (let n = 0; n < keys.length; n++) {
			const k = keys[n];
			if (typeof a[k] !== "number" || !isFinite(a[k])) continue;
			let v = a[k];
			if (k === "procTopN") v = Math.max(5, Math.min(1e3, Math.round(v)));
			else if (k === "wGpu" || k === "wCpu" || k === "wMem") v = Math.max(0, Math.min(20, v));
			applied[k] = v;
		}
		thresholds.apply(applied, true);
		persistState();
		return {
			ok: true,
			applied: thresholds.get()
		};
	}
	function rpcControl(args) {
		const action = args && args.action;
		if (action === "switch-device" || action === "device") {
			const target = args && (args.target || args.device) || "local";
			return switchDevice(String(target)).then((res) => ({
				state: "device-switched",
				...res
			}));
		}
		if (action === "start") {
			enabled = true;
			emitLab("lab/status-flip", { enabled: true });
		} else if (action === "pause") {
			enabled = false;
			emitLab("lab/status-flip", { enabled: false });
		} else if (action === "resume") {
			enabled = true;
			emitLab("lab/status-flip", { enabled: true });
		} else if (action === "clear-alerts") {
			const cleared = balancer.clear({
				runId: args && args.runId,
				rule: args && args.rule
			});
			if (notifyFingerprints.size) {
				notifyFingerprints.clear();
				console.log("[lab-monitor] clear-alerts：通知指纹已重置（同告警可重新通知）");
			}
			return {
				ok: true,
				state: "alerts-cleared",
				...cleared
			};
		} else if (action === "set-notify") {
			const patch = args;
			if (typeof patch.alertNotify === "string" && (patch.alertNotify === "off" || patch.alertNotify === "notice" || patch.alertNotify === "wake")) cfg.alertNotify = patch.alertNotify;
			if (typeof patch.escalateAfterSec === "number" && patch.escalateAfterSec >= 0) cfg.escalateAfterSec = patch.escalateAfterSec;
			if (typeof patch.notifyThrottleMs === "number" && patch.notifyThrottleMs > 0) cfg.notifyThrottleMs = patch.notifyThrottleMs;
			persistState();
			return {
				ok: true,
				state: "notify-updated",
				config: {
					alertNotify: cfg.alertNotify,
					escalateAfterSec: cfg.escalateAfterSec,
					notifyThrottleMs: cfg.notifyThrottleMs
				}
			};
		} else return {
			ok: false,
			error: "未知 action: " + action
		};
		return {
			ok: true,
			state: enabled ? "running" : "paused"
		};
	}
	function rpcAdvice() {
		return balancer.advice();
	}
	function rpcTag(a) {
		const op = a.op === void 0 || a.op === null ? "list" : String(a.op);
		if (op === "list") return {
			ok: true,
			tags: tagSet(),
			matches: buildSnapshot().tags || []
		};
		if (op === "add") {
			const label = typeof a.label === "string" && a.label.trim() ? a.label.trim() : null;
			if (!label) return {
				ok: false,
				error: "tag add 需要 label"
			};
			const kind = a.kind === "experiment" ? "experiment" : "process";
			const color = typeof a.color === "string" && a.color.trim() ? a.color.trim() : void 0;
			let patterns = [];
			if (typeof a.pid === "number" && a.pid > 0) {
				const hit = (backendState.lastSnap && Array.isArray(backendState.lastSnap.procs) ? backendState.lastSnap.procs : []).find((p) => p.pid === a.pid);
				if (!hit || !hit.cmd) return {
					ok: false,
					error: "pid " + a.pid + " 不在当前进程表（进程可能已退出，请用 patterns 打标）"
				};
				patterns = [hit.cmd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")];
			} else if (Array.isArray(a.patterns) && a.patterns.length) patterns = a.patterns.filter((p) => typeof p === "string" && p.trim().length > 0);
			if (!patterns.length) return {
				ok: false,
				error: "tag add 需要 patterns 或 pid（cmdline 正则，如 \"python.*train\"）"
			};
			const rule = {
				id: makeTagId(),
				label,
				patterns,
				kind,
				color
			};
			if (!isValidTagRule(rule)) return {
				ok: false,
				error: "标签规则非法（pattern 正则或字段类型错误）"
			};
			cfg.tags.push(rule);
			persistState();
			const tg = (buildSnapshot().tags || []).find((t) => t.rule.id === rule.id);
			return {
				ok: true,
				state: "tag-added",
				rule,
				matchedPids: tg ? tg.pids : [],
				matchedProcs: tg ? tg.procs.length : 0
			};
		}
		if (op === "remove") {
			const id = typeof a.id === "string" && a.id ? a.id : null;
			if (!id) return {
				ok: false,
				error: "tag remove 需要 id"
			};
			const idx = cfg.tags.findIndex((t) => t.id === id);
			if (idx === -1) return {
				ok: true,
				state: "tag-not-found",
				id
			};
			cfg.tags.splice(idx, 1);
			persistState();
			return {
				ok: true,
				state: "tag-removed",
				id
			};
		}
		return {
			ok: false,
			error: "未知 tag 操作: " + op
		};
	}
	function rpcTrack(a) {
		const op = a.op === void 0 || a.op === null ? "list" : String(a.op);
		if (op === "list") {
			const matched = (backendState.lastSnap && Array.isArray(backendState.lastSnap.procs) ? backendState.lastSnap.procs : []).filter((p) => p.cmd && cfg.trackRules.some((r) => trackRuleMatches(r, p.cmd))).map((p) => ({
				pid: p.pid,
				cmd: p.cmd
			}));
			return {
				ok: true,
				rules: cfg.trackRules,
				matchedProcs: matched
			};
		}
		if (op === "add") {
			const label = typeof a.label === "string" && a.label.trim() ? a.label.trim() : null;
			if (!label) return {
				ok: false,
				error: "track add 需要 label（规则名，如 \"训练实验A\"）"
			};
			const color = typeof a.color === "string" && a.color.trim() ? a.color.trim() : void 0;
			let patterns = [];
			if (typeof a.pid === "number" && a.pid > 0) {
				const hit = (backendState.lastSnap && Array.isArray(backendState.lastSnap.procs) ? backendState.lastSnap.procs : []).find((p) => p.pid === a.pid);
				if (!hit || !hit.cmd) return {
					ok: false,
					error: "pid " + a.pid + " 不在当前进程表（进程可能已退出，请用 patterns 注册）"
				};
				patterns = [hit.cmd.replace(/[.*+?^${}()|[]\]/g, "\\$&")];
			} else if (Array.isArray(a.patterns) && a.patterns.length) patterns = a.patterns.filter((p) => typeof p === "string" && p.trim().length > 0);
			if (!patterns.length) return {
				ok: false,
				error: "track add 需要 patterns 或 pid（cmdline 正则，如 \"python.*infer\"）"
			};
			const rule = {
				id: makeTagId(),
				label,
				patterns,
				color
			};
			if (!isValidTrackRule(rule)) return {
				ok: false,
				error: "跟踪规则非法（pattern 正则或字段类型错误）"
			};
			cfg.trackRules.push(rule);
			persistState();
			return {
				ok: true,
				state: "track-added",
				rule,
				note: "命中该命令的 bash 执行将记为实验（explicit）并监控"
			};
		}
		if (op === "remove") {
			const id = typeof a.id === "string" && a.id ? a.id : null;
			if (!id) return {
				ok: false,
				error: "track remove 需要 id"
			};
			const idx = cfg.trackRules.findIndex((t) => t.id === id);
			if (idx === -1) return {
				ok: true,
				state: "track-not-found",
				id
			};
			cfg.trackRules.splice(idx, 1);
			persistState();
			return {
				ok: true,
				state: "track-removed",
				id
			};
		}
		return {
			ok: false,
			error: "未知 track 操作: " + op
		};
	}
	function rpcHistoryManage(args) {
		const op = args.op || "list";
		if (op === "delete") {
			const runId = typeof args.runId === "string" && args.runId ? args.runId : "";
			if (!runId) return {
				ok: false,
				state: "missing-runId",
				remaining: machine.history.length
			};
			if (!machine.removeRun(runId)) return {
				ok: false,
				state: "not-found",
				remaining: machine.history.length
			};
			persistState();
			return {
				ok: true,
				state: "deleted",
				removed: [runId],
				remaining: machine.history.length
			};
		}
		if (op === "clear") {
			const keep = typeof args.keep === "number" && isFinite(args.keep) ? Math.max(0, Math.round(args.keep)) : 0;
			const removed = machine.clearHistory(keep);
			persistState();
			return {
				ok: true,
				state: "cleared",
				removed: removed.map((r) => r.runId),
				remaining: machine.history.length
			};
		}
		return {
			ok: true,
			state: "list",
			remaining: machine.history.length
		};
	}
	async function rpcSwanLabSync(a) {
		const swanlabCfg = {
			...cfg.swanlab,
			...a.config || {}
		};
		if (a.runId) {
			const target = machine.all().find((r) => r.runId === a.runId) || machine.history.find((r) => r.runId === a.runId);
			if (!target) return {
				ok: false,
				error: "Run not found: " + a.runId
			};
			return await syncRunToSwanLab(target, {
				config: swanlabCfg,
				stateMachine: machine,
				ring,
				persistState,
				force: a.force ?? true
			});
		} else {
			const runs = machine.history;
			return {
				ok: true,
				...await syncAllEligibleRuns(runs, {
					config: swanlabCfg,
					stateMachine: machine,
					ring,
					persistState,
					force: a.force ?? false
				})
			};
		}
	}
	const API_BASE = "/lab-monitor/api";
	const apiHandlers = {
		snapshot: (body) => rpcSnapshot({ thresholds: body.thresholds }),
		history: (body) => rpcHistory({
			sinceMs: body.sinceMs,
			bucketMs: body.bucketMs
		}),
		setThresholds: (body) => rpcSetThresholds(body),
		control: (body) => rpcControl(body),
		advice: () => rpcAdvice(),
		tag: (body) => rpcTag(body.tag || {}),
		watch: (body) => {
			const kws = Array.isArray(body.keywords) ? body.keywords.filter((k) => typeof k === "string" && !!k.trim()).map((k) => k.trim()) : [];
			cfg.watchProcs = kws;
			runtimeWatch.clear();
			persistState();
			return {
				ok: true,
				state: "watchlist-updated",
				watchProcs: watchSet()
			};
		},
		historyManage: (body) => rpcHistoryManage({
			op: body.op,
			runId: body.runId,
			keep: body.keep
		}),
		track: (body) => rpcTrack(body.track || {}),
		device: async (body) => switchDevice(body.target || body.device || "local"),
		swanlabSync: async (body) => rpcSwanLabSync(body)
	};
	const MAX_BODY_BYTES = 1 << 20;
	function isLocalOriginUrl(urlStr) {
		try {
			const u = new URL(urlStr);
			if (u.protocol !== "http:" && u.protocol !== "https:") return false;
			const h = u.hostname;
			return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]" || h.endsWith(".localhost");
		} catch (e) {
			return false;
		}
	}
	/** POST 来源校验：通过返回 null；拒绝返回原因字符串 */
	function checkWriteSource(req) {
		const origin = req.headers.origin;
		const referer = req.headers.referer;
		if (origin) return isLocalOriginUrl(String(origin)) ? null : "origin not allowed: " + origin;
		if (referer) return isLocalOriginUrl(String(referer)) ? null : "referer not allowed";
		if (req.headers["x-lab-monitor"] === "1") return null;
		return "missing Origin/Referer 或 X-Lab-Monitor 头";
	}
	function httpHandler(req, res) {
		const url = new URL(req.url || "/", "http://localhost");
		if (!url.pathname.startsWith(API_BASE + "/")) {
			res.writeHead(404).end("not found");
			return;
		}
		const method = url.pathname.slice(17);
		const handler = apiHandlers[method];
		if (!handler) {
			res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({
				ok: false,
				error: "未知方法: " + method
			}));
			return;
		}
		let responded = false;
		function finish(code, payload) {
			if (responded) return;
			responded = true;
			res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(payload));
		}
		if (method === "swanlabSync" && req.method !== "POST") {
			finish(405, {
				ok: false,
				error: "POST required for swanlabSync"
			});
			return;
		}
		if (req.method === "POST") {
			const deny = checkWriteSource(req);
			if (deny) {
				console.warn("[lab-monitor] 拒绝跨站写请求:", deny);
				finish(403, {
					ok: false,
					error: "forbidden: " + deny
				});
				return;
			}
			const cl = Number(req.headers["content-length"]);
			if (Number.isFinite(cl) && cl > MAX_BODY_BYTES) {
				finish(413, {
					ok: false,
					error: "payload too large (>1048576B)"
				});
				try {
					req.destroy();
				} catch (e) {}
				return;
			}
		}
		let body = "";
		let tooLarge = false;
		req.on("data", (chunk) => {
			if (tooLarge || responded) return;
			body += chunk.toString();
			if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
				tooLarge = true;
				finish(413, {
					ok: false,
					error: "payload too large (>1048576B)"
				});
				try {
					req.destroy();
				} catch (e) {}
			}
		});
		req.on("end", () => {
			if (tooLarge || responded) return;
			try {
				const parsed = body ? JSON.parse(body) : {};
				if (method === "swanlabSync") {
					if (!body || !body.trim() || Object.keys(parsed).length === 0) {
						finish(400, {
							ok: false,
							error: "missing parameters for swanlabSync"
						});
						return;
					}
				}
				const result = handler(parsed);
				if (result && typeof result.then === "function") result.then((r) => finish(200, r)).catch((e) => finish(400, {
					ok: false,
					error: e.message
				}));
				else finish(200, result);
			} catch (e) {
				finish(400, {
					ok: false,
					error: e.message
				});
			}
		});
		req.on("error", () => {
			if (responded || tooLarge) return;
			finish(400, {
				ok: false,
				error: "request error"
			});
		});
	}
	const webServer = ctx.webServer;
	try {
		const disposer = webServer.register({
			kind: "http",
			path: API_BASE,
			handler: httpHandler
		});
		ctx.effect(() => disposer);
		const sseDisposer = webServer.register({
			kind: "http",
			path: "/lab-monitor/events",
			handler: sseHandler
		});
		ctx.effect(() => sseDisposer);
	} catch (e) {
		console.error("[lab-monitor] webServer 路由注册失败:", e);
	}
	function renderText(value) {
		return [{
			type: "text",
			text: typeof value === "string" ? value : JSON.stringify(value, null, 2)
		}];
	}
	const toolsService = ctx.tools;
	try {
		const disposers = [];
		disposers.push(toolsService.register(defineTool({
			name: "lab_status",
			description: "查询 Lab Monitor 实时资源快照（GPU/CPU/内存/进程/实验/告警/watchlist）。返回完整 JSON 快照；brief:true 取一行摘要。",
			parameters: { brief: {
				type: "boolean",
				description: "为 true 时只返回一行摘要字符串"
			} },
			output: {
				schema: { type: "json" },
				render: (args, value) => {
					if (args && args.brief === true) {
						const env = value;
						return renderText(env && typeof env.line === "string" ? env.line : JSON.stringify(value));
					}
					return renderText(value);
				}
			},
			async execute(args) {
				const snap = buildSnapshot();
				snap.watchlist = watchSet();
				if (args && args.brief === true) return {
					ok: true,
					line: promptLine(snap)
				};
				return snap;
			}
		})));
		disposers.push(toolsService.register(defineTool({
			name: "lab_advice",
			description: "查询 Lab Monitor 平衡引擎当前建议（分级 + 置信度 + 可执行动作）。无告警时 advice 为空数组。",
			parameters: {},
			output: {
				schema: { type: "json" },
				render: (_args, value) => renderText(value)
			},
			async execute() {
				const a = rpcAdvice();
				return sanitizeJson({
					ok: true,
					advice: a.advice,
					generatedAt: a.generatedAt
				});
			}
		})));
		disposers.push(toolsService.register(defineTool({
			name: "lab_ctl",
			description: "控制 Lab Monitor 监控/告警引擎（start/pause/resume/set-threshold/watch/tag/clear-alerts/history-manage/sync-swanlab）。护栏：只控制监控引擎，绝不触碰实验进程。",
			parameters: {
				action: {
					type: "string",
					required: true,
					enum: [
						"start",
						"pause",
						"resume",
						"set-threshold",
						"watch",
						"tag",
						"clear-alerts",
						"set-notify",
						"history-manage",
						"backend-mode",
						"track",
						"switch-device",
						"sync-swanlab"
					],
					description: "操作类型（set-notify=设置告警通知策略；history-manage=实验历史管理；backend-mode=切换监控目标；track=显式注册实验跟踪规则；switch-device=切换监控设备；sync-swanlab=同步实验到 SwanLab）"
				},
				device: {
					type: "string",
					description: "switch-device 时的监控目标设备 ID（\"local\" 或远程设备 id 如 \"gpu220\"）"
				},
				keywords: {
					type: "array",
					items: { type: "string" },
					description: "watch 时的进程名关键词列表（如 [\"llama-server\",\"vllm\"]）；空数组=清空动态注册"
				},
				mode: {
					type: "string",
					enum: [
						"auto",
						"windows",
						"linux"
					],
					description: "backend-mode 时的监控目标（auto=按平台；windows=Windows tasklist；linux=WSL 内 Linux 进程）"
				},
				thresholds: {
					type: "object",
					additionalProperties: true,
					properties: {
						utilWarn: {
							type: "number",
							description: "GPU 利用率告警阈值 %"
						},
						memWarn: {
							type: "number",
							description: "显存占用告警阈值 %"
						},
						tempWarn: {
							type: "number",
							description: "温度告警阈值 °C"
						},
						pollMs: {
							type: "number",
							description: "UI 轮询周期 ms"
						}
					},
					description: "set-threshold 时的阈值"
				},
				thresholdOverrides: {
					type: "object",
					additionalProperties: true,
					properties: {
						byExpType: {
							type: "object",
							additionalProperties: true,
							description: "按实验类型覆盖：{\"gpu-train\": {\"utilWarn\": 60, \"memWarn\": 90}, \"gpu-calc\": {...}}"
						},
						byTag: {
							type: "object",
							additionalProperties: true,
							description: "按标签组覆盖：{\"推理服务\": {\"memWarn\": 95}}（主实验 cmd 命中标签时生效）"
						}
					},
					description: "#13-3 差异化阈值（set-threshold 时可选）：全局 → 实验类型 → 标签组 分层覆盖链"
				},
				tag: {
					type: "object",
					additionalProperties: true,
					properties: {
						op: {
							type: "string",
							enum: [
								"add",
								"remove",
								"list"
							],
							description: "add=打标签（label+patterns 或 label+pid）；remove=按 id 删除；list=列出全部"
						},
						label: {
							type: "string",
							description: "标签组显示名（如 \"推理服务\"、\"训练实验A\"）"
						},
						patterns: {
							type: "array",
							items: { type: "string" },
							description: "cmdline 正则列表（任一命中即归属；脚本形态天然覆盖，如 \"python.*train\"、\"deploy\\.ps1\"）"
						},
						pid: {
							type: "number",
							description: "从当前进程列表快速打标：按 pid 取该进程 cmdline 自动生成 pattern（等价于规则式，重启后仍命中）"
						},
						kind: {
							type: "string",
							enum: ["experiment", "process"],
							description: "experiment=实验型（组内展示状态/时长/曲线）；process=进程型（只展示资源占用），默认 process"
						},
						color: {
							type: "string",
							description: "展示色（可选，16 进制如 #3964fe）"
						},
						id: {
							type: "string",
							description: "remove 时的规则 id"
						}
					},
					description: "tag 操作的参数（action=tag 时使用）"
				},
				runId: {
					type: "string",
					description: "clear-alerts 时可选：只清除指定 runId 实验产生的告警（如 run-20260822-017）"
				},
				rule: {
					type: "string",
					description: "clear-alerts 时可选：只清除指定规则（rule）的告警，如 experiment-crash、oom、thermal"
				},
				alertNotify: {
					type: "string",
					enum: [
						"off",
						"notice",
						"wake"
					],
					description: "set-notify 时的通知档位：off=不推送（仅 UI/工具可见）；notice=推送不唤醒（默认）；wake=critical 唤醒处理"
				},
				escalateAfterSec: {
					type: "number",
					description: "set-notify 时可选：warn 持续该秒数 → 通知升级为 critical（0=关闭升级）"
				},
				notifyThrottleMs: {
					type: "number",
					description: "set-notify 时可选：同目标聚合窗口 ms（窗口内最多 1 条通知）"
				},
				op: {
					type: "string",
					enum: [
						"list",
						"delete",
						"clear"
					],
					description: "history-manage 时的操作：list=列出；delete=按 runId 删单条；clear=清空（可 keep 保留最近 N）"
				},
				keep: {
					type: "number",
					description: "history-manage clear 时可选：保留最近 N 条（默认 0=全清）"
				},
				all: {
					type: "boolean",
					description: "sync-swanlab 时可选：是否批量同步全部符合门控的已结束实验"
				},
				force: {
					type: "boolean",
					description: "sync-swanlab 时可选：是否强制重新同步（忽略已同步状态或门控条件）"
				},
				track: {
					type: "object",
					additionalProperties: true,
					properties: {
						op: {
							type: "string",
							enum: [
								"add",
								"remove",
								"list"
							],
							description: "add=注册跟踪规则（label+patterns 或 label+pid）；remove=按 id 删除；list=列出全部"
						},
						label: {
							type: "string",
							description: "规则名（如 \"训练实验A\"、\"推理服务\"）"
						},
						patterns: {
							type: "array",
							items: { type: "string" },
							description: "cmdline 正则列表（任一命中即无条件记为实验并监控；如 \"python.*infer.py\"、\"vllm serve\"）"
						},
						pid: {
							type: "number",
							description: "快速注册：按 pid 取该进程 cmdline 自动生成 pattern（等价规则式，重启后仍命中）"
						},
						color: {
							type: "string",
							description: "展示色（可选，16 进制如 #3964fe）"
						},
						id: {
							type: "string",
							description: "remove 时的规则 id"
						}
					},
					description: "#17 增强：track 操作的参数（action=track 时使用）——显式指定命令作为实验监控"
				}
			},
			output: {
				schema: { type: "json" },
				render: (_args, value) => renderText(value)
			},
			async execute(args) {
				const a = args || {};
				if (a.action === "watch") {
					const kws = Array.isArray(a.keywords) ? a.keywords.filter((k) => typeof k === "string" && k.trim()).map((k) => k.trim()) : [];
					cfg.watchProcs = kws;
					runtimeWatch.clear();
					persistState();
					const wp = buildSnapshot().watchedPids || [];
					return {
						ok: true,
						state: "watchlist-updated",
						keywords: watchSet(),
						matchedPids: wp
					};
				}
				if (a.action === "backend-mode") {
					const m = a.mode;
					if (m === "auto" || m === "windows" || m === "linux") {
						cfg.backendMode = m;
						persistState();
						return sanitizeJson({
							ok: true,
							state: "backend-mode-updated",
							mode: cfg.backendMode,
							note: "生效需重启 DSH（后端在启动时按 backendMode 构建）"
						});
					}
					return sanitizeJson({
						ok: false,
						state: "invalid-mode",
						note: "mode ∈ auto|windows|linux"
					});
				}
				if (a.action === "set-threshold") {
					const thr = {};
					for (const k of [
						"utilWarn",
						"memWarn",
						"tempWarn",
						"pollMs"
					]) {
						const v = a.thresholds && a.thresholds[k];
						if (typeof v === "number" && isFinite(v)) thr[k] = v;
					}
					let ovChanged = false;
					const ov = a.thresholdOverrides;
					if (ov && typeof ov === "object") {
						const cur = thresholds.getOverrides();
						const next = {
							byExpType: ov.byExpType && typeof ov.byExpType === "object" ? ov.byExpType : cur.byExpType || {},
							byTag: ov.byTag && typeof ov.byTag === "object" ? ov.byTag : cur.byTag || {}
						};
						thresholds.setOverrides(next);
						ovChanged = true;
					}
					const r = rpcSetThresholds(thr);
					if (r.applied || ovChanged) persistState();
					return sanitizeJson({
						ok: true,
						applied: r.applied,
						overrides: thresholds.getOverrides(),
						system: lastSystemStats
					});
				}
				if (a.action === "tag") return sanitizeJson(rpcTag(a.tag || {}));
				if (a.action === "clear-alerts") return sanitizeJson(rpcControl({
					action: "clear-alerts",
					runId: a.runId ?? null,
					rule: a.rule ?? null
				}));
				if (a.action === "set-notify") {
					const na = a;
					return sanitizeJson(rpcControl({
						action: "set-notify",
						alertNotify: typeof na.alertNotify === "string" ? na.alertNotify : void 0,
						escalateAfterSec: typeof na.escalateAfterSec === "number" ? na.escalateAfterSec : void 0,
						notifyThrottleMs: typeof na.notifyThrottleMs === "number" ? na.notifyThrottleMs : void 0
					}));
				}
				if (a.action === "history-manage") return sanitizeJson(rpcHistoryManage({
					op: a.op,
					runId: a.runId ?? null,
					keep: a.keep
				}));
				if (a.action === "track") return sanitizeJson(rpcTrack(a.track && typeof a.track === "object" ? a.track : a));
				if (a.action === "switch-device") return sanitizeJson({
					state: "device-switched",
					...await switchDevice(String(a.device || "local"))
				});
				if (a.action === "sync-swanlab") return sanitizeJson(await rpcSwanLabSync({
					runId: a.runId ?? null,
					all: a.all === true,
					force: a.force === true
				}));
				return {
					ok: true,
					state: (await rpcControl({ action: a.action })).state
				};
			}
		})));
		const LAB_CTL_RESTRICTED_WHITELIST = [
			"watch",
			"tag",
			"history-manage"
		];
		try {
			if (ctx.tools && typeof ctx.tools.guard === "function") disposers.push(ctx.tools.guard(((execution) => {
				try {
					if (!execution.agent || !isSubagentAgent(execution.agent)) return void 0;
					if (cfg.subagentPolicy === "full") return void 0;
					if (execution.name === "lab_ctl") {
						if (cfg.subagentPolicy === "restricted") {
							const action = execution.arguments?.action;
							if (typeof action === "string" && LAB_CTL_RESTRICTED_WHITELIST.includes(action)) return void 0;
							return `subagentPolicy=restricted：子代理禁止 lab_ctl（仅白名单动作：${LAB_CTL_RESTRICTED_WHITELIST.join("/")}）`;
						}
						return "subagentPolicy=readonly：子代理禁止 lab_ctl（只读；控制动作仅主代理可用）";
					}
					return;
				} catch (e) {
					console.error("[lab-monitor] guard 判定错误:", e.message);
					return;
				}
			})));
		} catch (e) {
			console.error("[lab-monitor] guard 注册失败:", e.message);
		}
		try {
			const subagentsSvc = ctx.get("subagents");
			if (subagentsSvc && typeof subagentsSvc.registerContinuableSetup === "function") subagentsSvc.registerContinuableSetup((childCtx) => {
				try {
					const cc = childCtx;
					if (cc.tools && typeof cc.tools.register === "function") cc.tools.register(defineTool({
						name: "lab_status_ro",
						description: "Lab Monitor 只读状态查询（子代理专用）：GPU/进程/实验摘要，不可控制。",
						parameters: { brief: {
							type: "boolean",
							description: "true=单行摘要"
						} },
						output: {
							schema: { type: "json" },
							render: (_args, value) => renderText(value)
						},
						async execute(args) {
							const s = buildSnapshot();
							const ro = {
								gpu: s.gpu,
								cpu: s.cpu,
								mem: s.mem,
								procs: (s.procs || []).slice(0, 50),
								experiment: s.experiment,
								ended: (s.ended || []).slice(0, 10),
								alerts: s.alerts
							};
							return sanitizeJson(args && args.brief === true ? {
								ok: true,
								line: promptLine(s)
							} : ro);
						}
					}));
					if (cc.tools && typeof cc.tools.restrict === "function") cc.tools.restrict({ deny: ["lab_ctl"] });
				} catch (e) {
					console.error("[lab-monitor] registerContinuableSetup 注入失败:", e.message);
				}
			});
		} catch (e) {
			console.error("[lab-monitor] registerContinuableSetup 注册失败:", e.message);
		}
		try {
			ctx.on("agent/created", onAgentCreated);
			ctx.on("agent/disposed", onAgentDisposed);
			ctx.on("agent/status", onAgentStatus);
			ctx.on("subagent/end", onSubagentEnd);
			ctx.on("agent/inbox/claimed", ((ev) => {
				const sid = agentSessionId(ev.agent);
				if (sid) claimedTargets.add(sid);
			}));
		} catch (e) {
			console.error("[lab-monitor] agent 事件监听注册失败:", e.message);
		}
		ctx.effect(() => () => disposers.forEach((d) => d()));
	} catch (e) {
		console.error("[lab-monitor] 工具注册失败:", e);
	}
	try {
		const sp = ctx.get("systemPrompt");
		if (sp && cfg.promptInjection) {
			sp.variable("labstatus", () => promptLine(buildSnapshot()));
			sp.section({
				name: "lab-monitor:status",
				order: 150,
				text: "{{labstatus}}"
			});
			console.log("[lab-monitor] prompt 变量 labstatus 已注入（promptInjection=true）");
		} else if (sp && typeof sp.variable === "function") console.log("[lab-monitor] prompt 注入已关闭（KV 缓存友好默认），使用 lab_status 工具按需查询");
	} catch (e) {
		console.error("[lab-monitor] prompt 注册错误:", e);
	}
	const preExecHandler = async (exec, next) => {
		try {
			if (enabled && exec && exec.name === "bash") {
				const args = exec.arguments;
				const cmd = args && args.command !== void 0 ? String(args.command) : null;
				const trackHit = matchTrackRule(cmd);
				if (trackHit) {
					const agent = exec.agent;
					const sessionId = agent && agent.session && agent.session.id ? agent.session.id : agent && agent.id || null;
					const header = agent && agent.session && agent.session.header;
					const isSub = !!header && ((header.delegationDepth ?? 0) > 0 || header.origin === "subagent");
					const run = machine.start(cmd || "", "explicit:" + trackHit.label, {
						agentId: sessionId,
						agentRole: isSub ? "subagent" : "root",
						parentId: header && header.parentSession || null
					}, {
						explicit: true,
						deviceId: backendState.currentDevice || "local"
					});
					if (sessionId) touchAgentRun(sessionId, run.runId);
					console.log("[lab-monitor] 显式跟踪命中:", trackHit.label, "| runId=", run.runId, "| agent=", sessionId || "none", isSub ? "(subagent)" : "", "| cmd=", String(cmd).slice(0, 80));
				} else {
					const feature = matchTrainFeature(cmd);
					if (!feature) return await next();
					const agent = exec.agent;
					const sessionId = agent && agent.session && agent.session.id ? agent.session.id : agent && agent.id || null;
					const header = agent && agent.session && agent.session.header;
					const isSub = !!header && ((header.delegationDepth ?? 0) > 0 || header.origin === "subagent");
					const run = machine.start(cmd || "", feature, {
						agentId: sessionId,
						agentRole: isSub ? "subagent" : "root",
						parentId: header && header.parentSession || null
					}, { deviceId: backendState.currentDevice || "local" });
					if (sessionId) touchAgentRun(sessionId, run.runId);
					console.log("[lab-monitor] 实验开始命中:", feature, "| runId=", run.runId, "| agent=", sessionId || "none", isSub ? "(subagent)" : "", "| cmd=", String(cmd).slice(0, 80));
				}
			}
		} catch (e) {
			console.error("[lab-monitor] pre-execute 处理错误:", e);
		}
		return await next();
	};
	ctx.on("tools/pre-execute", preExecHandler);
	const resultHandler = (exec, result) => {
		try {
			const name = exec && exec.name;
			const args = exec && exec.arguments;
			const cmd = args ? args.command !== void 0 ? String(args.command) : name === "bash" ? null : String(args.code ?? "") : null;
			if (name !== "bash" || cmd === null) return;
			const normCmd = normalizeCmdForMatch(cmd);
			let matchedRunId = null;
			for (const run of machine.all()) {
				if (run.resultSeen) continue;
				let fp = run.fingerprint;
				if (typeof fp === "string" && fp.indexOf("pyc:") === 0) fp = fp.slice(4);
				if (fp && normCmd.indexOf(fp) !== -1) {
					matchedRunId = run.runId;
					break;
				}
			}
			if (matchedRunId) {
				console.log("[lab-monitor] 配对 result 命中，实验结束判定进行中… runId=", matchedRunId);
				machine.markResult(true, matchedRunId);
			} else if (machine.cur()) machine.markResult(false);
		} catch (e) {
			console.error("[lab-monitor] result 处理错误:", e);
		}
	};
	ctx.on("tools/result", resultHandler);
	let scheduledSyncTimer = null;
	function setupScheduledSync() {
		if (scheduledSyncTimer) {
			clearInterval(scheduledSyncTimer);
			scheduledSyncTimer = null;
		}
		if (cfg.swanlab?.triggerMode === "scheduled") {
			const interval = cfg.swanlab.scheduleIntervalMs || 6e4;
			scheduledSyncTimer = setInterval(() => {
				syncAllEligibleRuns(machine.history, {
					config: cfg.swanlab,
					stateMachine: machine,
					ring,
					persistState
				});
			}, interval);
		}
	}
	setupScheduledSync();
	if (typeof ctx.on === "function") ctx.on("dispose", (() => {
		if (scheduledSyncTimer) {
			clearInterval(scheduledSyncTimer);
			scheduledSyncTimer = null;
		}
	}));
	labListeners.push((ev) => {
		if (ev.type === "lab/experiment-end" && ev.runId) {
			if (cfg.swanlab?.triggerMode === "auto") {
				const targetRun = machine.history.find((r) => r.runId === ev.runId);
				if (targetRun) syncRunToSwanLab(targetRun, {
					config: cfg.swanlab,
					stateMachine: machine,
					ring,
					persistState,
					force: false
				});
			}
		}
	});
	console.log("[lab-monitor] 核心引擎已启动（采样 " + cfg.sampleMs + "ms / ps 5000ms）");
}
//#endregion
export { DEFAULT_DEVICES, apply, inject, matchSyncConditions, name, resolveAction, sanitizeCmd, syncAllEligibleRuns, syncRunToSwanLab };
