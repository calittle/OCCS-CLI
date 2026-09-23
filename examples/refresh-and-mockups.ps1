#requires -Version 5.1
<#
.SYNOPSIS
Refresh a local CCS cache and generate mockups for selected packages.

.DESCRIPTION
The cache is refreshed directly from CCS so `get-everything` can resume
unchanged artifacts. Repeat -Package to select packages. The default packages
are CLP_bills, CLP_letters, CLP_braille, CLP_Emails, and CLP_statements.

Runs in the Windows PowerShell included with Windows and uses only the built-in
robocopy utility. Use -Source to copy an existing get-everything output folder
into the cache without downloading again, or -Occs when the OCCS command is not on PATH.
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
try {
    if ([string]::IsNullOrWhiteSpace($Source)) {
        New-Item -ItemType Directory -Force -Path $Cache, $Mockups | Out-Null
        Write-Host 'Refreshing the communications cache...'
        & $occsCommand.Source get-everything --output $Cache
        if ($LASTEXITCODE -ne 0) {
            throw "occs get-everything failed with exit code $LASTEXITCODE."
        }
        $sourceDir = $Cache
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

    if (-not [string]::IsNullOrWhiteSpace($Source)) {
        New-Item -ItemType Directory -Force -Path $Cache, $Mockups | Out-Null
        Write-Host 'Updating the communications cache from the supplied export...'
        foreach ($outputItem in $outputItems) {
            $cacheItem = Join-Path $Cache $outputItem.Name
            New-Item -ItemType Directory -Force -Path $cacheItem | Out-Null
            & robocopy.exe $outputItem.FullName $cacheItem /E /PURGE /COPY:DAT /DCOPY:DAT /R:2 /W:2 /NFL /NDL
            if ($LASTEXITCODE -gt 7) {
                throw "robocopy failed while syncing $($outputItem.Name) with exit code $LASTEXITCODE."
            }
        }
        $manifest = Join-Path $sourceDir 'get-everything-state.json'
        if (Test-Path -LiteralPath $manifest -PathType Leaf) {
            Copy-Item -LiteralPath $manifest -Destination (Join-Path $Cache 'get-everything-state.json') -Force
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
finally {}
