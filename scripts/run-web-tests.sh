#!/usr/bin/env bash
# Runs the web app's tests (app/src/test/web/tests.js) in headless Firefox and prints the results.
# Usage: scripts/run-web-tests.sh [--keep]
#   --keep  leave the generated test page in place and print its path, to open in any browser.
# Exits non-zero if a test fails or the tests didn't run.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KEEP="${1:-}"
WORK="$(mktemp -d)"
PROFILE="$(mktemp -d)"
cleanup() {
  rm -rf "$PROFILE"
  if [ "$KEEP" != "--keep" ]; then rm -rf "$WORK"; fi
}
trap cleanup EXIT

command -v firefox >/dev/null || { echo "firefox is needed to run the web tests" >&2; exit 2; }

cp "$ROOT"/app/src/main/assets/* "$ROOT"/app/src/test/web/*.js "$WORK"/
# The test page is the real index.html with the fake Android bridge before the app and the tests after it.
sed -e 's#<script src="demo-data.js"></script>#<script src="fake-android.js"></script>&#' \
    -e 's#<script src="app.js"></script>#&<script src="tests.js"></script>#' \
    "$WORK/index.html" > "$WORK/test.html"
grep -q 'fake-android.js' "$WORK/test.html" && grep -q 'tests.js' "$WORK/test.html" ||
  { echo "couldn't add the test scripts to index.html (did its <script> tags change?)" >&2; exit 2; }

# Firefox only prints page console output to stdout with this pref set.
echo 'user_pref("devtools.console.stdout.content", true);' > "$PROFILE/user.js"

results=""
for attempt in 1 2 3; do  # headless Firefox occasionally crashes on startup
  out="$(timeout 120 firefox --headless --no-remote --profile "$PROFILE" \
    --window-size 412,900 --screenshot "$WORK/screenshot.png" "file://$WORK/test.html" 2>/dev/null || true)"
  results="$(grep -o 'MKTEST .*' <<<"$out" | sed -e 's/^MKTEST //' -e 's/"$//' -e 's/\\"/"/g' || true)"
  grep -q '^DONE ' <<<"$results" && break
done

if ! grep -q '^DONE ' <<<"$results"; then
  echo "The tests didn't finish. Open the page in a browser to see the error: scripts/run-web-tests.sh --keep" >&2
  exit 1
fi

grep -v '^DONE ' <<<"$results"
summary="$(grep '^DONE ' <<<"$results" | sed 's/^DONE //')"
echo
echo "$summary"
if [ "$KEEP" = "--keep" ]; then echo "Test page: $WORK/test.html"; fi
grep -q ', 0 failed$' <<<"$summary"
