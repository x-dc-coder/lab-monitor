// 验证 tagMatches 的匹配行为：哪些 cmd 会被 explorer\.exe|Taskmgr\.exe 误匹配
const re = new RegExp('explorer\\.exe|Taskmgr\\.exe', 'i')
const candidates = [
  'explorer.exe',
  'C:\\Windows\\explorer.exe',
  'msedgewebview2.exe',
  'C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application\\msedgewebview2.exe',
  'Taskmgr.exe',
  'C:\\Windows\\System32\\Taskmgr.exe',
  'WindowsTerminal.exe',
  'explorer.exe /n',
  'rundll32.exe',
  'ShellExperienceHost.exe',
  'SearchHost.exe',
]
for (const c of candidates) {
  console.log((re.test(c) ? '匹配! ' : '不匹配 ') + JSON.stringify(c))
}
