#!/bin/bash
# Проверка после перезагрузки: убедиться, что шлюз поднялся, а все панели/агенты
# восстановились из panes.json, и оставить доказательство в журнале стола.
set -u

TOKEN=$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/omp-mobile/gateway/config.json')))['token'])")
OUT=${POST_BOOT_OUT:-$HOME/OMP/omp/POST-BOOT.md}
JOURNAL=${POST_BOOT_JOURNAL:-$HOME/OMP/omp/JOURNAL.md}
API=${POST_BOOT_API:-http://127.0.0.1:8088}

# Каждая проверка — отдельный прогон: ждать до 6 минут (панели поднимаются не мгновенно).
for i in $(seq 1 72); do
	health=$(curl -s -m 5 -H "Authorization: Bearer $TOKEN" "$API/api/health" 2>/dev/null)
	case "$health" in *'"ok":true'*) ;; *) sleep 5; continue ;; esac
	hosts=$(curl -s -m 15 -H "Authorization: Bearer $TOKEN" "$API/api/hosts" 2>/dev/null)
	counts=$(printf '%s' "$hosts" | python3 -c "
import sys, json
try:
    h = json.load(sys.stdin)['hosts']
except Exception:
    print('0 0'); raise SystemExit
print(len(h), sum(1 for x in h if x.get('relayConnected')))
" 2>/dev/null)
	total=${counts%% *}
	connected=${counts##* }
	version=$(printf '%s' "$health" | python3 -c "import sys,json;print(json.load(sys.stdin).get('ompVersion','?'))" 2>/dev/null)
	if [ "${total:-0}" -gt 0 ] && [ "${connected:-0}" -ge "${total:-1}" ]; then
		panes=$(python3 -c "
import json
try:
    print(len(json.load(open(os.path.expanduser('~/.local/state/omp-pocket/runtime/panes.json')))['panes']))
except Exception:
    print('?')
" 2>/dev/null)
		{
			echo "# Проверка после перезагрузки"
			echo
			echo "- время: $(date '+%Y-%m-%d %H:%M:%S')"
			echo "- загрузка: $(uptime -s)"
			echo "- OMP: $version"
			echo "- агентов в реестре: $total, на связи: $connected"
			echo "- панелей рантайма: $panes"
			echo "- ожидание: $((i * 5)) с"
		} >"$OUT"
		echo "- $(date '+%Y-%m-%d') — после перезагрузки: OMP $version, агентов $total (на связи $connected), панелей $panes; восстановление заняло $((i * 5)) с. Подробности: POST-BOOT.md" >>"$JOURNAL"
		exit 0
	fi
	sleep 5
done

{
	echo "# Проверка после перезагрузки"
	echo
	echo "- время: $(date '+%Y-%m-%d %H:%M:%S')"
	echo "- агенты не поднялись за 6 минут (в реестре ${total:-?}, на связи ${connected:-?})"
} >"$OUT"
echo "- $(date '+%Y-%m-%d') — после перезагрузки агенты не поднялись за 6 минут (в реестре ${total:-?}, на связи ${connected:-?}). Подробности: POST-BOOT.md" >>"$JOURNAL"
exit 1
