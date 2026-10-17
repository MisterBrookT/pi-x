#!/bin/sh
# Builds ~/Applications/Pix Proactive.app: a stable, signed identity the checker runs under, so macOS
# remembers its privacy approval (reading WeChat/DingTalk data) across Node updates. Then points launchd at it.
set -e
here=$(cd "$(dirname "$0")" && pwd)
app="$HOME/Applications/Pix Proactive.app"
mkdir -p "$app/Contents/MacOS"
clang -O2 -o "$app/Contents/MacOS/pix-proactive" "$here/launcher.c"
cat > "$app/Contents/Info.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.brook.pix-proactive</string><key>CFBundleName</key><string>Pix Proactive</string>
<key>CFBundleExecutable</key><string>pix-proactive</string><key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string><key>LSUIElement</key><true/>
</dict></plist>
PL
identity=${PIX_SIGN_IDENTITY:-$(security find-identity -v -p codesigning | sed -n 's/.*"\(.*\)"/\1/p' | head -1)}
codesign --force --sign "${identity:--}" --identifier dev.brook.pix-proactive "$app"
plist="$HOME/Library/LaunchAgents/dev.brook.pix-proactive.plist"
if [ -f "$plist" ]; then
  /usr/libexec/PlistBuddy -c "Delete :ProgramArguments" -c "Add :ProgramArguments array" \
    -c "Add :ProgramArguments:0 string $app/Contents/MacOS/pix-proactive" -c "Add :ProgramArguments:1 string $(command -v node)" \
    -c "Add :ProgramArguments:2 string $(cd "$here/../.." && pwd)/plugins/foryou/daemon.ts" "$plist"
  launchctl bootout "gui/$(id -u)" "$plist" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$plist"
fi
echo "ok: $app"
