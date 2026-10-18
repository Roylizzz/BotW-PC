# Fetch the names-only symbol data published by the zeldaret/botw project.
#
# These files contain FUNCTION AND DATA SYMBOL NAMES with addresses for the
# Switch 1.5.0 build of the game -- the same game version as our Wii U v208
# target. They contain no game code, no assets and no keys. They are used as
# naming vocabulary for reverse engineering, and are fetched into a local,
# git-ignored folder (symbols-local/). Never commit them: review upstream
# terms first if you plan to redistribute.
#
# Usage (from anywhere):
#   powershell -ExecutionPolicy Bypass -File tools/fetch-symbol-data.ps1
#
# Source: https://github.com/zeldaret/botw (data/ folder).

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$dest = Join-Path $repoRoot "symbols-local"
New-Item -ItemType Directory -Force -Path $dest | Out-Null

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$base = "https://raw.githubusercontent.com/zeldaret/botw/master/data"

foreach ($f in @("uking_functions.csv", "data_symbols.csv", "as_element_vtables.yml")) {
    $out = Join-Path $dest $f
    Write-Output "fetching $f ..."
    Invoke-WebRequest -Uri "$base/$f" -OutFile $out -UseBasicParsing
    $size = (Get-Item $out).Length
    Write-Output ("  -> {0} ({1:N0} bytes)" -f $out, $size)
}

Write-Output "done. The files stay local -- symbols-local/ is git-ignored."
