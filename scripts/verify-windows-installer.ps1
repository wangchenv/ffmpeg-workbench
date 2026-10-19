[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$InstallerPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') {
    throw 'This smoke test must run on Windows.'
}

$installer = (Resolve-Path -LiteralPath $InstallerPath).ProviderPath
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
    throw "Installer is not a regular file: $installer"
}

$temporaryRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }
$installDirectory = [IO.Path]::GetFullPath((Join-Path $temporaryRoot 'ffmpeg-workbench-smoke'))
if ($installDirectory -match '\s') {
    throw "Use a RUNNER_TEMP path without spaces for the NSIS /D smoke test: $installDirectory"
}
if (Test-Path -LiteralPath $installDirectory) {
    throw "Refusing to use an existing smoke-test installation directory: $installDirectory"
}

$applicationPath = Join-Path $installDirectory 'ffmpeg-workbench.exe'
$uninstallerPath = Join-Path $installDirectory 'uninstall.exe'
$evidencePath = Join-Path $temporaryRoot 'ffmpeg-workbench-windows-smoke.json'
$installerProcess = $null
$applicationProcess = $null
$failure = $null
$cleanupFailures = [Collections.Generic.List[string]]::new()
$evidence = [ordered]@{
    installer = $installer
    installerSha256 = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
    installDirectory = $installDirectory
    installed = $false
    applicationVersion = $null
    applicationProcessId = $null
    applicationAliveSeconds = 0
    mainWindowObserved = $false
    uninstalled = $false
    passed = $false
}

function Wait-SmokeProcess {
    param(
        [Parameter(Mandatory = $true)][Diagnostics.Process]$Process,
        [Parameter(Mandatory = $true)][int]$TimeoutSeconds,
        [Parameter(Mandatory = $true)][string]$Operation
    )

    if (-not $Process.WaitForExit($TimeoutSeconds * 1000)) {
        throw "$Operation timed out after $TimeoutSeconds seconds (PID $($Process.Id))."
    }
    $Process.Refresh()
    # 3010 is Windows' success-with-reboot-required result. The launch check
    # below must still pass before this package can be accepted.
    if ($Process.ExitCode -notin @(0, 3010)) {
        throw "$Operation failed with exit code $($Process.ExitCode)."
    }
    return $Process.ExitCode
}

