#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTPUT="$ROOT/build/web"

mkdir -p "$OUTPUT/app"
cp -R "$ROOT/docs/." "$OUTPUT/"
# The landing page (docs/) is the site root; the web app lives under app/.
cp -R "$ROOT/app/src/main/assets/." "$OUTPUT/app/"

echo "Web app built at $OUTPUT"