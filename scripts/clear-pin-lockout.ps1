param(
    [string]$LockoutPath = (Join-Path $PSScriptRoot "..\.local\pin-lockout.json")
)

$ErrorActionPreference = "Stop"

$resolvedPath = [System.IO.Path]::GetFullPath($LockoutPath)

if (Test-Path -LiteralPath $resolvedPath) {
    Remove-Item -LiteralPath $resolvedPath -Force
    Write-Host "Cleared PIN lockout: $resolvedPath"
} else {
    Write-Host "No PIN lockout found at $resolvedPath"
}
