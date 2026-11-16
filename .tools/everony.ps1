param([string]$Action = 'toggle')
# Everony 本机服务端一键开关（2026-11-17）
# 用法：-Action toggle | start | stop | status
# 点一下必须立刻有反应：先弹「正在启动/停止」，做完再弹结果（版本 + 本机 + 局域网 + 外网地址）
$ErrorActionPreference = 'SilentlyContinue'
$Root = 'C:\Users\36328\Documents\deepseek-harness\default-workspace\projects\furry-everpony'
$Node = Join-Path $Root '.tools\node-v22.23.5-win-x64\node.exe'
$Port = 7788
$Url  = 'http://127.0.0.1:' + $Port + '/'
$NL = [char]10

function Show-Popup([string]$Text, [string]$Title, [int]$Seconds = 5) {
  $w = New-Object -ComObject WScript.Shell
  # 自动关闭，不阻塞到用户点确定
  [void]$w.Popup($Text, $Seconds, $Title, 64)
}

function Open-Web {
  $edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
  if (Test-Path $edge) { Start-Process $edge -ArgumentList $Url } else { Start-Process $Url }
}

function Get-Health {
  try {
    $r = Invoke-WebRequest -Uri ($Url + 'api/health') -TimeoutSec 3 -UseBasicParsing
    if ($r.StatusCode -eq 200) { return ($r.Content | ConvertFrom-Json) }
  } catch { }
  return $null
}

function Get-LanIp {
  try {
    $ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
      Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
      Select-Object -First 1).IPAddress
    return $ip
  } catch { return '' }
}

function Get-TunnelUrl {
  try {
    $f = Join-Path $Root 'data\tunnel.json'
    if (Test-Path $f) {
      $j = Get-Content $f -Raw | ConvertFrom-Json
      if ($j.url) { return [string]$j.url }
    }
  } catch { }
  return ''
}

function Describe([object]$Health) {
  $lan = Get-LanIp
  $tun = Get-TunnelUrl
  $lines = @()
  $lines += '版本 ' + $Health.version
  $lines += '本机 ' + $Url
  if ($lan) { $lines += '局域网 http://' + $lan + ':' + $Port + '/' }
  if ($tun) { $lines += '外网 ' + $tun }
  return ($lines -join $NL)
}

# 防连点：同一时间只允许一个开关在跑
$mutex = New-Object System.Threading.Mutex($false, 'Global\EveronySwitch')
if (-not $mutex.WaitOne(0)) {
  Show-Popup '正在处理上一个操作，稍等一下…' 'Everony' 3
  exit 0
}

try {
  $health = Get-Health
  $running = [bool]$health

  if ($Action -eq 'status') {
    if ($running) {
      Show-Popup ('正在运行' + $NL + (Describe $health)) 'Everony 状态' 8
      Write-Output ('RUNNING ' + $health.version)
    } else {
      Show-Popup ('服务端没有在运行。' + $NL + $NL + '双击桌面开关即可启动。') 'Everony 状态' 5
      Write-Output 'STOPPED'
    }
    exit 0
  }

  if ($Action -eq 'toggle') {
    if ($running) { $Action = 'stop' } else { $Action = 'start' }
  }

  if ($Action -eq 'start') {
    if ($running) {
      Show-Popup ('已经在运行了，直接打开网页' + $NL + (Describe $health)) 'Everony' 4
      Open-Web
      exit 0
    }
    Show-Popup ('正在启动，最多等十几秒…' + $NL + $NL + '启动完会自动打开网页') 'Everony' 3
    & $Node (Join-Path $Root '.tools\launch-server.mjs') | Out-Null
    & $Node (Join-Path $Root '.tools\launch-tunnel.mjs') | Out-Null
    for ($i = 0; $i -lt 40; $i++) {
      Start-Sleep -Milliseconds 400
      $health = Get-Health
      if ($health) { break }
    }
    if ($health) {
      Show-Popup ('已启动' + $NL + $NL + (Describe $health) + $NL + $NL + '正在打开网页…') 'Everony' 6
      Open-Web
    } else {
      Show-Popup ('启动失败：等了 16 秒还没起来' + $NL + $NL + '日志在 data\logs 里，把最新的发给我') 'Everony 启动失败' 10
    }
    exit 0
  }

  if ($Action -eq 'stop') {
    Show-Popup ('正在停止…') 'Everony' 2
    $conns = Get-NetTCPConnection -LocalPort $Port -State Listen
    foreach ($c in $conns) {
      if ($c.OwningProcess) { Stop-Process -Id $c.OwningProcess -Force }
    }
    Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*furry-everpony*' } | ForEach-Object { Stop-Process -Id $_.Id -Force }
    Get-Process cloudflared -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.Id -Force }
    Start-Sleep -Milliseconds 700
    if (Get-Health) {
      Show-Popup ('停止失败：端口 7788 还被占用着' + $NL + $NL + '再双击一次试试') 'Everony' 6
    } else {
      Show-Popup ('已停止' + $NL + $NL + '再双击一次开关就能重新启动') 'Everony' 5
    }
    exit 0
  }
} finally {
  $mutex.ReleaseMutex()
  $mutex.Dispose()
}
