# install-logon-task.ps1 — 注册/删除 Windows 登录计划任务 LabMonitorDaemon
# 任务动作：wsl.exe -d <distro> -u dc -- <repo>/scripts/lab-monitord.sh run --supervise
# distro 由 wsl.exe -l -q 动态检测（检测失败才回退硬编码不生效的占位并报错）。
# 用法：powershell -ExecutionPolicy Bypass -File install-logon-task.ps1 [-Unregister]
# 注意：本脚本只在用户显式执行时注册任务；构建/验证流程绝不运行它。
param(
  [switch]$Unregister
)

$ErrorActionPreference = 'Stop'
$TaskName = 'LabMonitorDaemon'

if ($Unregister) {
  $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($existing) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Scheduled task '$TaskName' removed."
  } else {
    Write-Host "Scheduled task '$TaskName' not found; nothing to do."
  }
  exit 0
}

# 检测 WSL 发行版（wsl.exe 输出为 UTF-16，去 BOM/空行）
$distro = $null
try {
  $raw = & wsl.exe -l -q 2>$null
  $lines = ($raw | Out-String) -split "`r?`n" | ForEach-Object { ($_ -replace "\x00", "").Trim() } | Where-Object { $_ -and $_ -notmatch '^(Windows Subsystem|转换|Conversion)' }
  if ($lines.Count -gt 0) { $distro = $lines[0] }
} catch {
  Write-Warning "wsl.exe -l -q failed: $_"
}
if (-not $distro) {
  # 探测失败不写死：报错退出，让用户显式 -Distro
  throw "Could not detect WSL distro via 'wsl.exe -l -q'. Re-run with an explicit distro once detection works."
}
Write-Host "Detected WSL distro: $distro"

# 仓库的 WSL 侧绝对路径：本脚本位于 <repo>/scripts，Windows 盘符 → /mnt/<drive>/...
$scriptWin = $MyInvocation.MyCommand.Path
$drive = $scriptWin.Substring(0, 1).ToLower()
$rest = $scriptWin.Substring(3).Replace('\', '/')
$repoWsl = "/mnt/$drive/$rest" -replace '/scripts/install-logon-task\.ps1$', ''
$wslScript = "$repoWsl/scripts/lab-monitord.sh"

$action = New-ScheduledTaskAction -Execute 'wsl.exe' -Argument "-d $distro -u dc -- $wslScript run --supervise"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Write-Host "Scheduled task '$TaskName' registered (logon, user $env:USERNAME)."
Write-Host "Action: wsl.exe -d $distro -u dc -- $wslScript run --supervise"
Write-Host "Remove with: install-logon-task.ps1 -Unregister"
