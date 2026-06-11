# Etteum Pool installer for Windows
#
# One-command install (PowerShell):
#   irm https://raw.githubusercontent.com/levanza1358/etteum-pool/main/install.ps1 | iex
#
# Or, after cloning:
#   powershell -ExecutionPolicy Bypass -File install.ps1

#Requires -Version 5.1

$ErrorActionPreference = "Stop"

$RepoUrl     = if ($env:ETTEUM_REPO) { $env:ETTEUM_REPO } else { "https://github.com/levanza1358/etteum-pool.git" }
$DefaultDir  = if ($env:ETTEUM_HOME) { $env:ETTEUM_HOME } else { Join-Path $HOME "etteum-pool" }

function Step([string]$msg) { Write-Host "==> " -ForegroundColor Cyan -NoNewline; Write-Host $msg -ForegroundColor White }
function Info([string]$msg) { Write-Host "    $msg" }
function Warn([string]$msg) { Write-Host "!!  $msg" -ForegroundColor Yellow }
function Fail([string]$msg) { Write-Host "xx  $msg" -ForegroundColor Red; exit 1 }
function Ok  ([string]$msg) { Write-Host "ok  " -ForegroundColor Green -NoNewline; Write-Host $msg }

function Have([string]$cmd) { return [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

function Show-Summary {
    Write-Host ""
    Write-Host "Etteum Pool" -ForegroundColor Cyan -NoNewline
    Write-Host " — AI Proxy Pool for Multiple Providers" -ForegroundColor White
    Write-Host ""

    # Check what needs to be installed
    $needsGit = -not (Have git)
    $needsBun = -not (Have bun)
    $needsPython = -not (Have python) -and -not (Have python3)

    $totalSize = 0
    $items = @()

    if ($needsGit) {
        $items += "  • Git                          ~50 MB"
        $totalSize += 50
    }
    if ($needsBun) {
        $items += "  • Bun runtime                  ~50 MB"
        $totalSize += 50
    }
    if ($needsPython) {
        $items += "  • Python 3.11+                 ~100 MB"
        $totalSize += 100
    }

    $items += "  • Node.js dependencies         ~200 MB"
    $totalSize += 200
    $items += "  • Python packages (venv)       ~150 MB"
    $totalSize += 150
    $items += "  • Playwright Chromium          ~175 MB"
    $totalSize += 175
    $items += "  • Camoufox browser             ~150 MB"
    $totalSize += 150
    $items += "  • Dashboard build              ~50 MB"
    $totalSize += 50

    Write-Host "This will install:" -ForegroundColor White
    foreach ($item in $items) {
        Write-Host $item
    }
    Write-Host ""
    Write-Host "Estimated total size: " -ForegroundColor White -NoNewline
    Write-Host "~$totalSize MB" -ForegroundColor Yellow
    Write-Host "Install location:     " -ForegroundColor White -NoNewline
    Write-Host $DefaultDir
    Write-Host ""

    if ($needsGit -or $needsBun -or $needsPython) {
        Write-Host "Note: " -ForegroundColor Yellow -NoNewline
        Write-Host "System dependencies (Git/Bun/Python) will be installed via package manager."
        Write-Host "      This may require " -NoNewline
        Write-Host "administrator privileges" -ForegroundColor Yellow -NoNewline
        Write-Host "."
        Write-Host ""
    }

    $response = Read-Host "Do you want to continue? [Y/n]"
    if ($response -match '^[nN]') {
        Write-Host "Installation cancelled." -ForegroundColor Yellow
        exit 0
    }
    Write-Host ""
}

function Add-PathOnce([string]$dir) {
  if (-not (Test-Path $dir)) { return }
  if (-not ($env:Path -split ';' | Where-Object { $_ -eq $dir })) {
    $env:Path = "$dir;$env:Path"
  }
}

function Ensure-Git {
  if (Have git) { return }
  Step "Installing Git"
  if (Have winget) {
    winget install --id Git.Git --silent --accept-package-agreements --accept-source-agreements | Out-Null
  } elseif (Have scoop) {
    scoop install git | Out-Null
  } elseif (Have choco) {
    choco install -y git | Out-Null
  } else {
    Fail "Install Git manually from https://git-scm.com/download/win and re-run this script"
  }
  Add-PathOnce "$env:ProgramFiles\Git\cmd"
  if (-not (Have git)) { Fail "git is still not on PATH. Open a new PowerShell window and re-run." }
  Ok "Git installed"
}

function Ensure-Bun {
  if (Have bun) { return }
  Step "Installing Bun"
  try {
    powershell -NoProfile -Command "irm bun.sh/install.ps1 | iex" | Out-Null
  } catch {
    Fail "Bun install failed: $_"
  }
  Add-PathOnce (Join-Path $HOME ".bun\bin")
  if (-not (Have bun)) {
    Warn "Bun installed but not on PATH yet. Open a new PowerShell and re-run this installer."
    exit 1
  }
  Ok "Bun $(bun --version) installed"
}

function Ensure-Python {
  $script:PythonBin = $null
  foreach ($cand in @("python3.12","python3.11","python3.10","python","python3")) {
    if (Have $cand) {
      try {
        $ver = & $cand -c "import sys;print('%d.%d'%sys.version_info[:2])"
        $parts = $ver.Trim().Split('.')
        if ([int]$parts[0] -ge 3 -and [int]$parts[1] -ge 10) {
          $script:PythonBin = $cand
          return
        }
      } catch {}
    }
  }
  Step "Installing Python 3.11"
  if (Have winget) {
    winget install --id Python.Python.3.11 --silent --accept-package-agreements --accept-source-agreements | Out-Null
  } elseif (Have scoop) {
    scoop install python | Out-Null
  } elseif (Have choco) {
    choco install -y python | Out-Null
  } else {
    Fail "Install Python 3.10+ manually from https://python.org and re-run"
  }
  if (Have python) { $script:PythonBin = "python" }
  elseif (Have python3) { $script:PythonBin = "python3" }
  else {
    Warn "Python installed but not on PATH yet. Open a new PowerShell and re-run."
    exit 1
  }
  Ok "Python $(& $script:PythonBin --version) installed"
}

function Clone-Or-Update-Repo {
  $script:ProjectDir = $null
  if (Test-Path "package.json") {
    $pkg = Get-Content "package.json" -Raw
    if ($pkg -match '"name"\s*:\s*"etteum-pool"') {
      $script:ProjectDir = (Get-Location).Path
      Step "Using existing checkout: $($script:ProjectDir)"
      if (Test-Path ".git") {
        try { git pull --ff-only | Out-Null } catch { Warn "git pull failed (continuing)" }
      }
      return
    }
  }

  if (Test-Path (Join-Path $DefaultDir ".git")) {
    $script:ProjectDir = $DefaultDir
    Step "Updating existing checkout at $($script:ProjectDir)"
    Push-Location $script:ProjectDir
    try { git pull --ff-only | Out-Null } catch { Warn "git pull failed" }
    finally { Pop-Location }
  } else {
    $script:ProjectDir = $DefaultDir
    Step "Cloning $RepoUrl -> $($script:ProjectDir)"
    git clone --depth=1 $RepoUrl $script:ProjectDir
  }
  Set-Location $script:ProjectDir
}

function Write-EnvIfMissing {
  Step "Configuring .env"
  if (Test-Path ".env") { Info ".env already exists, leaving untouched"; return }
  Copy-Item ".env.example" ".env"

  $bytes = New-Object byte[] 16
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $key = ($bytes | ForEach-Object { $_.ToString("x2") }) -join ""

  (Get-Content ".env") -replace '^ENCRYPTION_KEY=.*', "ENCRYPTION_KEY=$key" | Set-Content ".env"
  Ok "Generated random ENCRYPTION_KEY"

  $venvPython = "./scripts/auth/.venv/Scripts/python.exe"
  (Get-Content ".env") -replace '^PYTHON_PATH=.*', "PYTHON_PATH=$venvPython" | Set-Content ".env"
}

function Install-NodeDeps {
  Step "Installing JS dependencies (bun install)"
  bun install --silent
  Push-Location "dashboard"
  try { bun install --silent } finally { Pop-Location }
  Ok "JS dependencies installed"
}

function Setup-PythonVenv {
  Step "Setting up Python venv at scripts\auth\.venv"
  $venv = "scripts\auth\.venv"
  if (-not (Test-Path $venv)) {
    & $script:PythonBin -m venv $venv
  }
  $venvPip = Join-Path $venv "Scripts\pip.exe"
  $venvPy  = Join-Path $venv "Scripts\python.exe"
  & $venvPip install --upgrade pip wheel | Out-Null
  & $venvPip install -r scripts\auth\requirements.txt
  Ok "Python deps installed"

  Step "Installing Playwright + Camoufox browsers (this can take a few minutes)"
  try { & $venvPy -m playwright install chromium | Out-Null } catch { Warn "Playwright Chromium install failed (re-run later)" }
  try { & $venvPy -m camoufox fetch | Out-Null }              catch { Warn "Camoufox fetch failed (re-run later)" }
  Ok "Browsers ready"
}

function Build-Dashboard {
  Step "Building dashboard (production)"
  Push-Location "dashboard"
  try { bun run build } catch { Pop-Location; Fail "Dashboard build failed" }
  Pop-Location
  Ok "Dashboard built"
}

function Run-Migrations {
  Step "Running database migrations"
  try {
    bun src/db/migrate.ts
    Ok "Migrations applied"
  } catch {
    Warn "Migrations failed. Database will be created on first run."
    Info "After first run, you can re-run: bun src/db/migrate.ts"
  }
}

function Install-CliSymlink {
  Step "Installing CLI commands"
  $target = Join-Path $HOME ".local\bin"
  if (-not (Test-Path $target)) {
    New-Item -ItemType Directory -Path $target -Force | Out-Null
  }

  # Copy etteum.ps1 and etteum.cmd to target
  Copy-Item "$script:ProjectDir\etteum.ps1" "$target\etteum.ps1" -Force
  Copy-Item "$script:ProjectDir\etteum.cmd" "$target\etteum.cmd" -Force

  Ok "Installed etteum command to $target"

  if (-not ($env:Path -split ';' | Where-Object { $_ -eq $target })) {
    Warn "Add to PATH: `$env:Path = `"$target;`$env:Path`""
  }
}

function Main {
  Write-Host ""
  Write-Host "Etteum Pool Installer (Windows)" -ForegroundColor Blue
  Write-Host ""

  Show-Summary

  Ensure-Git
  Ensure-Bun
  Ensure-Python
  Clone-Or-Update-Repo

  Set-Location $script:ProjectDir
  Write-EnvIfMissing
  Install-NodeDeps
  Setup-PythonVenv
  Build-Dashboard
  Run-Migrations
  Install-CliSymlink

  Write-Host ""
  Write-Host "✓ Installation complete!" -ForegroundColor Green
  Write-Host ""
  Write-Host "Etteum Pool is installed at: $($script:ProjectDir)" -ForegroundColor White
  Write-Host ""

  Write-Host "Quick Start:" -ForegroundColor White -BackgroundColor DarkBlue
  Write-Host ""
  Write-Host "  1. Start the server:" -ForegroundColor Cyan
  Write-Host "     .\etteum.ps1 start"
  Write-Host ""
  Write-Host "  2. Open the dashboard:" -ForegroundColor Cyan
  Write-Host "     http://localhost:1931"
  Write-Host ""
  Write-Host "  3. Add accounts via the dashboard UI"
  Write-Host ""

  Write-Host "Useful Commands:" -ForegroundColor White -BackgroundColor DarkBlue
  Write-Host ""
  Write-Host "  .\etteum.ps1 status     # Check server status"
  Write-Host "  .\etteum.ps1 logs       # View server logs"
  Write-Host "  .\etteum.ps1 stop       # Stop the server"
  Write-Host "  .\etteum.ps1 restart    # Restart the server"
  Write-Host ""

  Write-Host "Tip: re-run this installer any time to pull updates and rebuild." -ForegroundColor Gray
}

Main
