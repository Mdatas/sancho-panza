#!/usr/bin/env bash
# Builds the Mac packages (Apple chip + Intel): out/SanchoPanza-<version>-mac-{arm64,x64}.zip
# On macOS the apps are ad-hoc signed with codesign; on Linux with rcodesign (if installed). Not notarised.
set -euo pipefail
cd "$(dirname "$0")/.."
V=$(node -p "require('./package.json').version")
rm -rf dist && npx electron-builder --mac zip --arm64 --x64 --publish never
APP="Sancho Panza - Age of Empires 2 Fan Companion.app"; mkdir -p out
for pair in "mac-arm64:arm64" "mac:x64"; do
  d=${pair%%:*}; a=${pair##*:}
  # harden the runtime before signing: no ELECTRON_RUN_AS_NODE / NODE_OPTIONS / --inspect against the installed app
  EXE=$(find "dist/$d/$APP/Contents/MacOS" -maxdepth 1 -type f | head -1)
  if [ -n "$EXE" ]; then node scripts/fuses.js "$EXE"; else echo "warning: no executable found for the fuses in dist/$d/$APP"; fi
  if command -v codesign >/dev/null; then codesign --force --deep --sign - "dist/$d/$APP"; elif command -v rcodesign >/dev/null; then rcodesign sign "dist/$d/$APP"; fi
  ST=$(mktemp -d); cp -a "dist/$d/$APP" "$ST/"; cp installer/LEEME-Mac.txt "$ST/LEEME.txt"; cp LICENSE "$ST/LICENSE.txt"
  (cd "$ST" && zip -qry -9 "$OLDPWD/out/SanchoPanza-$V-mac-$a.zip" "$APP" LEEME.txt LICENSE.txt)
  echo "out/SanchoPanza-$V-mac-$a.zip"
done
