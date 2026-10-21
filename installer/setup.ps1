# Sancho Panza - Age of Empires 2 Fan Companion — instalador para Windows.
# Baja el runtime Electron (release oficial, verificado por SHA-256), arma la app en una carpeta nueva, reemplaza la versión
# anterior si la hay (los ajustes, la API key y los logs viven en %APPDATA%\AoE2 Coach y no se tocan), crea los accesos
# directos y registra la app en "Aplicaciones instaladas" con su desinstalador. Cada paso avisa lo que hace y nada queda
# esperando sin límite de tiempo.
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.IO.Compression.FileSystem

$AppName = 'Sancho Panza - Age of Empires 2 Fan Companion'
$ExeName = 'AoE2 Coach.exe'
$ElectronVersion = '44.7.2'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Dest = Join-Path $env:LOCALAPPDATA 'Programs\AoE2Coach'
$New = "$Dest.new"
$Old = "$Dest.old"
$Cache = Join-Path $env:LOCALAPPDATA 'Programs\AoE2Coach-cache'
$ZipUrl = "https://github.com/electron/electron/releases/download/v$ElectronVersion/electron-v$ElectronVersion-win32-x64.zip"
$Zip = Join-Path $Cache "electron-v$ElectronVersion-win32-x64.zip"
$Version = 'desconocida'
if (Test-Path (Join-Path $Here 'app\VERSION')) { $Version = (Get-Content (Join-Path $Here 'app\VERSION') | Select-Object -First 1).Trim() }

function Step($Msg) { Write-Host ("[{0:HH:mm:ss}] {1}" -f (Get-Date), $Msg) -ForegroundColor Cyan }
function Stop-App {
  $Procs = Get-Process -Name 'AoE2 Coach' -ErrorAction SilentlyContinue
  if (-not $Procs) { return }
  Step 'Cerrando la app que está abierta...'
  $Procs | Stop-Process -Force -ErrorAction SilentlyContinue
  for ($i = 0; $i -lt 40; $i++) { Start-Sleep -Milliseconds 250; if (-not (Get-Process -Name 'AoE2 Coach' -ErrorAction SilentlyContinue)) { return } }
  throw "No pude cerrar '$ExeName'. Cerralo desde el Administrador de tareas y volvé a ejecutar el instalador."
}
function Remove-Tree($Path) {
  if (-not (Test-Path $Path)) { return $true }
  for ($i = 0; $i -lt 5; $i++) {
    try { Remove-Item -Recurse -Force -LiteralPath $Path -ErrorAction Stop; return $true } catch { Start-Sleep -Milliseconds 600 }
  }
  return -not (Test-Path $Path)
}

Write-Host ''
Write-Host "=== $AppName — instalación de la versión $Version ===" -ForegroundColor Yellow
Write-Host "Destino: $Dest"
New-Item -ItemType Directory -Force -Path $Cache | Out-Null

# 0) Versión anterior: se informa; se reemplaza entera al final (carpeta nueva → swap), los datos del usuario no se tocan.
$Prev = $null
if (Test-Path (Join-Path $Dest 'VERSION')) { $Prev = (Get-Content (Join-Path $Dest 'VERSION') | Select-Object -First 1).Trim() }
elseif (Test-Path (Join-Path $Dest $ExeName)) { $Prev = 'anterior a 0.21.1' }
if ($Prev) { Step "Hay una versión instalada ($Prev): se borra y se instala la $Version. Tus ajustes y tu API key se conservan." }
Remove-Tree $Old | Out-Null
Remove-Tree $New | Out-Null
Get-ChildItem -Path (Split-Path -Parent $Dest) -Directory -Filter 'AoE2Coach.old-*' -ErrorAction SilentlyContinue | ForEach-Object { Remove-Tree $_.FullName | Out-Null }

# 1) Runtime Electron (una sola vez; queda en caché para las próximas versiones)
if (-not (Test-Path $Zip) -or ((Get-Item $Zip).Length -lt 50MB)) {
  Step "Descargando el runtime Electron $ElectronVersion (~110 MB, una sola vez)..."
  $ProgressPreference = 'SilentlyContinue'
  Invoke-WebRequest -Uri $ZipUrl -OutFile $Zip -UseBasicParsing
  $ProgressPreference = 'Continue'
} else { Step 'Runtime Electron ya descargado (caché).' }

# 1b) Verificación contra la lista SHA-256 publicada con la misma release de Electron.
$SumsUrl = "https://github.com/electron/electron/releases/download/v$ElectronVersion/SHASUMS256.txt"
$Sums = Join-Path $Cache "SHASUMS256-v$ElectronVersion.txt"
if (-not (Test-Path $Sums)) { $ProgressPreference = 'SilentlyContinue'; Invoke-WebRequest -Uri $SumsUrl -OutFile $Sums -UseBasicParsing; $ProgressPreference = 'Continue' }
$Expected = (Select-String -Path $Sums -Pattern ("electron-v$ElectronVersion-win32-x64.zip" + '$') | Select-Object -First 1).Line.Split(' ')[0].Trim('*')
$Actual = (Get-FileHash -Algorithm SHA256 -Path $Zip).Hash.ToLower()
if (-not $Expected) { throw 'No se encontró el hash esperado en SHASUMS256.txt' }
if ($Actual -ne $Expected.ToLower()) { Remove-Item -Force $Zip; throw "El runtime descargado no coincide con el hash oficial ($Actual vs $Expected). Se borró el archivo; volvé a ejecutar el instalador." }
Step 'Runtime verificado (SHA-256 OK).'

