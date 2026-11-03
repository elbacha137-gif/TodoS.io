# Removes the TodoReminder scheduled task.

$taskName = 'TodoReminder'

& schtasks.exe /Query /TN $taskName *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Host "  No scheduled task named '$taskName' was found." -ForegroundColor Yellow
    exit 0
}

& schtasks.exe /Delete /TN $taskName /F | Out-Null
if ($LASTEXITCODE -eq 0) {
    Write-Host "  [OK] Scheduled task '$taskName' removed." -ForegroundColor Green
} else {
    Write-Host '  Could not remove the task. Try PowerShell as administrator.' -ForegroundColor Red
    exit 1
}
