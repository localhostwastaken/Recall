#!/usr/bin/env bash
# Creates a throwaway test CA and a server cert for notice.recall.test in .certs/.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p .certs
cd .certs
openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.pem -days 825 \
  -subj "/CN=Recall Test CA" \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -keyout server.key -out server.csr -subj "/CN=notice.recall.test" 2>/dev/null
printf 'subjectAltName=DNS:notice.recall.test\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n' > server.ext
openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial -out server.pem -days 825 -extfile server.ext 2>/dev/null
openssl x509 -in ca.pem -outform der -out ca.der
chmod 644 *.pem *.der *.key
echo "certs written to $(pwd)"
