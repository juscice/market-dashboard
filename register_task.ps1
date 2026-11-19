# 一键注册 Windows 每日四次定时任务（每日 09:00 / 11:30 / 15:00 / 22:30 自动更新数据并同步公网看板）
# 用法：在项目根目录以 PowerShell 运行 .\register_task.ps1

$ErrorActionPreference = "Stop"
$TaskName = "MarketDashboardDailyUpdate"
$BatPath = Join-Path $PSScriptRoot "run_daily_update.bat"

$Action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$BatPath`"" -WorkingDirectory $PSScriptRoot
$Triggers = @(
    (New-ScheduledTaskTrigger -Daily -At "09:00"),
    (New-ScheduledTaskTrigger -Daily -At "11:30"),
    (New-ScheduledTaskTrigger -Daily -At "15:00"),
    (New-ScheduledTaskTrigger -Daily -At "22:30")
)
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Triggers -Settings $Settings -Description "每日 09:00 / 11:30 / 15:00 / 22:30 自动更新双网址投研监控看板并推送至 GitHub Pages" -Force | Out-Null

Write-Host "已注册 Windows 每日定时任务: $TaskName（每日 09:00 / 11:30 / 15:00 / 22:30 执行）" -ForegroundColor Green
Write-Host "如需立即测试，可运行: Start-ScheduledTask -TaskName $TaskName"
