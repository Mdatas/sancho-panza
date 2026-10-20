#!/usr/bin/env bash
# Builds the Windows package: dist/AoE2Coach-<version>-setup.zip (app resources + installer that downloads the Electron runtime).
set -euo pipefail
cd "$(dirname "$0")/.."
V=$(node -p "require('./package.json').version")
rm -rf dist && npx electron-builder --win zip --x64 --publish never
ST=$(mktemp -d); P="$ST/AoE2Coach-$V-setup"
mkdir -p "$P/app" && cp -r dist/win-unpacked/resources "$P/app/" && rm -f "$P/app/resources/default_app.asar"
cp installer/Instalar.bat installer/LEEME.txt installer/setup.ps1 "$P/" && cp LICENSE "$ST/LICENSE.txt"
mkdir -p out && (cd "$ST" && zip -qr "$OLDPWD/out/AoE2Coach-$V-setup.zip" "AoE2Coach-$V-setup" LICENSE.txt)
echo "out/AoE2Coach-$V-setup.zip"
