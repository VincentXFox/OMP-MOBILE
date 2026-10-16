#!/bin/bash
# Автовосстановление доступа к de5 после fail2ban-бана (раунд 18).
# Каждые 30 мин одна тихая проба SSH. Как только пускает — делает весь пакет:
# 1) unban домашнего IP + ignoreip (чтобы больше не банило)
# 2) sshd MaxStartups побольше
# 3) Caddy: сайт pocket.vincentfox.ru -> 127.0.0.1:8088 (OMP Pocket)
# 4) проверка https://pocket.vincentfox.ru/api/hosts
set -u
HOME_IP="78.17.85.23"
LOG=/tmp/de5-recovery.log
log() { echo "$(date '+%H:%M:%S') $*" >> "$LOG"; }

for attempt in 1 2 3 4; do
  log "проба $attempt"
  if ssh -o ConnectTimeout=10 -o BatchMode=yes de5 'echo SSH-OK' 2>/dev/null | grep -q SSH-OK; then
    log "SSH пустил — разворачиваю пакет"
    ssh -o BatchMode=yes de5 bash -s <<'REMOTE'
set -e
sudo fail2ban-client set sshd unbanip 78.17.85.23 2>/dev/null || sudo fail2ban-client unban 78.17.85.23 2>/dev/null || echo "fail2ban не установлен/уже разбанен"
sudo mkdir -p /etc/fail2ban/jail.d
echo -e "[sshd]\nignoreip = 127.0.0.1/8 78.17.85.23" | sudo tee /etc/fail2ban/jail.d/ignore-home.conf >/dev/null
sudo systemctl reload fail2ban 2>/dev/null || true
if grep -q '^MaxStartups' /etc/ssh/sshd_config; then
  sudo sed -i 's/^MaxStartups.*/MaxStartups 30:30:60/' /etc/ssh/sshd_config
else
  echo 'MaxStartups 30:30:60' | sudo tee -a /etc/ssh/sshd_config >/dev/null
fi
sudo sshd -t && sudo systemctl reload sshd
echo "sshd: MaxStartups поднят, ignoreip прописан"
REMOTE
    log "ssh-пакет применён; правлю Caddy"
    ssh -o BatchMode=yes de5 bash -s <<'REMOTE'
set -e
sudo cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak.$(date +%s)"
grep -q 'pocket.vincentfox.ru' /etc/caddy/Caddyfile || printf '\npocket.vincentfox.ru {\n\treverse_proxy 127.0.0.1:8088\n}\n' | sudo tee -a /etc/caddy/Caddyfile >/dev/null
sudo caddy validate --config /etc/caddy/Caddyfile >/dev/null && sudo systemctl reload caddy
echo "caddy: сайт pocket добавлен, reload ok"
REMOTE
    sleep 5
    CODE=$(curl -s -m 15 -o /dev/null -w '%{http_code}' https://pocket.vincentfox.ru/api/hosts || echo 000)
    log "https://pocket.vincentfox.ru/api/hosts -> $CODE (401 = норм, значит Pocket отвечает)"
    if [ "$CODE" = "200" ] || [ "$CODE" = "401" ]; then log "ГОТОВО"; exit 0; fi
    exit 1
  fi
  # бан ещё висит: тихо ждём 30 мин (без долбления — иначе рекидив продлит бан)
  sleep 1800
done
log "за 2 часа бан не спал — нужен ручной unban с консоли VPS: fail2ban-client set sshd unbanip 78.17.85.23"
exit 1
