#!/bin/bash
# Create a self-signed code signing certificate in the login keychain.
# Signing with a stable certificate keeps macOS permissions across rebuilds;
# ad-hoc signatures change on every build and the permissions are lost.
set -euo pipefail

NAME="VoiceInput Local Signing"

if security find-certificate -c "$NAME" >/dev/null 2>&1; then
  echo "certificate already exists: $NAME"
  exit 0
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
pass="$(uuidgen)"

# The system LibreSSL writes a PKCS#12 that `security import` can read.
/usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -subj "/CN=$NAME" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=critical,codeSigning" \
  -keyout "$tmp/key.pem" -out "$tmp/cert.pem" 2>/dev/null
/usr/bin/openssl pkcs12 -export -inkey "$tmp/key.pem" -in "$tmp/cert.pem" \
  -out "$tmp/id.p12" -passout "pass:$pass"
# -T lets codesign use the key without a Keychain prompt.
security import "$tmp/id.p12" -k "$HOME/Library/Keychains/login.keychain-db" \
  -P "$pass" -T /usr/bin/codesign >/dev/null

echo "created certificate: $NAME"
