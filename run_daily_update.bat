@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist "logs" mkdir "logs"
echo [%date% %time%] Starting daily dashboard update... >> "logs\update.log"
python -u "scripts\update_daily.py" >> "logs\update.log" 2>&1
if %errorlevel% equ 0 (
    echo [%date% %time%] Data update completed successfully. >> "logs\update.log"
    if exist ".git" (
        git add data\ dist\ >> "logs\update.log" 2>&1
        git diff --cached --quiet || (
            git commit -m "chore: daily market data update (%date%)" >> "logs\update.log" 2>&1
            git push >> "logs\update.log" 2>&1
            echo [%date% %time%] Pushed updated data to GitHub Pages. >> "logs\update.log"
        )
    )
) else (
    echo [%date% %time%] Update failed with exit code %errorlevel%. >> "logs\update.log"
)
