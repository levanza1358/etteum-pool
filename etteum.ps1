# etteum.ps1 - Etteum management CLI (Windows)
# Usage: .\etteum.ps1 [start|stop|restart|status|logs|update|port|build]

param(
  [Parameter(Position = 0)][string]$Command = "help",
  [Parameter(Position = 1)][string]$Arg1,
  [Parameter(Position = 2)][string]$Arg2
)

$ErrorActionPreference = "Stop"

# Auto-detect project dir: env override > script dir
if ($env:POOLPROX_HOME -and (Test-Path $env:POOLPROX_HOME)) {
  $ProjectDir = $env:POOLPROX_HOME
} else {
  $ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}

$PidFile = Join-Path $ProjectDir ".etteum.pid"
$LogFile = Join-Path $ProjectDir ".etteum.log"
$ErrFile = Join-Path $ProjectDir ".etteum.err.log"
$EnvFile = Join-Path $ProjectDir ".env"

function Get-EnvValue([string]$key, [string]$default) {
  if (-not (Test-Path $EnvFile)) { return $default }
  $line = Select-String -Path $EnvFile -Pattern "^$key=" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($line) { return ($line.Line -replace "^$key=", "").Trim('"').Trim("'") }
  return $default
}

function Set-EnvValue([string]$key, [string]$value) {
  $escapedKey = [regex]::Escape($key)
  if (-not (Test-Path $EnvFile)) {
    Set-Content -Path $EnvFile -Value "${key}=${value}"
    return
  }

  $content = Get-Content $EnvFile -Raw
  if ($content -match "(?m)^${escapedKey}=") {
    $updated = [regex]::Replace($content, "(?m)^${escapedKey}=.*$", "${key}=${value}")
    Set-Content -Path $EnvFile -Value $updated
  } else {
    if ($content.Length -gt 0 -and -not $content.EndsWith("`r`n") -and -not $content.EndsWith("`n")) {
      Add-Content -Path $EnvFile -Value ""
    }
    Add-Content -Path $EnvFile -Value "${key}=${value}"
  }
}

function Get-PythonCommand {
  if (Get-Command py -ErrorAction SilentlyContinue) { return "py" }
  if (Get-Command python -ErrorAction SilentlyContinue) { return "python" }
  if (Get-Command python3 -ErrorAction SilentlyContinue) { return "python3" }
  return $null
}

function Ensure-AuthPython {
  $authDir = Join-Path $ProjectDir "scripts\auth"
  $venvDir = Join-Path $authDir ".venv"
  $venvPy = Join-Path $venvDir "Scripts\python.exe"
  $venvPip = Join-Path $venvDir "Scripts\pip.exe"
  $requirementsFile = Join-Path $authDir "requirements.txt"
  $configuredPython = Get-EnvValue "PYTHON_PATH" ""

  if ($configuredPython -and -not [System.IO.Path]::IsPathRooted($configuredPython)) {
    $configuredPython = Join-Path $ProjectDir $configuredPython
  }

  if ((Test-Path $venvPy) -and ((-not $configuredPython) -or ($configuredPython -eq $venvPy))) {
    # Cek apakah dependency penting sudah ada
    try {
      & $venvPy -c "import curl_cffi, playwright, camoufox" 2>&1 | Out-Null
      Write-Host "Auth Python siap: $venvPy" -ForegroundColor Green
      return $true
    } catch {
      Write-Host "Auth Python dependency belum lengkap. Memperbaiki..." -ForegroundColor Yellow
    }
  }

  Write-Host "Auth Python belum siap. Memperbaiki environment Canva..." -ForegroundColor Yellow

  $pythonCmd = Get-PythonCommand
  if (-not $pythonCmd) {
    Write-Host "Python tidak ditemukan di PATH. Jalankan install.ps1 dulu atau install Python 3.11+." -ForegroundColor Red
    return $false
  }

  if (-not (Test-Path $authDir)) {
    Write-Host "Folder auth tidak ditemukan: $authDir" -ForegroundColor Red
    return $false
  }

  if (-not (Test-Path $venvPy)) {
    Write-Host "Membuat virtual environment auth..."
    & $pythonCmd -m venv $venvDir
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $venvPy)) {
      Write-Host "Gagal membuat virtual environment di $venvDir" -ForegroundColor Red
      return $false
    }
  }

  if (-not (Test-Path $venvPip)) {
    Write-Host "pip tidak ditemukan di venv: $venvPip" -ForegroundColor Red
    return $false
  }

  Write-Host "Menginstall dependency Python auth..."
  & $venvPip install --upgrade pip wheel
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Gagal upgrade pip pada auth venv" -ForegroundColor Red
    return $false
  }

  & $venvPip install -r $requirementsFile
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Gagal install dependency Python auth dari $requirementsFile" -ForegroundColor Red
    return $false
  }

  Write-Host "Menginstall browser Playwright..."
  & $venvPy -m playwright install chromium
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Gagal install Playwright Chromium" -ForegroundColor Red
    return $false
  }

  Write-Host "Mengambil browser Camoufox..."
  & $venvPy -m camoufox fetch
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Gagal fetch Camoufox" -ForegroundColor Red
    return $false
  }

  Set-EnvValue "PYTHON_PATH" $venvPy
  Set-EnvValue "AUTH_SCRIPT_CWD" "./scripts/auth"
  Set-EnvValue "AUTH_SCRIPT_PATH" "./scripts/auth/login.py"

  Write-Host "Auth Python siap: $venvPy" -ForegroundColor Green
  return $true
}

