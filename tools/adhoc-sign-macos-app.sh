#!/usr/bin/env bash
set -euo pipefail

app_path="${1:-dist/mac-arm64/Kitty Kitty.app}"

if [[ ! -d "$app_path" ]]; then
  echo "macOS app bundle not found: $app_path" >&2
  exit 1
fi

/usr/bin/codesign --force --deep --sign - "$app_path"
/usr/bin/codesign --verify --deep --strict --verbose=2 "$app_path"
