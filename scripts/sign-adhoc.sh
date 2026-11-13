#!/bin/sh
# Ad-hoc signs the packaged app for local testing (no Apple Developer ID is configured on this Mac).
# Signs inside-out: the bundled ffprobe, then the whole app. This is NOT a distribution signature.
set -e
APP="release/mac-arm64/Publisher.app"
codesign --force --sign - --timestamp=none "$APP/Contents/Resources/bin/ffprobe"
codesign --force --deep --sign - --timestamp=none "$APP"
codesign --verify --deep --strict "$APP" && echo "ad-hoc signature OK: $APP"
