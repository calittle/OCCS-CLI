@echo off
rem Run the statement comparison from non-production to pre-production.
rem Forward smoke options, for example:
rem   run-smoke-compare-stmt.bat --resume

setlocal EnableExtensions

set "CLI_ROOT=%~dp0"
set "SAMPLES_DIR=%OCCS_SAMPLES_DIR%"
if not defined SAMPLES_DIR set "SAMPLES_DIR=C:\Users\clittle\Library\CloudStorage\OneDrive-OracleCorporation\Project Repository\400243832 - Example CCS Implementation\working\samples\statement"
set "SUITE_FILE=%OCCS_SMOKE_SUITE%"
if not defined SUITE_FILE set "SUITE_FILE=%SAMPLES_DIR%\smoke-statements.json"
set "COMPARE_SOURCE=%OCCS_COMPARE_SOURCE%"
if not defined COMPARE_SOURCE set "COMPARE_SOURCE=non-prod"
set "COMPARE_TARGET=%OCCS_COMPARE_TARGET%"
if not defined COMPARE_TARGET set "COMPARE_TARGET=pre-prod"
set "REQUEST_TIMEOUT=%OCCS_SMOKE_TIMEOUT%"
if not defined REQUEST_TIMEOUT set "REQUEST_TIMEOUT=60000"

if not exist "%SUITE_FILE%" (
  >&2 echo Smoke suite not found: %SUITE_FILE%
  >&2 echo Set OCCS_SAMPLES_DIR or OCCS_SMOKE_SUITE to its current location.
  exit /b 1
)

echo.
echo === Smoke comparison: %COMPARE_SOURCE% vs %COMPARE_TARGET% ===
node "%CLI_ROOT%bin\occs.js" smoke --suite "%SUITE_FILE%" --tenancy "%COMPARE_SOURCE%" --compare-tenancy "%COMPARE_TARGET%" --output "%SAMPLES_DIR%\smoke-output-%COMPARE_SOURCE%-vs-%COMPARE_TARGET%" --timeout "%REQUEST_TIMEOUT%" %*
if errorlevel 1 exit /b %errorlevel%

echo.
echo Smoke runs complete.