function Stop-SmokeProcessTree {
    param([Diagnostics.Process]$Process)

    if ($null -eq $Process) { return }
    $Process.Refresh()
    if ($Process.HasExited) { return }
    # Target only a process started by this script, including its WebView2
    # children. Never kill applications by their shared executable name.
    $stop = Start-Process -FilePath (Join-Path $env:WINDIR 'System32\taskkill.exe') `
        -ArgumentList @('/PID', [string]$Process.Id, '/T', '/F') -PassThru -WindowStyle Hidden
    if (-not $stop.WaitForExit(15000)) {
        Stop-Process -Id $stop.Id -Force -ErrorAction SilentlyContinue
        throw "Stopping smoke-test process tree timed out (PID $($Process.Id))."
    }
    if (-not $Process.WaitForExit(10000)) {
        throw "Smoke-test application is still running after termination (PID $($Process.Id))."
    }
}

try {
    Write-Host "Installing Windows package into $installDirectory"
    # NSIS requires /D to be last; its value must not be enclosed in quotes.
    $installerProcess = Start-Process -FilePath $installer `
        -ArgumentList @('/S', "/D=$installDirectory") -PassThru
    $evidence.installerExitCode = Wait-SmokeProcess -Process $installerProcess -TimeoutSeconds 300 -Operation 'Silent installation'
    foreach ($requiredPath in @($applicationPath, $uninstallerPath)) {
        if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
            throw "Silent installation did not produce the expected file: $requiredPath"
        }
    }
    $evidence.installed = $true
    $evidence.applicationVersion = (Get-Item -LiteralPath $applicationPath).VersionInfo.ProductVersion

    Write-Host 'Starting the installed desktop application.'
    $applicationProcess = Start-Process -FilePath $applicationPath -WorkingDirectory $installDirectory -PassThru
    $evidence.applicationProcessId = $applicationProcess.Id
    $launchTimer = [Diagnostics.Stopwatch]::StartNew()
    # Keep checking for at least ten seconds. Headless runner sessions may not
    # expose a native window handle, so record that observation without making
    # it a requirement. An early process exit always fails this smoke test.
    while ($launchTimer.Elapsed.TotalSeconds -lt 30) {
        $applicationProcess.Refresh()
        if ($applicationProcess.HasExited) {
            throw "Installed application exited during startup after $([Math]::Round($launchTimer.Elapsed.TotalSeconds, 1)) seconds (exit code $($applicationProcess.ExitCode))."
        }
        if ($applicationProcess.MainWindowHandle -ne [IntPtr]::Zero) {
            $evidence.mainWindowObserved = $true
        }
        if ($evidence.mainWindowObserved -and $launchTimer.Elapsed.TotalSeconds -ge 10) { break }
        Start-Sleep -Milliseconds 500
    }
    $applicationProcess.Refresh()
    if ($applicationProcess.HasExited) {
        throw "Installed application exited before the startup check completed (exit code $($applicationProcess.ExitCode))."
    }
    $evidence.applicationAliveSeconds = [Math]::Round($launchTimer.Elapsed.TotalSeconds, 1)
    Write-Host "Application stayed alive for $($evidence.applicationAliveSeconds) seconds; native window observed: $($evidence.mainWindowObserved)."
}
catch {
    $failure = $_.Exception
}
finally {
    foreach ($process in @($applicationProcess, $installerProcess)) {
        try { Stop-SmokeProcessTree -Process $process }
        catch { $cleanupFailures.Add($_.Exception.Message) }
    }

    try {
        if (Test-Path -LiteralPath $uninstallerPath -PathType Leaf) {
            Write-Host 'Uninstalling the smoke-test application.'
            # _?= runs the uninstaller in place, so its process exit represents
            # completion rather than just spawning a temporary uninstaller.
            $uninstaller = Start-Process -FilePath $uninstallerPath `
                -ArgumentList @('/S', "_?=$installDirectory") -PassThru
            try {
                $evidence.uninstallerExitCode = Wait-SmokeProcess -Process $uninstaller -TimeoutSeconds 120 -Operation 'Silent uninstallation'
            }
            finally {
                Stop-SmokeProcessTree -Process $uninstaller
            }
            # Check removal before deleting any remaining installer files;
            # test cleanup must never make a failed uninstall appear to pass.
            $deadline = [DateTime]::UtcNow.AddSeconds(60)
            while ((Test-Path -LiteralPath $applicationPath) -and [DateTime]::UtcNow -lt $deadline) {
                Start-Sleep -Milliseconds 500
            }
            if (Test-Path -LiteralPath $applicationPath) {
                throw "Uninstallation returned but left the application binary behind: $applicationPath"
            }
            # Like Tauri's own upgrade flow, an in-place NSIS uninstaller
            # cannot delete itself. Remove only that known file after exit.
            if (Test-Path -LiteralPath $uninstallerPath -PathType Leaf) {
                Remove-Item -LiteralPath $uninstallerPath -Force
            }
            if ((Test-Path -LiteralPath $installDirectory -PathType Container) -and
                @(Get-ChildItem -LiteralPath $installDirectory -Force).Count -eq 0) {
                Remove-Item -LiteralPath $installDirectory
            }
            $evidence.uninstalled = $true
        }
        elseif ($evidence.installed -or (Test-Path -LiteralPath $applicationPath)) {
            throw "Cannot clean up the installed application: uninstaller is missing at $uninstallerPath"
        }
    }
    catch {
        $cleanupFailures.Add($_.Exception.Message)
    }

    $evidence.passed = ($null -eq $failure -and $cleanupFailures.Count -eq 0 -and $evidence.installed -and $evidence.uninstalled)
    if ($null -ne $failure) { $evidence.error = $failure.Message }
    if ($cleanupFailures.Count -gt 0) { $evidence.cleanupErrors = $cleanupFailures.ToArray() }
    $evidence | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $evidencePath -Encoding UTF8
    Write-Host "Windows installer smoke-test evidence: $evidencePath"
}

if ($null -ne $failure) {
    if ($cleanupFailures.Count -gt 0) {
        throw "$($failure.Message) Cleanup also failed: $($cleanupFailures -join '; ')"
    }
    throw $failure
}
if ($cleanupFailures.Count -gt 0) {
    throw "Windows installation cleanup failed: $($cleanupFailures -join '; ')"
}
if (-not $evidence.passed) {
    throw 'Windows installer smoke test did not complete all required checks.'
}
Write-Host 'PASS: Windows package installed, the desktop process stayed alive, and uninstallation removed the application binary.'
