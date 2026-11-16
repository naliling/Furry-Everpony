$ErrorActionPreference = 'Continue'
$conns = Get-NetTCPConnection -LocalPort 7799 -State Listen -ErrorAction SilentlyContinue
foreach ($c in $conns) {
  $pid2 = $c.OwningProcess
  Write-Output ('killing ' + $pid2)
  try { Stop-Process -Id $pid2 -Force -ErrorAction Stop; Write-Output 'stop-process ok' } catch { Write-Output ('stop-process failed: ' + $_.Exception.Message) }
  & cmd /c ("taskkill /F /PID " + $pid2 + " 2>&1") | Out-String | Write-Output
}
Start-Sleep -Milliseconds 900
$left = Get-NetTCPConnection -LocalPort 7799 -State Listen -ErrorAction SilentlyContinue
if ($left) { Write-Output ('STILL_LISTENING ' + $left.OwningProcess) } else { Write-Output 'PORT_FREE' }
