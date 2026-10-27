#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTPUT="$ROOT/build/web"

mkdir -p "$OUTPUT/app"
cp -R "$ROOT/docs/." "$OUTPUT/"
cp -R "$ROOT/app/src/main/assets/." "$OUTPUT/app/"
cp -R "$ROOT/app/src/main/assets/." "$OUTPUT/"

echo "Web app built at $OUTPUT"