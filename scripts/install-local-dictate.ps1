param(
    [string]$Repo = "paulalom/local-dictate",
    [string]$Version = "latest",
    [string]$InstallDir = (Join-Path $PSScriptRoot "..\vendor\local-dictate")
)

$ErrorActionPreference = "Stop"

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$installPath = [System.IO.Path]::GetFullPath($InstallDir)
$vendorRoot = [System.IO.Path]::GetFullPath((Join-Path $repoRoot "vendor"))

if (-not $vendorRoot.EndsWith([System.IO.Path]::DirectorySeparatorChar)) {
    $vendorRoot = "$vendorRoot$([System.IO.Path]::DirectorySeparatorChar)"
}

if (-not $installPath.StartsWith($vendorRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "InstallDir must stay inside the project vendor directory: $installPath"
}

$platform = if ($IsWindows -or $env:OS -eq "Windows_NT") {
    "windows-x64"
} elseif ($IsMacOS) {
    "macos-universal"
} elseif ($IsLinux) {
    "linux-x64"
} else {
    throw "Unsupported platform."
}

$releaseUrl = if ($Version -eq "latest") {
    "https://api.github.com/repos/$Repo/releases/latest"
} else {
    "https://api.github.com/repos/$Repo/releases/tags/$Version"
}

$release = Invoke-RestMethod -Headers @{ "User-Agent" = "work-in-the-sun" } -Uri $releaseUrl
$asset = $release.assets |
    Where-Object { $_.name -like "local-dictate-*-$platform.*" } |
    Select-Object -First 1

if (-not $asset) {
    throw "No Local Dictate release asset found for $platform in $($release.tag_name)."
}

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) "work-in-the-sun-local-dictate-$([System.Guid]::NewGuid())"
$archivePath = Join-Path $tempRoot $asset.name
$extractRoot = Join-Path $tempRoot "extract"

New-Item -ItemType Directory -Force -Path $tempRoot, $extractRoot, (Split-Path $installPath -Parent) | Out-Null

try {
    Write-Host "Downloading $($asset.name) from $($release.tag_name)..."
    Invoke-WebRequest -Headers @{ "User-Agent" = "work-in-the-sun" } -Uri $asset.browser_download_url -OutFile $archivePath

    if ($asset.name.EndsWith(".zip")) {
        Expand-Archive -LiteralPath $archivePath -DestinationPath $extractRoot -Force
    } else {
        & tar -xzf $archivePath -C $extractRoot
    }

    $packageDir = Get-ChildItem -LiteralPath $extractRoot -Directory |
        Where-Object { $_.Name -like "local-dictate-*-$platform" } |
        Select-Object -First 1

    if (-not $packageDir) {
        throw "Could not find extracted Local Dictate package directory."
    }

    if (Test-Path -LiteralPath $installPath) {
        Remove-Item -LiteralPath $installPath -Recurse -Force
    }

    Move-Item -LiteralPath $packageDir.FullName -Destination $installPath

    $manifest = @{
        repo = $Repo
        tag = $release.tag_name
        asset = $asset.name
        installedAt = (Get-Date).ToString("o")
    } | ConvertTo-Json

    Set-Content -LiteralPath (Join-Path $installPath "install-manifest.json") -Value $manifest
    Write-Host "Installed Local Dictate $($release.tag_name) to $installPath"
} finally {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
