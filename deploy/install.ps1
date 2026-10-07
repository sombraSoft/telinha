# Install Telinha on Windows (PowerShell 5.1 or newer):
#   irm https://github.com/sombraSoft/telinha/releases/latest/download/install.ps1 | iex
# Env: TELINHA_VERSION=<tag> (default: latest), TELINHA_HOME=<dir>, TELINHA_NO_SETUP=1.
# Dev override: TELINHA_BASE_URL=<dir url holding the assets> replaces the GitHub release URL.
#
# `irm | iex` runs this in the caller's session: everything lives in a script
# block so StrictMode, the preferences and the variables end with the install.
# Only $env:Path is set on purpose, so `telinha` works in this window at once.
& {
    Set-StrictMode -Version 2.0
    $ErrorActionPreference = 'Stop'
    # Older 5.1 defaults lack TLS 1.2; the progress bar makes Invoke-WebRequest very slow.
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 -bor 3072
    $ProgressPreference = 'SilentlyContinue'

    function Fail([string]$msg) {
        Write-Host "install.ps1: $msg" -ForegroundColor Red
        throw $msg
    }

    $archRaw = $env:PROCESSOR_ARCHITEW6432
    if (-not $archRaw) { $archRaw = $env:PROCESSOR_ARCHITECTURE }
    switch ($archRaw) {
        'ARM64' { $arch = 'arm64' }
        'AMD64' { $arch = 'x64' }
        default { Fail "no build for $archRaw" }
    }

    $customHome = [bool]$env:TELINHA_HOME
    $home_ = $env:TELINHA_HOME
    if (-not $home_) { $home_ = Join-Path $env:LOCALAPPDATA 'Telinha' }
    $bin = Join-Path $home_ 'bin'
    $exe = Join-Path $bin 'telinha.exe'
    New-Item -ItemType Directory -Force -Path $bin | Out-Null

    $repo = 'https://github.com/sombraSoft/telinha/releases'
    if ($env:TELINHA_BASE_URL) { $base = $env:TELINHA_BASE_URL.TrimEnd('/') }
    elseif ($env:TELINHA_VERSION) { $base = "$repo/download/$($env:TELINHA_VERSION)" }
    else { $base = "$repo/latest/download" }

    $asset = "telinha-windows-$arch.zip"
    $work = Join-Path $env:TEMP 'telinha-install'
    if (Test-Path $work) { Remove-Item -Recurse -Force $work }
    New-Item -ItemType Directory -Force -Path $work | Out-Null

    try {
        Write-Host "downloading $asset"
        $zip = Join-Path $work $asset
        $sums = Join-Path $work 'SHA256SUMS'
        Invoke-WebRequest -UseBasicParsing -Uri "$base/$asset" -OutFile $zip
        Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS" -OutFile $sums

        # sha256sum format: "<hex>  <name>".
        $expected = $null
        foreach ($line in Get-Content $sums) {
            $parts = $line.Trim() -split '\s+', 2
            if ($parts.Count -eq 2 -and $parts[1].TrimStart('*') -eq $asset) { $expected = $parts[0]; break }
        }
        if (-not $expected) { Fail "$asset is not listed in SHA256SUMS" }
        $actual = (Get-FileHash -Algorithm SHA256 -Path $zip).Hash
        if ($actual -ine $expected) { Fail "checksum mismatch for $asset" }
        Write-Host 'sha256 ok'

        $out = Join-Path $work 'x'
        Expand-Archive -Path $zip -DestinationPath $out -Force
        $new = Join-Path $bin 'telinha.new.exe'
        Copy-Item -Force (Join-Path $out 'telinha.exe') $new

        # An existing install without the tray opted out of it: only a fresh one gets it installed unasked.
        $fresh = -not (Test-Path $exe)
        $stamp = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
        if (Test-Path $exe) {
            # A running exe cannot be overwritten but can be renamed; the updater sweeps telinha.old-*.
            Move-Item -Force $exe (Join-Path $bin "telinha.old-manual-$stamp.exe")
        }
        Move-Item -Force $new $exe

        $trayNew = Join-Path $out 'telinha-tray.exe'
        $tray = Join-Path $bin 'telinha-tray.exe'
        # An opted-out install keeps the tray uninstalled under this name, so a
        # later `telinha setup` (without --no-tray) can install it from bin.
        $trayDist = Join-Path $bin 'telinha-tray.dist.exe'
        if (Test-Path $trayNew) {
            if ($fresh -or (Test-Path $tray)) {
                # Same rename-aside as telinha.exe: the tray may be running. Setup starts it.
                if (Test-Path $tray) { Move-Item -Force $tray (Join-Path $bin "telinha-tray.old-manual-$stamp.exe") }
                Copy-Item -Force $trayNew $tray
                if (Test-Path $trayDist) { Remove-Item -Force $trayDist }
            }
            else {
                Copy-Item -Force $trayNew $trayDist
            }
        }
    }
    finally {
        Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
    }

    & $exe --version

    # The raw registry value: %USERPROFILE%-style entries stay unexpanded and the
    # value stays REG_EXPAND_SZ ([Environment]::GetEnvironmentVariable expands them).
    $envKey = Get-Item -LiteralPath 'HKCU:\Environment'
    $userPath = [string]$envKey.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
    $onPath = $false
    foreach ($p in ($userPath -split ';')) {
        if ($p.TrimEnd('\') -ieq $bin.TrimEnd('\')) { $onPath = $true }
    }
    if (-not $onPath) {
        $newPath = $bin
        if ($userPath) { $newPath = $userPath.TrimEnd(';') + ';' + $bin }
        Set-ItemProperty -LiteralPath 'HKCU:\Environment' -Name Path -Value $newPath -Type ExpandString
        Write-Host "added $bin to your PATH" -ForegroundColor Yellow
    }
    # Every later terminal finds this home without the variable set in it.
    if ($customHome) { [Environment]::SetEnvironmentVariable('TELINHA_HOME', $home_, 'User') }
    # Tells Explorer (and the terminals it starts) about the new values: setting
    # a user variable through .NET broadcasts WM_SETTINGCHANGE.
    [Environment]::SetEnvironmentVariable('TELINHA_INSTALL_REFRESH', '1', 'User')
    [Environment]::SetEnvironmentVariable('TELINHA_INSTALL_REFRESH', $null, 'User')
    # This window too: setup's hints say `telinha ...`.
    $present = $false
    foreach ($p in ($env:Path -split ';')) {
        if ($p.TrimEnd('\') -ieq $bin.TrimEnd('\')) { $present = $true }
    }
    if (-not $present) { $env:Path = $env:Path.TrimEnd(';') + ';' + $bin }

    if (-not $env:TELINHA_NO_SETUP -and [Environment]::UserInteractive) {
        & $exe setup --home $home_
    }
    else {
        Write-Host "next: run telinha setup" -ForegroundColor Green
    }
}
