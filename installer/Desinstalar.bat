@echo off
title Sancho Panza - Age of Empires 2 Fan Companion - desinstalacion
cd /d "%TEMP%"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1"
