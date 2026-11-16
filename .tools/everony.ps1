param([string]$Action = 'toggle')
# Everony 本机服务端一键开关（2026-11-17）
# 用法：-Action toggle | start | stop | status
$ErrorActionPreference = 'SilentlyContinue'
$Root = 'C:\Users\36328\Documents\deepseek-harness\default-workspace\projects\furry-everpony'
$Node = Join-Path $Root '.tools\node-v22.23.5-win-x64\node.exe'
$Port = 7788
$Url  = 'http://127.0.0.1:' + $Port + '/'
$NL = [char]10

function Show-Popup([string]$Text, [string]$Title) {
  $w = New-Object -ComObject WScript.Shell
  # 3 秒自动关闭，避免无人值守时卡住
  [void]$w.Popup($Text, 3, $Title, 64)
}

function Open-Web {
  $edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
  if (Test-Path $edge) { Start-Process $edge -ArgumentList $Url } else { Write-Output ('open ' + $Url) }
}

function Get-Health {
  try {
    $r = Invoke-WebRequest -Uri ($Url + 'api/health') -TimeoutSec 3 -UseBasicParsing
    if ($r.StatusCode -eq 200) { return ($r.Content | ConvertFrom-Json) }
  } catch { }
  return $null
}

$health = Get-Health
$running = [bool]$health

if ($Action -eq 'status') {
  if ($running) { Write-Output ('RUNNING ' + $health.version) } else { Write-Output 'STOPPED' }
  exit 0
}

if ($Action -eq 'toggle') {
  if ($running) { $Action = 'stop' } else { $Action = 'start' }
}

if ($Action -eq 'start') {
  if ($running) {
    Show-Popup ('服务端已经在运行了' + $NL + '版本 ' + $health.version + $NL + $NL + '正在打开网页…') 'Everony'
    Open-Web
    exit 0
  }
  & $Node (Join-Path $Root '.tools\launch-server.mjs') | Out-Null
  & $Node (Join-Path $Root '.tools\launch-tunnel.mjs') | Out-Null
  for ($i = 0; $i -lt 25; $i++) {
    Start-Sleep -Milliseconds 400
    $health = Get-Health
    if ($health) { break }
  }
  if ($health) {
    Show-Popup ('服务端已启动' + $NL + '版本 ' + $health.version + $NL + '地址 ' + $Url + $NL + $NL + '正在打开网页…') 'Everony'
    Open-Web
  } else {
    Show-Popup ('启动失败：等了 10 秒还没起来' + $NL + $NL + '请把 data\logs 里最新的日志发给我') 'Everony'
  }
  exit 0
}

if ($Action -eq 'stop') {
  $conns = Get-NetTCPConnection -LocalPort $Port -State Listen
  foreach ($c in $conns) {
    if ($c.OwningProcess) { Stop-Process -Id $c.OwningProcess -Force }
  }
  Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*furry-everpony*' } | ForEach-Object { Stop-Process -Id $_.Id -Force }
  Get-Process cloudflared -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.Id -Force }
  Start-Sleep -Milliseconds 600
  if (Get-Health) {
    Show-Popup '停止失败：端口 7788 还被占用着' 'Everony'
  } else {
    Show-Popup '服务端已停止。再双击一次这个开关就能重新启动。' 'Everony'
  }
  exit 0
}
