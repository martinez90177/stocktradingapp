<#
    Registers (or removes) the weekday pre-market runs in Windows Task Scheduler.

        powershell -ExecutionPolicy Bypass -File .\Setup-Schedule.ps1
        powershell -ExecutionPolicy Bypass -File .\Setup-Schedule.ps1 -Remove
        powershell -ExecutionPolicy Bypass -File .\Setup-Schedule.ps1 -Times "07:45","09:20"

    Runs as the current user, no admin rights needed. Times are LOCAL machine
    time; this machine is on Eastern, so they are also market time.
#>
[CmdletBinding()]
param(
    [string[]] $Times = @("08:15", "09:20"),
    [switch]   $Remove,
    [string]   $TaskName = "Market Prep - Premarket Report"
)

$ErrorActionPreference = "Stop"
$here   = Split-Path -Parent $MyInvocation.MyCommand.Path
$runner = Join-Path $here "run-scheduled.cmd"

if ($Remove) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Removed scheduled task '$TaskName'." -ForegroundColor Yellow
    } else {
        Write-Host "No scheduled task named '$TaskName' was registered." -ForegroundColor Yellow
    }
    return
}

if (-not (Test-Path $runner)) { throw "Cannot find $runner" }

# Confirm node is reachable before scheduling something that would fail at 8am.
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node -and -not (Test-Path "C:\Program Files\nodejs\node.exe")) {
    throw "Node.js was not found on PATH or at C:\Program Files\nodejs\node.exe."
}

$triggers = foreach ($t in $Times) {
    $parsed = [datetime]::ParseExact($t, "HH:mm", $null)
    New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday, Tuesday, Wednesday, Thursday, Friday -At $parsed
}

$action = New-ScheduledTaskAction -Execute $runner -WorkingDirectory $here

# StartWhenAvailable matters: if the machine was asleep at 8:15, the run happens
# on wake instead of being skipped for the day.
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -DontStopIfGoingOnBatteries `
    -AllowStartIfOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 20) `
    -MultipleInstances IgnoreNew

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers `
    -Settings $settings -Principal $principal -Force `
    -Description "Generates the Market Prep watchlist report into OneDrive before the open." | Out-Null

Write-Host ""
Write-Host "Registered '$TaskName'" -ForegroundColor Green
Write-Host "  Runs   : weekdays at $($Times -join ' and ') local time"
Write-Host "  Command: $runner"
Write-Host "  Report : $(Join-Path $here 'reports\latest.html')"
Write-Host "  Log    : $(Join-Path $here 'logs\run.log')"
Write-Host ""
Write-Host "Run it once now to confirm it works:" -ForegroundColor Cyan
Write-Host "  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host ""
