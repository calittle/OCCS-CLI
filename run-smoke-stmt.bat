@echo off
rem Run the statement smoke test against one environment.
rem Forward smoke options, for example:
rem   run-smoke-stmt.bat --resume

setlocal EnableExtensions

set "CLI_ROOT=%~dp0"
set "SAMPLES_DIR=%OCCS_SAMPLES_DIR%"
if not defined SAMPLES_DIR set "SAMPLES_DIR=%USERPROFILE%\occs-samples\statement"
set "SUITE_FILE=%OCCS_SMOKE_SUITE%"
if not defined SUITE_FILE set "SUITE_FILE=%SAMPLES_DIR%\smoke-statements.json"
set "SMOKE_TARGET=%OCCS_SMOKE_TARGET%"
if not defined SMOKE_TARGET set "SMOKE_TARGET=non-prod"
set "REQUEST_TIMEOUT=%OCCS_SMOKE_TIMEOUT%"
if not defined REQUEST_TIMEOUT set "REQUEST_TIMEOUT=60000"

if not exist "%SUITE_FILE%" (
  >&2 echo Smoke suite not found: %SUITE_FILE%
  >&2 echo Set OCCS_SAMPLES_DIR or OCCS_SMOKE_SUITE to its current location.
  exit /b 1
)

echo.
echo === Regular smoke test: %SMOKE_TARGET% ===
node "%CLI_ROOT%bin\occs.js" smoke --suite "%SUITE_FILE%" --tenancy "%SMOKE_TARGET%" --output "%SAMPLES_DIR%\smoke-output-%SMOKE_TARGET%" --timeout "%REQUEST_TIMEOUT%" %*
if errorlevel 1 exit /b %errorlevel%

echo.
echo Smoke runs complete.
