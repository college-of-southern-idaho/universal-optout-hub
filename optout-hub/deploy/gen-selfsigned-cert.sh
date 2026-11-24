#!/usr/bin/env sh
# Generate a self-signed TLS cert for LOCAL / TESTING use only.
# Browsers will warn on a self-signed cert — that's expected. For production,
# use a real certificate (Let's Encrypt or your CA) and place it as:
#   certs/server.crt   (full chain)
#   certs/server.key   (private key)
#
# Usage:  ./gen-selfsigned-cert.sh [hostname]   (default: localhost)
set -e
CN="${1:-localhost}"
mkdir -p certs
openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout certs/server.key -out certs/server.crt \
  -subj "/CN=${CN}" -addext "subjectAltName=DNS:${CN}"
chmod 600 certs/server.key
echo "Self-signed cert for CN=${CN} written to ./certs/ (testing only — browsers will warn)."
