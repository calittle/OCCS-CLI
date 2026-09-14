#requires -Version 5.1
<#
.SYNOPSIS
Refresh a local CCS cache and generate mockups for selected packages.

.DESCRIPTION
The cache is mirrored from a fresh CCS export, so artifacts absent from the
export are removed. Repeat -Package to select packages. The default packages
are CLP_bills, CLP_letters, CLP_braille, CLP_Emails, and CLP_statements.

Runs in the Windows PowerShell included with Windows and uses only the built-in
robocopy utility. Use -Source to reuse an existing get-everything output folder
without downloading again, or -Occs when the OCCS command is not on PATH.
#>
[CmdletBinding()]
param(
    [string]$Cache = (Join-Path (Get-Location) 'comms-cache'),
    [string]$Mockups = (Join-Path (Get-Location) 'mockups'),
    [string]$Occs = 'occs',
    [string]$Source,
    [string[]]$Package = @(
        'CLP_bills',
        'CLP_letters',
        'CLP_braille',
        'CLP_Emails',
        'CLP_statements'
    )
)

$ErrorActionPreference = 'Stop'

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'This script requires Windows.'
}

$occsCommand = Get-Command -Name $Occs -CommandType Application, ExternalScript -ErrorAction SilentlyContinue |
    Select-Object -First 1
if (-not $occsCommand) {
    throw "OCCS command '$Occs' was not found. Install OCCS on PATH or pass -Occs C:\path\to\occs.cmd."
}
if (-not (Get-Command robocopy.exe -ErrorAction SilentlyContinue)) {
    throw 'robocopy.exe is not available on PATH.'
}

$Cache = [System.IO.Path]::GetFullPath($Cache)
$Mockups = [System.IO.Path]::GetFullPath($Mockups)
$stagingDir = $null

try {
    if ([string]::IsNullOrWhiteSpace($Source)) {
        $stagingDir = Join-Path ([System.IO.Path]::GetTempPath()) "occs-refresh-$([guid]::NewGuid())"
        New-Item -ItemType Directory -Path $stagingDir | Out-Null
        Write-Host 'Downloading the latest CCS artifacts...'
        Push-Location $stagingDir
        try {
            & $occsCommand.Source get-everything
            if ($LASTEXITCODE -ne 0) {
                throw "occs get-everything failed with exit code $LASTEXITCODE."
            }
        }
        finally {
            Pop-Location
        }
        $sourceDir = Join-Path $stagingDir 'output'
    }
    else {
        $sourceDir = [System.IO.Path]::GetFullPath($Source)
        Write-Host "Using existing local export at $sourceDir..."
    }

    if (-not (Test-Path -LiteralPath $sourceDir -PathType Container)) {
        throw "No completed local export was found at $sourceDir."
    }
    $outputItems = @(Get-ChildItem -LiteralPath $sourceDir -Directory -Force)
    if ($outputItems.Count -eq 0) {
        throw "No artifact folders were found in $sourceDir."
    }

    New-Item -ItemType Directory -Force -Path $Cache, $Mockups | Out-Null
    Write-Host 'Updating the communications cache...'
    foreach ($outputItem in $outputItems) {
        $cacheItem = Join-Path $Cache $outputItem.Name
        New-Item -ItemType Directory -Force -Path $cacheItem | Out-Null
        & robocopy.exe $outputItem.FullName $cacheItem /E /PURGE /COPY:DAT /DCOPY:DAT /R:2 /W:2 /NFL /NDL
        if ($LASTEXITCODE -gt 7) {
            throw "robocopy failed while syncing $($outputItem.Name) with exit code $LASTEXITCODE."
        }
    }

    $packagesRoot = Join-Path $Cache 'packages'
    foreach ($packageName in $Package) {
        $packageDir = Join-Path $packagesRoot $packageName
        if (-not (Test-Path -LiteralPath $packageDir -PathType Container)) {
            throw "Package $packageName was not found in $packagesRoot."
        }
        $packageMockups = Join-Path $Mockups $packageName
        New-Item -ItemType Directory -Force -Path $packageMockups | Out-Null
        Write-Host "Generating mockups for $packageName..."
        & $occsCommand.Source mockup --cache $Cache --package $packageName --all --output $packageMockups
        if ($LASTEXITCODE -ne 0) {
            throw "occs mockup failed for $packageName with exit code $LASTEXITCODE."
        }
    }

    Write-Host "Done. Mockups are in $Mockups."
}
finally {
    if ($stagingDir -and (Test-Path -LiteralPath $stagingDir)) {
        Remove-Item -LiteralPath $stagingDir -Recurse -Force
    }
}
