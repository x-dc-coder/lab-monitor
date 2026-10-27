// ============================================================
// windows-paths.js —— interop 完整路径 + 编码策略常量表
// 位置：plugin/host/sampler/windows-paths.js
// concat 顺序第 2（D4-1）；来源：t10 §4 通道契约表 + 08-sampling-empirical.md 实证
// ============================================================
// 要点（t10 §4）：
// 1. 全部完整路径（裸名不在 WSL PATH，实证 1.4）
// 2. 编码分通道：nvidia-smi 纯 ASCII 免处理 / PowerShell chcp+UTF8 / tasklist GBK→iconv
// 3. 频率分级：dmon 流 1s / query 40-60ms（TTL 500ms 内复用）/ CIM·tasklist ≥5s

var LAB = LAB || {}
LAB.WIN = {
  // —— 完整路径常量（实证：/mnt/c 可用，裸名不在 PATH）——
  NVIDIA_SMI: '/mnt/c/Windows/System32/nvidia-smi.exe',
  POWERSHELL: '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
  TASKLIST: '/mnt/c/Windows/System32/tasklist.exe',

  // —— 编码策略（t10 §4）——
  ENC: {
    SMI: 'ascii',      // nvidia-smi 纯 ASCII，免处理
    PS: 'utf8',        // PowerShell 需 chcp 65001 + OutputEncoding=UTF8
    TASKLIST: 'GBK',   // tasklist 输出 GBK → iconv -f GBK -t UTF-8
  },

  // —— 频率分级（ms）：慢通道集中化/缓存复用 ——
  TTL: {
    QUERY: 500,        // query 40-60ms/次，缓存窗口内不重复 fork（nvitop ttl_cache 模式）
    CIM: 5000,         // PowerShell CIM ~1.5s，仅低频
    TASKLIST: 5000,    // tasklist ~230ms + 闪窗，仅低频
  },

  // —— 命令参数 ——
  // GPU 快照（query）：实测 40-60ms；CSV noheader 行：
  //   index, name, driver, util.gpu(%), memory.used(MiB), memory.total(MiB), temp(C), power(W)
  QUERY_ARGS: [
    '--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw',
    '--format=csv,noheader',
  ],
  // GPU 长驻流（dmon）：1s 行流，-s pucvmet；列：pwr gtemp mtemp sm mem enc dec clocks ...
  DMON_ARGS: ['dmon', '-d', '1', '-s', 'pucvmet'],
  // Windows CPU/内存（CIM）：输出 "cpuLoadPct;totalMemKB;freeMemKB"（UTF8，chcp 已设）
  PS_SYSMEM: [
    '-NoProfile',
    '-Command',
    'chcp 65001|Out-Null; [Console]::OutputEncoding=[Text.Encoding]::UTF8; ' +
      '$p=Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average; ' +
      '$m=Get-CimInstance Win32_OperatingSystem; ' +
      '"{0};{1};{2}" -f $p.Average,$m.TotalVisibleMemorySize,$m.FreePhysicalMemory',
  ],
  // Windows 进程表（tasklist）：CSV 含头部
  TASKLIST_ARGS: ['/FO', 'CSV', '/NH'],
}
