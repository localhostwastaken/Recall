#!/usr/bin/env bash
# Creates a throwaway test CA (only if there is none yet: the witness and dev extension builds
# trust it) and a server cert, signed by it, for the fixture hosts: notice.recall.test plus the
# GitHub-like api.github.recall.test and codeload.github.recall.test (R46). Rerun it to reissue
# the server cert with the current host list; the CA stays.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p .certs
cd .certs
if [ ! -f ca.key ] || [ ! -f ca.pem ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.pem -days 825 \
    -subj "/CN=Recall Test CA" \
    -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
fi
openssl req -newkey rsa:2048 -nodes -keyout server.key -out server.csr -subj "/CN=notice.recall.test" 2>/dev/null
printf 'subjectAltName=DNS:notice.recall.test,DNS:api.github.recall.test,DNS:codeload.github.recall.test\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n' > server.ext
openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial -out server.pem -days 825 -extfile server.ext 2>/dev/null
openssl x509 -in ca.pem -outform der -out ca.der
chmod 644 *.pem *.der *.key
echo "certs written to $(pwd)"