# 2) Descomprimir en una carpeta nueva (al lado de la instalación actual, que sigue intacta hasta el final)
Step 'Descomprimiendo el runtime (170 MB; el antivirus revisa cada archivo, puede tardar un par de minutos)...'
New-Item -ItemType Directory -Force -Path $New | Out-Null
$NewFull = (Get-Item $New).FullName.TrimEnd('\') + '\'
$Za = [System.IO.Compression.ZipFile]::OpenRead($Zip)
try {
  $N = 0; $Total = $Za.Entries.Count
  foreach ($E in $Za.Entries) {
    $Target = [System.IO.Path]::GetFullPath((Join-Path $New $E.FullName))
    if (-not $Target.StartsWith($NewFull, [System.StringComparison]::OrdinalIgnoreCase)) { throw "Entrada sospechosa en el zip: $($E.FullName)" }
    if ($E.FullName.EndsWith('/')) { New-Item -ItemType Directory -Force -Path $Target | Out-Null; continue }
    $Dir = Split-Path -Parent $Target
    if (-not (Test-Path $Dir)) { New-Item -ItemType Directory -Force -Path $Dir | Out-Null }
    [System.IO.Compression.ZipFileExtensions]::ExtractToFile($E, $Target, $true)
    $N++
    if ($N % 25 -eq 0) { Write-Host ("           {0}/{1} archivos" -f $N, $Total) -ForegroundColor DarkGray }
  }
} finally { $Za.Dispose() }
Move-Item -Force (Join-Path $New 'electron.exe') (Join-Path $New $ExeName)
Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $New 'resources\default_app.asar')

# 2b) Fuses de Electron: el runtime instalado ya no sirve como Node suelto (ELECTRON_RUN_AS_NODE) ni se lo puede manejar con
#     NODE_OPTIONS o --inspect desde afuera. Mismo cambio de bytes que @electron/fuses (centinela + versión + largo + un byte por
#     fuse, '1' encendido / '0' apagado): RunAsNode (#1), EnableNodeOptionsEnvironmentVariable (#3), EnableNodeCliInspectArguments (#4).
#     Después se arranca la app una vez con un límite de 30 s; si no responde, se restaura el binario original.
$Exe = Join-Path $New $ExeName
Step 'Endureciendo el runtime (fuses) y probando que arranca...'
try {
  $Bytes = [System.IO.File]::ReadAllBytes($Exe)
  $SentinelText = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'
  $Pos = [System.Text.Encoding]::GetEncoding(28591).GetString($Bytes).IndexOf($SentinelText, [System.StringComparison]::Ordinal)
  if ($Pos -ge 0 -and $Bytes[$Pos + $SentinelText.Length] -eq 1) {
    $Base = $Pos + $SentinelText.Length + 2
    $Len = $Bytes[$Pos + $SentinelText.Length + 1]
    $Backup = $Exe + '.orig'
    Copy-Item -Force $Exe $Backup
    foreach ($Idx in @(0, 2, 3)) { if ($Idx -lt $Len -and $Bytes[$Base + $Idx] -ne 0x72) { $Bytes[$Base + $Idx] = 0x30 } }
    [System.IO.File]::WriteAllBytes($Exe, $Bytes)
    $Bytes = $null
    $Probe = Start-Process -FilePath $Exe -ArgumentList '--fuse-probe' -PassThru -WindowStyle Hidden -ErrorAction SilentlyContinue
    $Ok = $false
    if ($Probe) {
      $null = $Probe.Handle
      if ($Probe.WaitForExit(30000)) { $Ok = ($Probe.ExitCode -eq 0) }
      else { Stop-Process -Id $Probe.Id -Force -ErrorAction SilentlyContinue; Write-Host '           la prueba de arranque no terminó en 30 s' -ForegroundColor Yellow }
      Get-Process -Name 'AoE2 Coach' -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$New*" } | Stop-Process -Force -ErrorAction SilentlyContinue
    }
    if ($Ok) { Step 'Runtime endurecido (fuses).' }
    else { Copy-Item -Force $Backup $Exe; Write-Host '           Fuses: se restauró el binario original (la prueba de arranque falló); la app funciona igual.' -ForegroundColor Yellow }
    Remove-Item -Force -ErrorAction SilentlyContinue $Backup
  }
} catch { Write-Host "           Fuses: paso omitido ($($_.Exception.Message))." -ForegroundColor Yellow }

