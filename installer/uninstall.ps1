# Sancho Panza - Age of Empires 2 Fan Companion — desinstalador para Windows.
# Cierra la app, borra la carpeta del programa (%LOCALAPPDATA%\Programs\AoE2Coach), el runtime descargado, los accesos
# directos y la entrada de "Aplicaciones instaladas". Pregunta si borrar también los datos del usuario (ajustes, API key,
# logs: %APPDATA%\AoE2 Coach). Con -Quiet no pregunta nada (los datos se conservan salvo -PurgeData).
param([switch]$Quiet, [switch]$PurgeData, [switch]$Relaunched)
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$AppName = 'Sancho Panza - Age of Empires 2 Fan Companion'
$Dest = Join-Path $env:LOCALAPPDATA 'Programs\AoE2Coach'
$Cache = Join-Path $env:LOCALAPPDATA 'Programs\AoE2Coach-cache'
$Data = Join-Path $env:APPDATA 'AoE2 Coach'
$Key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\SanchoPanzaAoE2'

# If this copy lives inside the folder it is about to delete, run a copy from %TEMP% instead.
$Me = $MyInvocation.MyCommand.Path
if (-not $Relaunched -and $Me -and $Me.StartsWith($Dest, [System.StringComparison]::OrdinalIgnoreCase)) {
  $Tmp = Join-Path $env:TEMP 'sancho-panza-uninstall.ps1'
  Copy-Item -Force $Me $Tmp
  $ArgList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Tmp, '-Relaunched')
  if ($Quiet) { $ArgList += '-Quiet' }
  if ($PurgeData) { $ArgList += '-PurgeData' }
  Start-Process -FilePath 'powershell.exe' -ArgumentList $ArgList -WorkingDirectory $env:TEMP
  exit 0
}
Set-Location $env:TEMP

Write-Host ''
Write-Host "=== $AppName — desinstalación ===" -ForegroundColor Yellow
if (-not $Quiet -and -not $PurgeData) {
  Write-Host "Tus datos (ajustes, API key, logs) están en: $Data"
  $Answer = Read-Host '¿Borrar también esos datos? (s/N)'
  if ($Answer -match '^[sSyY]') { $PurgeData = $true }
}

# 1) Close the app and wait for it
$Procs = Get-Process -Name 'AoE2 Coach' -ErrorAction SilentlyContinue
if ($Procs) {
  Write-Host 'Cerrando la app...'
  $Procs | Stop-Process -Force -ErrorAction SilentlyContinue
  for ($i = 0; $i -lt 40; $i++) { Start-Sleep -Milliseconds 250; if (-not (Get-Process -Name 'AoE2 Coach' -ErrorAction SilentlyContinue)) { break } }
}

function Remove-Tree($Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $true }
  for ($i = 0; $i -lt 5; $i++) {
    try { Remove-Item -Recurse -Force -LiteralPath $Path -ErrorAction Stop; return $true } catch { Start-Sleep -Milliseconds 600 }
  }
  return -not (Test-Path -LiteralPath $Path)
}

# 2) Program folders (current, leftovers from updates) and the runtime cache
foreach ($P in @($Dest, "$Dest.new", "$Dest.old", $Cache)) {
  if (Test-Path -LiteralPath $P) {
    if (Remove-Tree $P) { Write-Host "Borrado: $P" } else { Write-Host "No se pudo borrar: $P (cerrá lo que lo tenga abierto y borralo a mano)" -ForegroundColor Yellow }
  }
}
Get-ChildItem -Path (Split-Path -Parent $Dest) -Directory -Filter 'AoE2Coach.old-*' -ErrorAction SilentlyContinue | ForEach-Object { Remove-Tree $_.FullName | Out-Null }

# 3) Shortcuts (current and old names) and the Apps & features entry
$Desk = [Environment]::GetFolderPath('Desktop')
$StartMenu = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'Microsoft\Windows\Start Menu\Programs'
foreach ($Dir in @($Desk, $StartMenu)) {
  foreach ($L in @("$AppName.lnk", 'AoE2 Coach.lnk', 'Sancho Panza - AOE2 Squier.lnk', 'Sancho Panza - Age of Empires 2 Companion.lnk')) {
    Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $Dir $L)
  }
}
Remove-Item -Path $Key -Recurse -Force -ErrorAction SilentlyContinue

# 4) User data, only when asked
if ($PurgeData) {
  if (Remove-Tree $Data) { Write-Host "Borrados los datos del usuario: $Data" } else { Write-Host "No se pudieron borrar los datos: $Data" -ForegroundColor Yellow }
} else { Write-Host "Tus datos quedaron en $Data (se usan de nuevo si reinstalás)." }

Write-Host ''
Write-Host 'Listo. Sancho Panza quedó desinstalado.' -ForegroundColor Green
if (-not $Quiet) { Write-Host ''; Read-Host 'Enter para cerrar' | Out-Null }
