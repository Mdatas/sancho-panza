# AoE2 Coach — installer. Downloads the Electron runtime (official release) and installs the app
# into %LOCALAPPDATA%\Programs\AoE2Coach, then creates a Desktop shortcut and launches it.
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$ElectronVersion = '44.7.2'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Dest = Join-Path $env:LOCALAPPDATA 'Programs\AoE2Coach'
$Cache = Join-Path $env:LOCALAPPDATA 'Programs\AoE2Coach-cache'
$ZipUrl = "https://github.com/electron/electron/releases/download/v$ElectronVersion/electron-v$ElectronVersion-win32-x64.zip"
$Zip = Join-Path $Cache "electron-v$ElectronVersion-win32-x64.zip"

Write-Host ''
Write-Host '=== Sancho Panza - Age of Empires 2 Fan Companion — instalación ===' -ForegroundColor Yellow
Write-Host "Destino: $Dest"
New-Item -ItemType Directory -Force -Path $Dest, $Cache | Out-Null

# 1) Electron runtime (once; cached for future updates)
if (-not (Test-Path $Zip) -or ((Get-Item $Zip).Length -lt 50MB)) {
  Write-Host "Descargando el runtime Electron $ElectronVersion (~110 MB, una sola vez)..." -ForegroundColor Cyan
  $ProgressPreference = 'SilentlyContinue'
  Invoke-WebRequest -Uri $ZipUrl -OutFile $Zip -UseBasicParsing
  $ProgressPreference = 'Continue'
} else { Write-Host 'Runtime Electron ya descargado (cache).' }

# 1b) Verify the download against the SHA-256 list published with the same Electron release.
#     (Protects against a corrupted or tampered download; the list and the zip come from the same signed GitHub release.)
$SumsUrl = "https://github.com/electron/electron/releases/download/v$ElectronVersion/SHASUMS256.txt"
$Sums = Join-Path $Cache "SHASUMS256-v$ElectronVersion.txt"
if (-not (Test-Path $Sums)) { $ProgressPreference = 'SilentlyContinue'; Invoke-WebRequest -Uri $SumsUrl -OutFile $Sums -UseBasicParsing; $ProgressPreference = 'Continue' }
$Expected = (Select-String -Path $Sums -Pattern ("electron-v$ElectronVersion-win32-x64.zip" + '$') | Select-Object -First 1).Line.Split(' ')[0].Trim('*')
$Actual = (Get-FileHash -Algorithm SHA256 -Path $Zip).Hash.ToLower()
if (-not $Expected) { throw "No se encontro el hash esperado en SHASUMS256.txt" }
if ($Actual -ne $Expected.ToLower()) { Remove-Item -Force $Zip; throw "El runtime descargado no coincide con el hash oficial ($Actual vs $Expected). Se borro el archivo; volve a ejecutar el instalador." }
Write-Host 'Runtime verificado (SHA-256 OK).' -ForegroundColor Green

# 2) Unpack runtime (keeps user data untouched: it lives in %APPDATA%\AoE2 Coach)
Write-Host 'Instalando...' -ForegroundColor Cyan
Get-Process -Name 'AoE2 Coach' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500
Expand-Archive -Path $Zip -DestinationPath $Dest -Force
if (Test-Path (Join-Path $Dest 'electron.exe')) { Move-Item -Force (Join-Path $Dest 'electron.exe') (Join-Path $Dest 'AoE2 Coach.exe') }
Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $Dest 'resources\default_app.asar')

# 2b) Electron "fuses": the installed runtime can no longer be used as a plain Node (ELECTRON_RUN_AS_NODE), nor driven with
#     NODE_OPTIONS or --inspect from outside. Same byte flip as @electron/fuses (sentinel + version + length + one byte per fuse,
#     '1' on / '0' off): RunAsNode (#1), EnableNodeOptionsEnvironmentVariable (#3), EnableNodeCliInspectArguments (#4) -> off.
#     The app is started once afterwards; if it does not answer, the original binary is restored (nothing is left broken).
$Exe = Join-Path $Dest 'AoE2 Coach.exe'
try {
  $Bytes = [System.IO.File]::ReadAllBytes($Exe)
  $SentinelText = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'
  # one char per byte (Latin-1) so the native IndexOf finds the sentinel in a 150 MB file in well under a second
  $Pos = [System.Text.Encoding]::GetEncoding(28591).GetString($Bytes).IndexOf($SentinelText, [System.StringComparison]::Ordinal)
  if ($Pos -ge 0 -and $Bytes[$Pos + $SentinelText.Length] -eq 1) {
    $Base = $Pos + $SentinelText.Length + 2
    $Len = $Bytes[$Pos + $SentinelText.Length + 1]
    $Backup = $Exe + '.orig'
    Copy-Item -Force $Exe $Backup
    foreach ($Idx in @(0, 2, 3)) { if ($Idx -lt $Len -and $Bytes[$Base + $Idx] -ne 0x72) { $Bytes[$Base + $Idx] = 0x30 } }
    [System.IO.File]::WriteAllBytes($Exe, $Bytes)
    $Probe = Start-Process -FilePath $Exe -ArgumentList '--fuse-probe' -PassThru -Wait -WindowStyle Hidden -ErrorAction SilentlyContinue
    if ($null -eq $Probe -or $Probe.ExitCode -ne 0) { Copy-Item -Force $Backup $Exe; Write-Host 'Fuses: se restauro el binario original (la prueba de arranque fallo).' -ForegroundColor Yellow }
    else { Write-Host 'Runtime endurecido (fuses).' -ForegroundColor Green }
    Remove-Item -Force -ErrorAction SilentlyContinue $Backup
  }
} catch { Write-Host "Fuses: paso omitido ($($_.Exception.Message))." -ForegroundColor Yellow }

# 3) App files (app.asar, game data, whisper)
Copy-Item -Recurse -Force (Join-Path $Here 'app\resources\*') (Join-Path $Dest 'resources')

# 4) Desktop shortcut (the app is now called "Sancho Panza - Age of Empires 2 Fan Companion"; the old shortcut is replaced)
$Desk = [Environment]::GetFolderPath('Desktop')
Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $Desk 'AoE2 Coach.lnk')
Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $Desk 'Sancho Panza - AOE2 Squier.lnk')
Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $Desk 'Sancho Panza - Age of Empires 2 Companion.lnk')
$Shell = New-Object -ComObject WScript.Shell
$Lnk = $Shell.CreateShortcut((Join-Path $Desk 'Sancho Panza - Age of Empires 2 Fan Companion.lnk'))
$Lnk.TargetPath = Join-Path $Dest 'AoE2 Coach.exe'
$Lnk.WorkingDirectory = $Dest
$Lnk.IconLocation = (Join-Path $Dest 'AoE2 Coach.exe') + ',0'
$Lnk.Description = 'Sancho Panza - Age of Empires 2 Fan Companion'
$Lnk.Save()

Write-Host ''
Write-Host 'Listo. Acceso directo "Sancho Panza - Age of Empires 2 Fan Companion" en el Escritorio.' -ForegroundColor Green
Write-Host 'Primer paso en la app: Ajustes -> Cerebro -> pegar la API key de Claude.'
Start-Process -FilePath (Join-Path $Dest 'AoE2 Coach.exe') -WorkingDirectory $Dest
