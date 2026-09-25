#!/bin/sh
# One-shot: a throwaway CA and a server certificate for the hostname `fake-imei24`, written to
# $CERT_DIR (a compose volume that `down -v` deletes). imei-check trusts the CA through
# NODE_EXTRA_CA_CERTS -- the only way a local fake can satisfy its https-only IMEI24_BASE_URL rule
# without a code change. Idempotent: an existing CA is kept.
set -eu
CERT_DIR="${CERT_DIR:-/certs}"
HOST="${CERT_HOST:-fake-imei24}"
cd "$CERT_DIR"

if [ -f ca.crt ] && [ -f server.crt ] && [ -f server.key ]; then
  echo "certs already present in $CERT_DIR"
  exit 0
fi

openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=local-stack fake CA" \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -keyout ca.key -out ca.crt 2>/dev/null

openssl req -newkey rsa:2048 -nodes -subj "/CN=$HOST" -keyout server.key -out server.csr 2>/dev/null
printf 'subjectAltName=DNS:%s\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n' "$HOST" > server.ext
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 30 \
  -extfile server.ext -out server.crt 2>/dev/null

rm -f server.csr server.ext ca.srl ca.key   # the CA key is never needed again
# The server runs as `node` (uid 1000); everything else only needs to read the certificates.
chmod 644 ca.crt server.crt
chown 1000:1000 server.key
chmod 600 server.key
echo "wrote ca.crt, server.crt, server.key for $HOST to $CERT_DIR"
