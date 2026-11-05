#!/usr/bin/env bash
# Auto-run after OMP binary change (triggered by gm-regression.path).
# PASS  -> log + TG ✅.
# FAIL  -> TG 🚨, ROLLBACK (предыдущий бинарь + хуки из последнего pre-update-бэкапа),
#          повторный прогон; успех -> TG ✅ «откат помог», иначе TG ⚠️ «нужен ручной разбор».
set -u
SCRIPT=/home/vincentfox/.omp/agent/hooks/tests/gm-regression.sh
LOG=/home/vincentfox/.omp/agent/hooks/tests/regression.log
TOKEN_FILE=/home/vincentfox/.tgbot/token.txt
CHAT=8127974582
BACKUP_ROOT=/home/vincentfox/.omp/agent/backups

send_tg() {
  [ -f "$TOKEN_FILE" ] || return 0
  local token
  token=$(cat "$TOKEN_FILE")
  curl -s --max-time 20 "https://api.telegram.org/bot${token}/sendMessage" \
    --data-urlencode "chat_id=${CHAT}" --data-urlencode "text=$1" >/dev/null 2>&1
}

log_run() {
  { echo "=== $(date -u '+%Y-%m-%dT%H:%M:%SZ') $1 ==="; echo "$2"; echo; } >> "$LOG"
}

run_regression() {
  "$SCRIPT" 2>&1
}

itog_of() { echo "$1" | grep 'ИТОГ' | tail -1; }

# ── Прогон 1: как есть после обновления ─────────────────────────────
OUT1=$(run_regression)
ITOG1=$(itog_of "$OUT1")
log_run "прогон после обновления" "$OUT1"

if echo "$ITOG1" | grep -q 'FAIL=0'; then
  send_tg "✅ GRANDMASTER-регрессия после обновления OMP: ${ITOG1:-нет итога}. Механизмы живы."
  exit 0
fi

# ── FAIL: тревога + откат ────────────────────────────────────────────
send_tg "🚨 GRANDMASTER-регрессия упала после обновления OMP (${ITOG1:-нет итога}). Откатываюсь на предыдущую версию, лог: $LOG"

LATEST_BACKUP=$(ls -dt "$BACKUP_ROOT"/pre-update-* 2>/dev/null | head -1)
ROLLED=0
if [ -n "$LATEST_BACKUP" ]; then
  BIN_BACKUP=$(ls "$LATEST_BACKUP"/omp.bin-* 2>/dev/null | head -1)
  [ -n "$BIN_BACKUP" ] && { cp "$BIN_BACKUP" /home/vincentfox/.local/bin/omp; ROLLED=1; }
  if [ -d "$LATEST_BACKUP/hooks/pre" ]; then
    cp "$LATEST_BACKUP"/hooks/pre/*.ts /home/vincentfox/.omp/agent/hooks/pre/ 2>/dev/null && ROLLED=1
  fi
  [ -f "$LATEST_BACKUP/APPEND_SYSTEM.md" ] && cp "$LATEST_BACKUP/APPEND_SYSTEM.md" /home/vincentfox/.omp/agent/ 2>/dev/null
  [ -f "$LATEST_BACKUP/RULES.md" ] && cp "$LATEST_BACKUP/RULES.md" /home/vincentfox/.omp/agent/ 2>/dev/null
fi

sleep 2
OUT2=$(run_regression)
ITOG2=$(itog_of "$OUT2")
log_run "прогон после отката (rolled=$ROLLED, backup=$LATEST_BACKUP)" "$OUT2"

if echo "$ITOG2" | grep -q 'FAIL=0'; then
  send_tg "✅ Откат помог: работаем на предыдущей версии OMP, механизмы восстановлены (${ITOG2}). Сломанный бинарь сохранён рядом с бэкапом для разбора."
else
  send_tg "⚠️ Откат НЕ помог (${ITOG2:-нет итога}). Нужен ручной разбор. Лог: $LOG"
fi
