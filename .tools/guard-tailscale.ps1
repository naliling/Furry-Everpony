# Tailscale/Funnel 哨兵：每 20 秒确保服务在跑、已登录、Funnel 指向 7788。
# 用 PowerShell 直调 tailscale.exe（node 子进程对 tailscaled 受保护 pipe 没权限）。
$ErrorActionPreference = 'SilentlyContinue'
$Root = 'C:\Users\36328\Documents\deepseek-harness\default-workspace\projects\furry-everpony'
$Log  = Join-Path $Root 'data\logs\watchdog-tailscale.log'
$TS   = 'C:\Program Files\Tailscale\tailscale.exe'
function Log([string]$m) { try { Add-Content -Path $Log -Value ((Get-Date -Format o) + ' ' + $m) -Encoding UTF8 } catch {} }
Log 'tailscale guard started'
while ($true) {
  try {
    $svc = Get-Service Tailscale -ErrorAction SilentlyContinue
    if ($svc -and $svc.Status -ne 'Running') { Log 'service stopped -> starting'; Start-Service Tailscale }
    $st = & $TS status 2>$null
    if ($st -match 'Logged out|NeedsLogin') { Log 'needs login (user action)'; Start-Sleep 20; continue }
    # 无条件幂等重建，Funnel 配置丢了也能自动恢复（地址绑在节点上不变）
    $out = & $TS funnel --bg 7788 2>&1
    if ($LASTEXITCODE -ne 0) { Log ('funnel cmd failed: ' + ($out | Out-String).Substring(0,[Math]::Min(120,($out|Out-String).Length))) }
  } catch { Log ('error: ' + $_.Exception.Message) }
  Start-Sleep 20
}