# 3) Archivos de la app (app.asar, datos del juego) + desinstalador + versión
Step 'Copiando la app...'
Copy-Item -Recurse -Force (Join-Path $Here 'app\resources\*') (Join-Path $New 'resources')
foreach ($F in @('uninstall.ps1', 'Desinstalar.bat', 'LEEME.txt')) { if (Test-Path (Join-Path $Here $F)) { Copy-Item -Force (Join-Path $Here $F) (Join-Path $New $F) } }
Set-Content -Path (Join-Path $New 'VERSION') -Value $Version -Encoding ASCII

# 4) Reemplazo: la carpeta vieja se aparta y la nueva toma su lugar (si algo falla, la vieja vuelve)
Stop-App
if (Test-Path $Dest) {
  Step 'Reemplazando la versión anterior...'
  if (Test-Path $Old) { $Old = "$Dest.old-" + (Get-Date -Format 'yyyyMMddHHmmss') }
  $Moved = $false
  for ($i = 0; $i -lt 5; $i++) { try { Rename-Item -LiteralPath $Dest -NewName (Split-Path -Leaf $Old) -ErrorAction Stop; $Moved = $true; break } catch { Start-Sleep -Milliseconds 800 } }
  if (-not $Moved) { Remove-Tree $New | Out-Null; throw "La carpeta $Dest está en uso (¿quedó abierta en el Explorador o la app?). Cerrala y volvé a ejecutar el instalador." }
}
try { Rename-Item -LiteralPath $New -NewName (Split-Path -Leaf $Dest) -ErrorAction Stop }
catch { if (Test-Path $Old) { Rename-Item -LiteralPath $Old -NewName (Split-Path -Leaf $Dest) -ErrorAction SilentlyContinue }; throw }
if (-not (Remove-Tree $Old)) { Write-Host "           No pude borrar del todo la versión anterior ($Old); se borra en la próxima instalación." -ForegroundColor Yellow }

# 5) Accesos directos (Escritorio y menú Inicio); se quitan los nombres viejos
$Desk = [Environment]::GetFolderPath('Desktop')
$StartMenu = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'Microsoft\Windows\Start Menu\Programs'
foreach ($OldLnk in @('AoE2 Coach.lnk', 'Sancho Panza - AOE2 Squier.lnk', 'Sancho Panza - Age of Empires 2 Companion.lnk')) { Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $Desk $OldLnk) }
$Shell = New-Object -ComObject WScript.Shell
foreach ($Dir in @($Desk, $StartMenu)) {
  if (-not (Test-Path $Dir)) { continue }
  $Lnk = $Shell.CreateShortcut((Join-Path $Dir "$AppName.lnk"))
  $Lnk.TargetPath = Join-Path $Dest $ExeName
  $Lnk.WorkingDirectory = $Dest
  $Lnk.IconLocation = (Join-Path $Dest $ExeName) + ',0'
  $Lnk.Description = $AppName
  $Lnk.Save()
}

# 6) Registro en "Aplicaciones instaladas" (solo el usuario actual), con el desinstalador
try {
  $Key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\SanchoPanzaAoE2'
  New-Item -Path $Key -Force | Out-Null
  $SizeKB = [int]((Get-ChildItem -LiteralPath $Dest -Recurse -File | Measure-Object -Property Length -Sum).Sum / 1KB)
  $Un = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$Dest\uninstall.ps1`""
  New-ItemProperty -Path $Key -Name DisplayName -Value $AppName -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $Key -Name DisplayVersion -Value $Version -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $Key -Name Publisher -Value 'Mdatas (open source)' -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $Key -Name InstallLocation -Value $Dest -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $Key -Name DisplayIcon -Value ((Join-Path $Dest $ExeName) + ',0') -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $Key -Name UninstallString -Value $Un -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $Key -Name QuietUninstallString -Value ($Un + ' -Quiet') -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $Key -Name URLInfoAbout -Value 'https://github.com/Mdatas/sancho-panza' -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $Key -Name InstallDate -Value (Get-Date -Format 'yyyyMMdd') -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $Key -Name EstimatedSize -Value $SizeKB -PropertyType DWord -Force | Out-Null
  New-ItemProperty -Path $Key -Name NoModify -Value 1 -PropertyType DWord -Force | Out-Null
  New-ItemProperty -Path $Key -Name NoRepair -Value 1 -PropertyType DWord -Force | Out-Null
} catch { Write-Host "           No se pudo registrar en Aplicaciones instaladas ($($_.Exception.Message)); Desinstalar.bat sigue funcionando." -ForegroundColor Yellow }

Write-Host ''
Write-Host "Listo: versión $Version instalada. Acceso directo `"$AppName`" en el Escritorio y en el menú Inicio." -ForegroundColor Green
Write-Host 'Para desinstalar: Ajustes de la app -> Datos -> Desinstalar, o Windows -> Aplicaciones instaladas, o Desinstalar.bat en la carpeta de la app.'
Write-Host 'Primer paso en la app: Ajustes -> Cerebro -> pegar la API key de Claude.'
Start-Process -FilePath (Join-Path $Dest $ExeName) -WorkingDirectory $Dest
