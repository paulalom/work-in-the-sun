param(
    [string]$RepoRoot = (Join-Path $PSScriptRoot ".."),
    [string]$EnvPath = "",
    [string]$LogPath = "",
    [string]$LockoutPath = "",
    [string]$NodePath = ""
)

$ErrorActionPreference = "Stop"

$repoRootPath = [System.IO.Path]::GetFullPath($RepoRoot)
$localDir = Join-Path $repoRootPath ".local"

if (-not $EnvPath) {
    $EnvPath = Join-Path $localDir "service.env"
}

if (-not $LogPath) {
    $LogPath = Join-Path $localDir "backend-service.log"
}

if (-not $LockoutPath) {
    $LockoutPath = Join-Path $localDir "pin-lockout.json"
}

New-Item -ItemType Directory -Force -Path $localDir | Out-Null

function Write-ServiceLog {
    param([string]$Message)
    $line = "$(Get-Date -Format o) $Message"
    Add-Content -LiteralPath $LogPath -Value $line
}

function Import-ServiceEnv {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }

    Get-Content -LiteralPath $Path | ForEach-Object {
        $line = $_.Trim()

        if (-not $line -or $line.StartsWith("#")) {
            return
        }

        $parts = $line.Split("=", 2)

        if ($parts.Count -ne 2 -or -not $parts[0].Trim()) {
            throw "Invalid service env line: $line"
        }

        $name = $parts[0].Trim()
        $value = $parts[1].Trim()

        if ($name -notmatch "^[A-Za-z_][A-Za-z0-9_]*$") {
            throw "Invalid service env variable name: $name"
        }

        if (
            ($value.StartsWith('"') -and $value.EndsWith('"')) -or
            ($value.StartsWith("'") -and $value.EndsWith("'"))
        ) {
            $value = $value.Substring(1, $value.Length - 2)
        }

        [Environment]::SetEnvironmentVariable($name, $value, "Process")
    }
}

try {
    Import-ServiceEnv $EnvPath

    if (-not $env:WITS_PIN_LOCKOUT_PATH) {
        $env:WITS_PIN_LOCKOUT_PATH = $LockoutPath
    }

    if (Test-Path -LiteralPath $env:WITS_PIN_LOCKOUT_PATH) {
        Write-ServiceLog "Not starting backend because PIN lockout exists at $env:WITS_PIN_LOCKOUT_PATH."
        exit 0
    }

    if (-not $NodePath) {
        $nodeCommand = Get-Command node -ErrorAction Stop
        $NodePath = $nodeCommand.Source
    }

    $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue

    if (-not $npmCommand) {
        $npmCommand = Get-Command npm -ErrorAction SilentlyContinue
    }

    if ($npmCommand) {
        Write-ServiceLog "Building frontend UI with $($npmCommand.Source) run ui:build."
        Push-Location $repoRootPath
        try {
            & $npmCommand.Source run ui:build *>> $LogPath
            $buildExitCode = $LASTEXITCODE
        } finally {
            Pop-Location
        }

        if ($buildExitCode -ne 0) {
            throw "Frontend UI build failed with code $buildExitCode."
        }
    } else {
        Write-ServiceLog "npm was not found; backend startup will require an existing frontend build."
    }

    $serverPath = Join-Path $repoRootPath "server.js"

    if (-not (Test-Path -LiteralPath $serverPath)) {
        throw "server.js was not found at $serverPath"
    }

    Write-ServiceLog "Starting backend with $NodePath $serverPath."
    Push-Location $repoRootPath
    try {
        & $NodePath $serverPath *>> $LogPath
        $exitCode = $LASTEXITCODE
    } finally {
        Pop-Location
    }

    Write-ServiceLog "Backend exited with code $exitCode."
    exit $exitCode
} catch {
    Write-ServiceLog "Backend service runner failed: $($_.Exception.Message)"
    throw
}