function Test-Running {
  if (-not (Test-Path $PidFile)) { return $false }
  $procId = Get-Content $PidFile -ErrorAction SilentlyContinue
  if (-not $procId) { return $false }
  try {
    $p = Get-Process -Id $procId -ErrorAction Stop
    return $true
  } catch {
    Remove-Item $PidFile -ErrorAction SilentlyContinue
    return $false
  }
}

function Test-PortInUse([int]$port) {
  try {
    $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop
    return [bool]$listener
  } catch { return $false }
}

function Invoke-Start {
  $apiPort = [int](Get-EnvValue "PORT" "1930")
  $dashPort = [int](Get-EnvValue "DASHBOARD_PORT" "1931")

  if (-not (Ensure-AuthPython)) {
    Write-Host "Start dibatalkan karena environment auth belum siap." -ForegroundColor Red
    return
  }

  if (Test-PortInUse $apiPort) {
    Write-Host "Port $apiPort already in use. Run: .\etteum.ps1 stop" -ForegroundColor Red
    return
  }
  if (Test-PortInUse $dashPort) {
    Write-Host "Port $dashPort already in use. Run: .\etteum.ps1 stop" -ForegroundColor Red
    return
  }

  Write-Host "Starting Etteum..."
  $proc = Start-Process -FilePath "bun" -ArgumentList "scripts/production.ts","--skip-build" `
    -WorkingDirectory $ProjectDir -RedirectStandardOutput $LogFile -RedirectStandardError $ErrFile `
    -WindowStyle Hidden -PassThru
  $proc.Id | Out-File -FilePath $PidFile -Encoding ascii
  Start-Sleep -Seconds 1

  if (-not $proc.HasExited) {
    Write-Host "Etteum started (PID $($proc.Id))" -ForegroundColor Green
    Write-Host "  Backend:   http://localhost:$apiPort"
    Write-Host "  Dashboard: http://localhost:$dashPort"
    Write-Host "  Logs:      .\etteum.ps1 logs"
  } else {
    Remove-Item $PidFile -ErrorAction SilentlyContinue
    Write-Host "Failed to start. Check logs at $LogFile" -ForegroundColor Red
    Get-Content $LogFile -Tail 5 -ErrorAction SilentlyContinue
  }
}

