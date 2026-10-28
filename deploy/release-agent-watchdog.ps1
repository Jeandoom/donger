$ErrorActionPreference = 'Stop'
$action = New-ScheduledTaskAction -Execute 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -Argument '-NoProfile -WindowStyle Hidden -Command "if (-not (Get-CimInstance Win32_Process | Where-Object { $_.Name -eq ''node.exe'' -and $_.CommandLine -match ''release-agent.mjs'' })) { Start-ScheduledTask -TaskName ''donger-release-agent'' }"'
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$principal = New-ScheduledTaskPrincipal -UserId 'jeandom' -LogonType S4U -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -StartWhenAvailable
Register-ScheduledTask -TaskName 'donger-release-watchdog' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Write-Output 'watchdog registered'
