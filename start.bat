@echo off
title WaManager

cd /d "%~dp0"

echo Iniciando WaManager...
echo.

:: Verificar si los contenedores ya existen (fueron detenidos con stop)
docker compose ps -a --format "{{.Name}}" 2>nul | findstr "wa_backend" >nul
if %errorlevel%==0 (
    echo Reiniciando contenedores existentes...
    docker compose start
) else (
    echo Creando contenedores...
    docker compose up -d --build
)

echo.
echo Esperando a que los servicios inicien...
:wait_loop
timeout /t 1 /nobreak >nul
curl -s -o nul -w "%%{http_code}" http://localhost:3000 2>nul | findstr "200" >nul
if errorlevel 1 (
    echo|set /p="."
    goto wait_loop
)

echo.
echo.
echo ========================================
echo   WaManager listo!
echo   http://localhost:3000
echo ========================================
echo.

start http://localhost:3000

echo Presiona cualquier tecla para cerrar.
pause >nul
