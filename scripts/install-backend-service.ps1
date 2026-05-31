param(
    [ValidateSet("Install", "Uninstall", "Start", "Stop", "Status")]
    [string]$Action = "Install",
    [string]$TaskName = "WorkInTheSunBackend",
    [switch]$StartNow
)

$ErrorActionPreference = "Stop"

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$runner = Join-Path $PSScriptRoot "backend-service-runner.ps1"
$startupPath = Join-Path ([Environment]::GetFolderPath("Startup")) "$TaskName.cmd"

function Get-PowerShellPath {
    $pwsh = Get-Command pwsh -ErrorAction SilentlyContinue

    if ($pwsh) {
        return $pwsh.Source
    }

    return (Get-Command powershell -ErrorAction Stop).Source
}

function Get-BackendTask {
    Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}

function Get-BackendProcesses {
    $escapedRepo = $repoRoot.Replace("\", "\\")
    Get-CimInstance Win32_Process |
        Where-Object {
            $_.Name -match "^(node|node.exe|powershell|powershell.exe|pwsh|pwsh.exe)$" -and
            $_.CommandLine -and
            ($_.CommandLine.Contains($repoRoot) -or $_.CommandLine.Contains($escapedRepo)) -and
            ($_.CommandLine.Contains("server.js") -or $_.CommandLine.Contains("backend-service-runner.ps1"))
        }
}

function Install-StartupCommand {
    $psPath = Get-PowerShellPath
    $content = @"
@echo off
cd /d "$repoRoot"
"$psPath" -NoProfile -ExecutionPolicy Bypass -File "$runner"
"@

    Set-Content -LiteralPath $startupPath -Value $content -Encoding ASCII
    Write-Host "Installed Startup entry '$startupPath'."
}

function Show-TaskStatus {
    $task = Get-BackendTask

    if ($task) {
        $info = Get-ScheduledTaskInfo -TaskName $TaskName
        Write-Host "Task: $TaskName"
        Write-Host "State: $($task.State)"
        Write-Host "Last run: $($info.LastRunTime)"
        Write-Host "Last result: $($info.LastTaskResult)"
        Write-Host "Next run: $($info.NextRunTime)"
    } else {
        Write-Host "Scheduled task '$TaskName' is not installed."
    }

    if (Test-Path -LiteralPath $startupPath) {
        Write-Host "Startup entry: $startupPath"
    } else {
        Write-Host "Startup entry is not installed."
    }

    $processes = @(Get-BackendProcesses)

    if ($processes.Count) {
        Write-Host "Matching backend processes: $($processes.ProcessId -join ', ')"
    } else {
        Write-Host "No matching backend process found."
    }
}

if (-not (Test-Path -LiteralPath $runner)) {
    throw "Service runner was not found at $runner"
}

switch ($Action) {
    "Install" {
        try {
            $existing = Get-BackendTask

            if ($existing) {
                Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
            }

            $psPath = Get-PowerShellPath
            $taskAction = New-ScheduledTaskAction `
                -Execute $psPath `
                -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$runner`"" `
                -WorkingDirectory $repoRoot
            $trigger = New-ScheduledTaskTrigger -AtLogOn
            $principal = New-ScheduledTaskPrincipal `
                -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
                -LogonType Interactive `
                -RunLevel Limited
            $settings = New-ScheduledTaskSettingsSet `
                -StartWhenAvailable `
                -RestartCount 3 `
                -RestartInterval (New-TimeSpan -Minutes 1) `
                -ExecutionTimeLimit (New-TimeSpan -Days 7)

            Register-ScheduledTask `
                -TaskName $TaskName `
                -Action $taskAction `
                -Trigger $trigger `
                -Principal $principal `
                -Settings $settings `
                -Description "Starts the Work in the Sun backend when this user signs in, unless a failed-PIN lockout marker exists." `
                | Out-Null

            Write-Host "Installed scheduled task '$TaskName'."

            if ($StartNow) {
                Start-ScheduledTask -TaskName $TaskName
                Write-Host "Started '$TaskName'."
            }
        } catch {
            Write-Warning "Scheduled Task install failed: $($_.Exception.Message)"
            Write-Warning "Falling back to the current user's Startup folder."
            Install-StartupCommand

            if ($StartNow) {
                $psPath = Get-PowerShellPath
                Start-Process -WindowStyle Hidden -FilePath $psPath -ArgumentList @(
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    $runner
                ) -WorkingDirectory $repoRoot
                Write-Host "Started backend runner."
            }
        }
    }

    "Uninstall" {
        if (Get-BackendTask) {
            Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
            Write-Host "Uninstalled scheduled task '$TaskName'."
        } else {
            Write-Host "Scheduled task '$TaskName' is not installed."
        }

        if (Test-Path -LiteralPath $startupPath) {
            Remove-Item -LiteralPath $startupPath -Force
            Write-Host "Removed Startup entry '$startupPath'."
        }
    }

    "Start" {
        $task = Get-BackendTask

        if ($task) {
            Start-ScheduledTask -TaskName $TaskName
            Write-Host "Started '$TaskName'."
        } else {
            $psPath = Get-PowerShellPath
            Start-Process -WindowStyle Hidden -FilePath $psPath -ArgumentList @(
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                $runner
            ) -WorkingDirectory $repoRoot
            Write-Host "Started backend runner."
        }
    }

    "Stop" {
        $task = Get-BackendTask

        if ($task) {
            Stop-ScheduledTask -TaskName $TaskName
            Write-Host "Stopped '$TaskName'."
        }

        $processes = @(Get-BackendProcesses)

        foreach ($process in $processes) {
            Stop-Process -Id $process.ProcessId -Force
            Write-Host "Stopped process $($process.ProcessId)."
        }

        if (-not $task -and -not $processes.Count) {
            Write-Host "No backend service process found."
        }
    }

    "Status" {
        Show-TaskStatus
    }
}
