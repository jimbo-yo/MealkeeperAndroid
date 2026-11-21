#!/usr/bin/env bash
# Runs the web app's tests (app/src/test/web/tests.js) in headless Firefox and prints the results.
# Usage: scripts/run-web-tests.sh [--keep]
#   --keep  leave the generated test page in place and print its path, to open in any browser.
# Exits non-zero if a test fails or the tests didn't run.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KEEP="${1:-}"
# Under the project rather than /tmp: Firefox installed as a snap can't see /tmp.
mkdir -p "$ROOT/build"
WORK="$(mktemp -d "$ROOT/build/web-test.XXXXXX")"
PROFILE="$(mktemp -d "$ROOT/build/web-test-profile.XXXXXX")"
cleanup() {
  rm -rf "$PROFILE"
  if [ "$KEEP" != "--keep" ]; then rm -rf "$WORK"; fi
}
trap cleanup EXIT

# Firefox is preferred; without it, Chrome, Chromium or Edge (as installed on Windows or Linux) runs the page instead.
BROWSER=""
if ! command -v firefox >/dev/null; then
  for b in google-chrome chromium chromium-browser chrome msedge \
           "/c/Program Files/Google/Chrome/Application/chrome.exe" \
           "/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"; do
    if command -v "$b" >/dev/null 2>&1 || [ -x "$b" ]; then BROWSER="$b"; break; fi
  done
  [ -n "$BROWSER" ] || { echo "Firefox, Chrome or Edge is needed to run the web tests" >&2; exit 2; }
fi

cp -r "$ROOT"/app/src/main/assets/. "$WORK"/
rm -rf "$WORK/model-en-us"
cp "$ROOT"/app/src/test/web/*.js "$WORK"/
# The test page is the real index.html with the fake Android bridge before the app and the tests after it.
sed -e 's#<script src="demo-data.js"></script>#<script src="fake-android.js"></script>&#' \
    -e 's#<script src="app.js"></script>#&<script src="tests.js"></script>#' \
    "$WORK/index.html" > "$WORK/test.html"
grep -q 'fake-android.js' "$WORK/test.html" && grep -q 'tests.js' "$WORK/test.html" ||
  { echo "couldn't add the test scripts to index.html (did its <script> tags change?)" >&2; exit 2; }

# Firefox only prints page console output to stdout with this pref set.
echo 'user_pref("devtools.console.stdout.content", true);' > "$PROFILE/user.js"

results=""
if [ -n "$BROWSER" ]; then
  # Chromium browsers don't print the page's console here, but tests.js also writes the results into the page.
  url="file://$WORK/test.html"
  if command -v cygpath >/dev/null; then url="file:///$(cygpath -m "$WORK/test.html")"; fi
  dom="$(timeout 120 "$BROWSER" --headless=new --disable-gpu --no-first-run --user-data-dir="$PROFILE" \
    --window-size=412,900 --allow-file-access-from-files --dump-dom "$url" 2>/dev/null || true)"
  results="$(sed -n '/<pre/,/<\/pre>/p' <<<"$dom" | sed -e 's/<[^>]*>//g' -e 's/&amp;/\&/g' -e 's/&lt;/</g' -e 's/&gt;/>/g' -e 's/&quot;/"/g' -e "s/&#39;/'/g" |
    sed -n -e 's/^\(PASS\|FAIL\) /&/p' -e 's/^     \(.*\)$/  -- \1/p' -e 's/^\([0-9]* tests, [0-9]* failed\)$/DONE \1/p')"
fi
for attempt in 1 2 3; do  # headless Firefox occasionally crashes on startup
  [ -n "$BROWSER" ] && break
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
