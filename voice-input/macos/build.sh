#!/bin/bash
# Build VoiceInput.app into macos/build/.
set -euo pipefail

cd "$(dirname "$0")"
IDENTITY="VoiceInput Local Signing"
APP="build/VoiceInput.app"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp Info.plist "$APP/Contents/Info.plist"
swiftc -O -swift-version 5 -target arm64-apple-macos14.0 \
  -o "$APP/Contents/MacOS/VoiceInput" Sources/*.swift

if security find-certificate -c "$IDENTITY" >/dev/null 2>&1; then
  codesign --force --sign "$IDENTITY" "$APP"
else
  echo "warning: '$IDENTITY' not found, signing ad-hoc. Permissions reset on every build." >&2
  echo "         run ./make-cert.sh once to avoid that." >&2
  codesign --force --sign - "$APP"
fi
codesign --verify "$APP"
echo "built $APP"
