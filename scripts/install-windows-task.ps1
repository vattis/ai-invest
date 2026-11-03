param([switch]$Market)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
foreach ($file in @('.env.pc.local', '.env.pc.worker.local')) {
    if (-not (Test-Path (Join-Path $projectRoot $file))) { throw "Run npm run setup:local first: $file is missing" }
}
$nodeExecutable = (Get-Command node -ErrorAction Stop).Source
$account = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$arguments = 'scripts/run-local.mjs'
if ($Market) { $arguments += ' --market' }
$action = New-ScheduledTaskAction -Execute $nodeExecutable -Argument $arguments -WorkingDirectory $projectRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $account
$principal = New-ScheduledTaskPrincipal -UserId $account -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'AIInvestLocal' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Local paper trading dashboard and Codex worker; no real orders' -Force | Out-Null
Write-Output 'AIInvestLocal registered for logon. Start it with: Start-ScheduledTask AIInvestLocal'
