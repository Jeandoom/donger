# donger release-agent installer (admin PowerShell, run once)
# Registers an S4U boot task running node scripts/release-agent.mjs
# (spec 2026-10-20-release-webhook-design section 5.3); after verifying the task
# enters Running, retires the old 5-min polling task \donger-release-watcher
# (root cause of the popping CMD windows).
# S4U instead of WinSW: the pipeline fetch needs jeandom's ~/.ssh and global
# gitconfig (github proxy / safe.directory). LocalSystem cannot get them, and a
# jeandom+stored-password form breaks on password change. S4U avoids both.
# Rollback (normal PowerShell):
#   schtasks /create /tn "donger-release-watcher" /tr "D:\deploy\donger-docker\donger-release-watcher.cmd" /sc minute /mo 5 /f
#   schtasks /delete /tn "donger-release-agent" /f
$ErrorActionPreference = "Stop"
$resultFile = "D:\deploy\donger-docker\install-release-agent.result.txt"

try {
    $action    = New-ScheduledTaskAction -Execute "C:\nvm4w\nodejs\node.exe" -Argument "scripts\release-agent.mjs" -WorkingDirectory "D:\code\donger"
    $boot      = New-ScheduledTaskTrigger -AtStartup
    $boot.Delay = "PT30S"
    $daily     = New-ScheduledTaskTrigger -Daily -At "03:13"   # daily revive; MultipleInstances=IgnoreNew makes it a no-op when alive
    $principal = New-ScheduledTaskPrincipal -UserId "jeandom" -LogonType S4U -RunLevel Limited
    $settings  = New-ScheduledTaskSettingsSet -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) `
                 -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -StartWhenAvailable `
                 -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName "donger-release-agent" -Action $action -Trigger $boot, $daily -Principal $principal -Settings $settings -Force | Out-Null

    Start-ScheduledTask -TaskName "donger-release-agent"
    Start-Sleep -Seconds 25
    $task = Get-ScheduledTask -TaskName "donger-release-agent"
    $info = Get-ScheduledTaskInfo -TaskName "donger-release-agent"
    if ($task.State -eq "Running") {
        Unregister-ScheduledTask -TaskName "donger-release-watcher" -Confirm:$false
        "OK state=$($task.State) lastResult=$($info.LastTaskResult) old-task donger-release-watcher removed" | Out-File $resultFile -Encoding utf8
    } else {
        "KEEP state=$($task.State) lastResult=$($info.LastTaskResult) (agent not Running, old task kept)" | Out-File $resultFile -Encoding utf8
    }
} catch {
    "ERROR $($_ | Out-String)" | Out-File $resultFile -Encoding utf8
}
