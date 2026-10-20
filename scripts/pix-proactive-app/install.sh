#!/bin/sh
# Builds ~/Applications/Pix Proactive.app: a stable, signed identity the checker runs under, so macOS
# remembers its privacy approval (reading WeChat/DingTalk data) across Node updates. Then points launchd at it.
# Full Disk Access is tied to the app's signature (bundle id + signing certificate). Rebuilding with another
# certificate, or ad hoc, silently drops the grant. So: never rebuild when the app is already right, and refuse
# to re-sign with a different certificate than the one the grant was given to (PIX_FORCE_RESIGN=1 overrides).
set -e
here=$(cd "$(dirname "$0")" && pwd)
app="${PIX_APP:-$HOME/Applications/Pix Proactive.app}"
bin="$app/Contents/MacOS/pix-proactive"
id=dev.brook.pix-proactive
identity=${PIX_SIGN_IDENTITY:-$(security find-identity -v -p codesigning | sed -n 's/.*"\(.*\)"/\1/p' | head -1)}
leaf() { security find-certificate -c "$1" -Z 2>/dev/null | sed -n 's/^SHA-1 hash: //p' | head -1 | tr 'A-F' 'a-f'; }
signed_leaf() { codesign -d -r- "$app" 2>&1 | sed -n 's/.*certificate leaf = H"\([0-9a-f]*\)".*/\1/p'; }
signed_id() { codesign -dv "$app" 2>&1 | sed -n 's/^Identifier=//p'; }
if [ -x "$bin" ] && [ "$(signed_id)" = "$id" ] && codesign --verify "$app" 2>/dev/null; then
  old=$(signed_leaf)
  if [ -n "$old" ] && [ -n "$identity" ] && [ "$old" != "$(leaf "$identity")" ] && [ "${PIX_FORCE_RESIGN:-}" != 1 ]; then
    echo "refusing: the app is signed by another certificate ($old); re-signing would drop Full Disk Access. PIX_FORCE_RESIGN=1 to do it anyway." >&2; exit 1
  fi
  if [ "${PIX_REBUILD:-}" != 1 ] && [ "$bin" -nt "$here/launcher.c" ]; then echo "ok: $app is current and signed ($id); not rebuilt, so Full Disk Access stays"; REUSE=1; fi
fi
if [ -z "${REUSE:-}" ]; then
mkdir -p "$app/Contents/MacOS"
clang -O2 -o "$bin" "$here/launcher.c"
cat > "$app/Contents/Info.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.brook.pix-proactive</string><key>CFBundleName</key><string>Pix Proactive</string>
<key>CFBundleExecutable</key><string>pix-proactive</string><key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string><key>LSUIElement</key><true/>
</dict></plist>
PL
[ -n "$identity" ] || echo "warning: no signing certificate; ad hoc signature changes on every build, so Full Disk Access must be granted again" >&2
codesign --force --sign "${identity:--}" --identifier "$id" "$app"
fi
plist="$HOME/Library/LaunchAgents/dev.brook.pix-proactive.plist"
if [ -f "$plist" ]; then
  /usr/libexec/PlistBuddy -c "Delete :ProgramArguments" -c "Add :ProgramArguments array" \
    -c "Add :ProgramArguments:0 string $app/Contents/MacOS/pix-proactive" -c "Add :ProgramArguments:1 string $(command -v node)" \
    -c "Add :ProgramArguments:2 string $(cd "$here/../.." && pwd)/plugins/foryou/daemon.ts" "$plist"
  launchctl bootout "gui/$(id -u)" "$plist" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$plist"
fi
echo "ok: $app"
