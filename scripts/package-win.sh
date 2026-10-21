#!/usr/bin/env bash
# Builds the Windows package: out/SanchoPanza-<version>-windows-x64.zip (app resources + installer that downloads the Electron runtime).
set -euo pipefail
cd "$(dirname "$0")/.."
V=$(node -p "require('./package.json').version")
rm -rf dist && npx electron-builder --win zip --x64 --publish never
ST=$(mktemp -d); P="$ST/SanchoPanza-$V-windows"
mkdir -p "$P/app" && cp -r dist/win-unpacked/resources "$P/app/" && rm -f "$P/app/resources/default_app.asar"
cp installer/Instalar.bat installer/Desinstalar.bat installer/LEEME.txt installer/setup.ps1 installer/uninstall.ps1 "$P/" && echo "$V" > "$P/app/VERSION" && cp LICENSE "$ST/LICENSE.txt"
mkdir -p out && (cd "$ST" && zip -qr "$OLDPWD/out/SanchoPanza-$V-windows-x64.zip" "SanchoPanza-$V-windows" LICENSE.txt)
echo "out/SanchoPanza-$V-windows-x64.zip"
