@echo off
setlocal
title MindOverMatter - Share LM Studio
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0bootstrap.ps1"
if errorlevel 1 echo Setup or sharing stopped with an error. The details are above.
pause
