# 重启 Everony 后台服务端：杀 7788 → 等端口释放 → Start-Process 拉起 launch-server.mjs（它自己 spawn 常驻进程后退出）
$ErrorActionPreference = 'SilentlyContinue'
$root = 'C:\Users\36328\Documents\deepseek-harness\default-workspace\projects\furry-everpony'
function Get-Port7788Pid {
  $line = (netstat -ano | Select-String 'LISTENING' | Select-String ':7788') | Select-Object -First 1
  if (-not $line) { return $null }
  $parts = ($line.ToString() -split '\s+') | Where-Object { $_ -ne '' }
  return [int]$parts[-1]
}
$old = Get-Port7788Pid
if ($old) { Write-Output "old_pid=$old"; Stop-Process -Id $old -Force } else { Write-Output 'old_pid=none' }
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 250
  if (-not (Get-Port7788Pid)) { break }
}
if (Get-Port7788Pid) { Write-Output 'port_still_busy=1'; exit 1 }
$node = Join-Path $root '.tools\node-v22.23.5-win-x64\node.exe'
$launcher = Join-Path $root '.tools\launch-server.mjs'
Start-Process -FilePath $node -ArgumentList $launcher -WorkingDirectory $root -WindowStyle Hidden | Out-Null
Start-Sleep -Seconds 5
$new = Get-Port7788Pid
Write-Output ('new_pid=' + $new)
if ($new) { Write-Output ('hwnd=' + (Get-Process -Id $new).MainWindowHandle) }
