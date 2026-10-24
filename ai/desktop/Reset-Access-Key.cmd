@echo off
setlocal
title MindOverMatter - Reset access key
echo Close the sharing window first. This will replace your private access key.
echo Anyone using the old key will need the new one.
choice /C YN /M "Replace the access key"
if errorlevel 2 exit /b
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0bootstrap.ps1" -RotateKey
pause
