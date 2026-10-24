@echo off
setlocal
title MindOverMatter - Permanent LM Studio API
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0bootstrap.ps1" -PermanentTunnel
if errorlevel 1 echo Setup or sharing stopped with an error. The details are above.
pause
