# 一键注册 Windows 每日定时任务（每日 23:05 自动更新看板数据）
# 用法：在项目根目录以 PowerShell 运行 .\register_task.ps1

$ErrorActionPreference = "Stop"
$TaskName = "MarketDashboardDailyUpdate"
$BatPath = Join-Path $PSScriptRoot "run_daily_update.bat"

$Action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$BatPath`"" -WorkingDirectory $PSScriptRoot
$Trigger = New-ScheduledTaskTrigger -Daily -At 23:05
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Description "每日 23:05 自动更新多资产投研监控看板数据" -Force | Out-Null

Write-Host "已注册 Windows 每日定时任务: $TaskName（每日 23:05 执行 $BatPath）" -ForegroundColor Green
Write-Host "如需立即测试，可运行: Start-ScheduledTask -TaskName $TaskName"
