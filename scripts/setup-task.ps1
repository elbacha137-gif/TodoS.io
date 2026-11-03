# Installs a Windows Scheduled Task that checks your todo deadlines every
# 15 minutes - even when the website is closed.
#
# Run it with:  powershell -ExecutionPolicy Bypass -File scripts\setup-task.ps1
# No administrator rights needed.

$ErrorActionPreference = 'Stop'

$root     = Split-Path -Parent $PSScriptRoot
$script   = Join-Path $root 'scripts\check-reminders.js'
$taskName = 'TodoReminder'

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
    Write-Host ''
    Write-Host '  Node.js was not found in PATH.' -ForegroundColor Red
    Write-Host '  Install it from https://nodejs.org and run this script again.'
    exit 1
}
if (-not (Test-Path $script)) {
    Write-Host "  Could not find $script" -ForegroundColor Red
    exit 1
}

function XmlEscape([string] $value) {
    [System.Security.SecurityElement]::Escape($value)
}

$userId    = "$env:USERDOMAIN\$env:USERNAME"
$start     = (Get-Date).AddMinutes(1).ToString('yyyy-MM-ddTHH:mm:ss')
$escNode   = XmlEscape $node
$escArgs   = XmlEscape ('"' + $script + '"')
$escRoot   = XmlEscape $root
$escUser   = XmlEscape $userId

$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Checks todo deadlines and emails a reminder before they are due.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>$escUser</UserId>
    </LogonTrigger>
    <TimeTrigger>
      <StartBoundary>$start</StartBoundary>
      <Repetition>
        <Interval>PT15M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>$escUser</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT10M</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>$escNode</Command>
      <Arguments>$escArgs</Arguments>
      <WorkingDirectory>$escRoot</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@

$xmlPath = Join-Path $env:TEMP "todo-reminder-task.xml"
[System.IO.File]::WriteAllText($xmlPath, $xml, [System.Text.Encoding]::Unicode)

& schtasks.exe /Create /TN $taskName /XML $xmlPath /F | Out-Null
$code = $LASTEXITCODE
Remove-Item $xmlPath -Force -ErrorAction SilentlyContinue

if ($code -ne 0) {
    Write-Host ''
    Write-Host '  Could not create the scheduled task.' -ForegroundColor Red
    Write-Host '  Open PowerShell as administrator and run this script again:'
    Write-Host "    powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    exit $code
}

Write-Host ''
Write-Host "  [OK] Scheduled task '$taskName' installed." -ForegroundColor Green
Write-Host "       Command : $node `"$script`""
Write-Host '       When    : at logon, then every 15 minutes'
Write-Host ''
Write-Host '  Test it now  :  schtasks /Run /TN TodoReminder'
Write-Host '  Check status :  schtasks /Query /TN TodoReminder /V /FO LIST'
Write-Host '  Remove it    :  powershell -ExecutionPolicy Bypass -File scripts\remove-task.ps1'
Write-Host ''
