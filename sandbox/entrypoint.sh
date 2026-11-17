#!/bin/sh
set -e
# egress (mitmproxy) の CA を信頼ストアに入れる。
# これによりサンドボックス内の git/curl は egress 経由の TLS を検証できる。
# 本物のクレデンシャルはここにも置かない (egress が通信時に付与する)。
# CA は docker-compose の egress-ca ボリューム経由で /egress-ca にマウントされる。
i=0
while [ $i -lt 30 ]; do
  if [ -f /egress-ca/mitmproxy-ca-cert.pem ]; then
    cp /egress-ca/mitmproxy-ca-cert.pem /usr/local/share/ca-certificates/mitmproxy-ca.crt
    update-ca-certificates || true
    export NODE_EXTRA_CA_CERTS=/egress-ca/mitmproxy-ca-cert.pem
    break
  fi
  i=$((i + 1))
  sleep 1
done
exec node server.mjs
