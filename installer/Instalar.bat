@echo off
title Sancho Panza - AOE2 Squier - instalacion
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1"
if errorlevel 1 (
  echo.
  echo Hubo un error. Mandale la captura de esta ventana a Claude para arreglarlo.
)
echo.
pause
