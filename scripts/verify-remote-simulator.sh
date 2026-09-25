#!/usr/bin/env bash
# Semantic Safari UI test on Xcode's iPhone simulator, with a real screen recording.
set -euo pipefail
cd "$(dirname "$0")/.."
SIM_ID="${PIX_TEST_SIMULATOR_ID:-22FCA4D5-31CF-4E17-80B3-CD717D9C0D1D}"
PORT="${PIX_TEST_FIXTURE_PORT:-18787}"
OUT="${PIX_TEST_SIMULATOR_OUTPUT:-$PWD/.private/var/runs/test-ui/remote-simulator-$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$OUT"
command -v xcodegen >/dev/null || { echo 'Install xcodegen: brew install xcodegen' >&2; exit 1; }
if ! xcrun simctl list devices booted | grep -q "$SIM_ID"; then xcrun simctl boot "$SIM_ID"; fi
xcrun simctl bootstatus "$SIM_ID" -b >/dev/null
(cd ios-ui-tests && xcodegen generate) >/dev/null
PIX_TEST_FIXTURE_PORT="$PORT" node scripts/remote-simulator-fixture.mjs > "$OUT/fixture.log" 2>&1 & fixture=$!
recorder=''
cleanup() {
  if [[ -n "$recorder" ]]; then kill -INT "$recorder" 2>/dev/null || true; wait "$recorder" 2>/dev/null || true; fi
  kill -TERM "$fixture" 2>/dev/null || true; wait "$fixture" 2>/dev/null || true
  # Keep the recording and XCTest result, not the regenerable Xcode build cache.
  rm -rf "$OUT/derived-data"
}
trap cleanup EXIT
for attempt in {1..30}; do
  if curl -fsS -H 'authorization: Bearer simulator-demo-token-not-production' http://127.0.0.1:$PORT/api/sessions >/dev/null 2>&1; then break; fi
  if ! kill -0 "$fixture" 2>/dev/null; then echo 'Fixture failed to start; see fixture.log' >&2; exit 1; fi
  sleep 0.2
done
xcrun simctl openurl "$SIM_ID" "http://127.0.0.1:$PORT/?run=$(date +%s)#token=simulator-demo-token-not-production"
xcrun simctl io "$SIM_ID" recordVideo --codec=h264 --force "$OUT/journey.mp4" > "$OUT/recording.log" 2>&1 & recorder=$!
set +e
xcodebuild test -project ios-ui-tests/PixRemoteUI.xcodeproj -scheme PixRemoteTestHost \
  -destination "platform=iOS Simulator,id=$SIM_ID" \
  -derivedDataPath "$OUT/derived-data" -resultBundlePath "$OUT/result.xcresult" \
  CODE_SIGNING_ALLOWED=NO > "$OUT/xcodebuild.log" 2>&1
result=$?
set -e
if [[ $result -eq 0 ]]; then
  xcrun xcresulttool export attachments --path "$OUT/result.xcresult" --output-path "$OUT/attachments" >/dev/null
  echo "PASS: Safari UI journey; video: $OUT/journey.mp4"
else
  grep -E 'error:|failed|TEST FAILED' "$OUT/xcodebuild.log" | tail -15 >&2 || true
  echo "FAIL: $OUT/xcodebuild.log" >&2
fi
exit "$result"
