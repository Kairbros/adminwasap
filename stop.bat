@echo off
title WaManager - Detener

cd /d "%~dp0"

echo Deteniendo WaManager...
echo.

docker compose stop

echo.
echo WaManager detenido.
pause