function Invoke-Stop {
  Write-Host "Stopping Etteum..."
  Get-CimInstance Win32_Process -Filter "Name='bun.exe' OR Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match "scripts[\\/](production|start|serve-dashboard)\.ts|src[\\/]index\.ts" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Remove-Item $PidFile -ErrorAction SilentlyContinue
  Write-Host "Etteum stopped"
}

function Invoke-Status {
  if (Test-Running) {
    $procId = Get-Content $PidFile
    Write-Host "Etteum is running (PID $procId)" -ForegroundColor Green
    Write-Host "  Backend:   http://localhost:$(Get-EnvValue 'PORT' '1930')"
    Write-Host "  Dashboard: http://localhost:$(Get-EnvValue 'DASHBOARD_PORT' '1931')"
  } else {
    Write-Host "Etteum is not running"
  }
}

function Invoke-Logs([string]$tailArg) {
  if (-not (Test-Path $LogFile)) {
    Write-Host "No logs yet at $LogFile"
    return
  }
  if ($tailArg -eq "-f" -or -not $tailArg) {
    Get-Content $LogFile -Wait -Tail 50
  } else {
    Get-Content $LogFile -Tail ([int]$tailArg)
  }
}

function Invoke-Update {
  Write-Host "Pulling latest..."
  Push-Location $ProjectDir
  try {
    git pull
    Write-Host "Installing dependencies..."
    bun install
    Write-Host "Building dashboard..."
    Push-Location (Join-Path $ProjectDir "dashboard")
    try { bun run build } finally { Pop-Location }
    Write-Host "Restarting..."
    Invoke-Stop
    Start-Sleep -Seconds 1
    Invoke-Start
  } finally { Pop-Location }
}

function Invoke-Build {
  Write-Host "Building dashboard..."
  Push-Location (Join-Path $ProjectDir "dashboard")
  try { bun run build } finally { Pop-Location }
  Write-Host "Restarting..."
  Invoke-Stop
  Start-Sleep -Seconds 1
  Invoke-Start
}

function Invoke-Port([string]$apiPort, [string]$dashPort) {
  if (-not $apiPort -or -not $dashPort) {
    Write-Host "Current ports: API=$(Get-EnvValue 'PORT' '1930') Dashboard=$(Get-EnvValue 'DASHBOARD_PORT' '1931')"
    Write-Host "Usage: .\etteum.ps1 port <api_port> <dashboard_port>"
    return
  }
  $content = Get-Content $EnvFile
  $content = $content -replace "^PORT=.*", "PORT=$apiPort"
  $content = $content -replace "^DASHBOARD_PORT=.*", "DASHBOARD_PORT=$dashPort"
  $content | Set-Content $EnvFile
  Write-Host "Ports changed: API=$apiPort Dashboard=$dashPort" -ForegroundColor Green
  if (Test-Running) {
    Write-Host "Restarting with new ports..."
    Invoke-Stop
    Start-Sleep -Seconds 1
    Invoke-Start
  }
}

switch ($Command.ToLower()) {
  "start"   { Invoke-Start }
  "stop"    { Invoke-Stop }
  "restart" { Invoke-Stop; Start-Sleep -Seconds 1; Invoke-Start }
  "status"  { Invoke-Status }
  "logs"    { Invoke-Logs $Arg1 }
  "update"  { Invoke-Update }
  "build"   { Invoke-Build }
  "port"    { Invoke-Port $Arg1 $Arg2 }
  default {
    Write-Host "etteum - Etteum Management CLI (Windows)`n"
    Write-Host "Usage: .\etteum.ps1 <command>`n"
    Write-Host "Commands:"
    Write-Host "  start       Start the server"
    Write-Host "  stop        Stop the server"
    Write-Host "  restart     Restart the server"
    Write-Host "  status      Show server status"
    Write-Host "  logs        Follow server logs (.\etteum.ps1 logs -f)"
    Write-Host "  update      Pull git, install deps, build, restart"
    Write-Host "  build       Rebuild dashboard and restart"
    Write-Host "  port        Show/change ports (.\etteum.ps1 port 1930 1931)"
  }
}
