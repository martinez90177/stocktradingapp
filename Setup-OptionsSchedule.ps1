<#
    Registers (or removes) the weekday options-recording run in Windows Task
    Scheduler. This is separate from Setup-Schedule.ps1 (the premarket report)
    because it runs for hours, not seconds: tools/record-options.mjs starts
    before the open, records every minute the market is open, and exits itself
    at the 4:00 bell.

        powershell -ExecutionPolicy Bypass -File .\Setup-OptionsSchedule.ps1
        powershell -ExecutionPolicy Bypass -File .\Setup-OptionsSchedule.ps1 -Remove
        powershell -ExecutionPolicy Bypass -File .\Setup-OptionsSchedule.ps1 -Time "09:15"

    Runs as the current user, no admin rights needed, with no console window:
    the action goes through run-hidden.vbs, which launches
    record-options-scheduled.cmd with a hidden window style rather than the
    console window Task Scheduler would otherwise leave open for the ~6.75
    hours this runs. The time is LOCAL machine time; this machine is on
    Eastern, so it is also market time.
#>
[CmdletBinding()]
param(
    [string]   $Time = "09:15",
    [switch]   $Remove,
    [string]   $TaskName = "Market Prep - Options Recorder"
)

$ErrorActionPreference = "Stop"
$here   = Split-Path -Parent $MyInvocation.MyCommand.Path
$runner = Join-Path $here "record-options-scheduled.cmd"

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

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node -and -not (Test-Path "C:\Program Files\nodejs\node.exe")) {
    throw "Node.js was not found on PATH or at C:\Program Files\nodejs\node.exe."
}
if (-not $env:SCHWAB_APP_KEY -or -not $env:SCHWAB_APP_SECRET) {
    Write-Host "Note: SCHWAB_APP_KEY / SCHWAB_APP_SECRET are not set in this shell." -ForegroundColor Yellow
    Write-Host "The task reads whatever is in the user's persisted environment at run time," -ForegroundColor Yellow
    Write-Host "so this is only a problem if they were never set with setx / [Environment]::SetEnvironmentVariable." -ForegroundColor Yellow
}

$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday, Tuesday, Wednesday, Thursday, Friday `
    -At ([datetime]::ParseExact($Time, "HH:mm", $null))

$hider = Join-Path $here "run-hidden.vbs"
$action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "//B `"$hider`" `"$runner`"" -WorkingDirectory $here

# Runs until the 4:00 bell (about 6h45m from a 9:15 start); the time limit is
# a safety net against a hang, not the normal way this stops.
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -DontStopIfGoingOnBatteries `
    -AllowStartIfOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Hours 8) `
    -MultipleInstances IgnoreNew

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal -Force `
    -Description "Records the real option chain minute by minute during market hours, so the practice terminal uses real contract prices for days this has run." | Out-Null

Write-Host ""
Write-Host "Registered '$TaskName'" -ForegroundColor Green
Write-Host "  Runs   : weekdays at $Time local time, until the 4:00 bell"
Write-Host "  Command: $runner"
Write-Host "  Log    : $(Join-Path $here 'logs\options.log')"
Write-Host "  Output : $(Join-Path $here 'options\<SYMBOL>\<date>.json')"
Write-Host ""
Write-Host "Run it once now to confirm it works (only useful while the market is open):" -ForegroundColor Cyan
Write-Host "  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host ""
