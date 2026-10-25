#!/bin/bash
# LAN-сертификат под текущий IP: DHCP меняет адрес мини-ПК — Caddy и сертификат
# обязаны догнать, иначе локальные чаты умирают по адресу.
set -u
C=/home/vincentfox/omp-mobile/certs
CUR=$(ip -4 addr show scope global 2>/dev/null | grep -oP '(?<=inet\s)\d+(\.\d+){3}' | head -1)
[ -z "$CUR" ] && exit 0
if openssl x509 -in "$C/leaf.crt" -noout -text 2>/dev/null | grep -q "IP Address:$CUR"; then
  exit 0
fi
cd "$C" || exit 1
printf "subjectAltName=IP:%s,IP:192.168.1.18,DNS:localhost,DNS:Thor1\nextendedKeyUsage=serverAuth" "$CUR" > leaf.ext
openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -keyout leaf.key -out leaf.csr -nodes -subj "/CN=$CUR" 2>/dev/null || exit 1
openssl x509 -req -in leaf.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 825 -out leaf.crt -extfile leaf.ext 2>/dev/null || exit 1
chmod 600 leaf.key
systemctl --user restart caddy-pocket
echo "$(date '+%F %T') leaf перевыпущен под IP $CUR" >> /tmp/lan-cert-refresh.log
