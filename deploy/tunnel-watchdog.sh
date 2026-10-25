#!/usr/bin/env bash
# Watchdog реверс-туннеля de5 -> OMP Pocket gateway.
#
# ssh -R с ServerAliveInterval ловит обрыв канала, но не случай «канал есть,
# а форвард мёртв» (зависший listener на de5, перезапуск gateway). Проверяем
# сквозную доступность gateway через туннель с самого de5 и, если она мертва
# два тика подряд, перезапускаем юнит.
#
# Если не проходит сам ssh к de5 — сети нет: рестарт туннеля бесполезен,
# ждём (подъёмом займётся Restart=always самого ssh-юнита).
set -uo pipefail

PROBE_URL="http://127.0.0.1:8088/api/health"
FAIL_FILE="${XDG_RUNTIME_DIR:-/tmp}/omp-pocket-tunnel-watchdog.fails"
UNIT="omp-pocket-tunnel.service"

if ! timeout 20 ssh -o BatchMode=yes -o ConnectTimeout=8 de5 true 2>/dev/null; then
  echo "de5 недоступен (нет канала) — рестарт туннеля не нужен"
  exit 0
fi

code=$(timeout 20 ssh -o BatchMode=yes -o ConnectTimeout=8 de5 \
  "curl -s -o /dev/null -w '%{http_code}' --max-time 6 ${PROBE_URL}" 2>/dev/null)

if [ "${code}" = "200" ]; then
  rm -f "${FAIL_FILE}"
  exit 0
fi

fails=$(( $(cat "${FAIL_FILE}" 2>/dev/null || echo 0) + 1 ))
echo "${fails}" > "${FAIL_FILE}"
echo "проба через туннель: HTTP '${code}' (провал ${fails}/2)"
if [ "${fails}" -ge 2 ]; then
  rm -f "${FAIL_FILE}"
  systemctl --user restart "${UNIT}"
  echo "туннель мёртв — ${UNIT} перезапущен"
fi
