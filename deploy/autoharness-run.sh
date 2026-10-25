#!/usr/bin/env bash
# autoharness-run — суточный прогон autoharness по свежим сессиям omp.
#
# autoharness — плагин под Claude Code (хуки SessionStart/Stop/PreToolUse и MCP
# stage_skill). У нас хост omp, поэтому роль хоста играет адаптер:
#   ~/tools/autoharness-omp/run-episode.py <session.jsonl> <N PreToolUse>
# а рефлектора запускает shim `claude` → `omp -p`.
#
# Скрипт берёт сессии, изменённые за окно (по умолчанию 24 ч), и кормит их
# порциями; плагин сам помнит offset по сессии, поэтому повторный разбор не
# дублирует уже обработанные байты.
#
#   autoharness-run            обычный прогон
#   autoharness-run --check    только показать, что было бы обработано
set -uo pipefail

ROOT="$HOME/tools/autoharness"
ADAPTER="$HOME/tools/autoharness-omp"
SESSIONS="$HOME/.omp/agent/sessions"
LOCK="$HOME/.claude/autoharness/omp-run.lock"
LOG="$HOME/.claude/autoharness/omp-run.log"
HOURS="${AUTOHARNESS_WINDOW_HOURS:-24}"
THRESHOLD="${AUTOHARNESS_REFLECT_EVERY_N:-40}"
MAX_SESSIONS="${AUTOHARNESS_MAX_SESSIONS:-3}"
CHECK=0
[ "${1:-}" = "--check" ] && CHECK=1

mkdir -p "$(dirname "$LOCK")"

if [ "$CHECK" = 0 ]; then
  # Один прогон за раз: рефлектор — это отдельный omp-процесс на каждую сессию.
  exec 9>"$LOCK"
  if ! flock -n 9; then
    echo "autoharness-run: уже идёт другой прогон, выходим"
    exit 0
  fi
fi

export PATH="$ADAPTER:$PATH"
export PYTHONPATH="$ROOT/src"
export AUTOHARNESS_REFLECT_EVERY_N="$THRESHOLD"
export AUTOHARNESS_PROJECT_ROOT="$HOME/omp-mobile/.claude"

# Свежие сессии: файл .jsonl, изменённый за окно и не пустой.
mapfile -t FILES < <(find "$SESSIONS" -maxdepth 3 -name "*.jsonl" -mmin "-$((HOURS * 60))" -size +8k \
  | xargs -r ls -t | head -n "$MAX_SESSIONS")

if [ "${#FILES[@]}" -eq 0 ]; then
  echo "autoharness-run: за ${HOURS} ч нет сессий для разбора"
  [ "$CHECK" = 1 ] || echo "$(date -Is) нет сессий" >> "$LOG"
  exit 0
fi

echo "автохарнесс: сессий к разбору ${#FILES[@]} (порог ${THRESHOLD} tool-call'ов)"
for f in "${FILES[@]}"; do
  if [ "$CHECK" = 1 ]; then
    echo "  - $(basename "$f") ($(du -h "$f" | cut -f1))"
    continue
  fi
  python3 "$ADAPTER/run-episode.py" "$f" "$THRESHOLD" >> "$LOG" 2>&1
  echo "  - $(basename "$f") → отправлено"
done

if [ "$CHECK" = 0 ]; then
  NEW=$(find "$HOME/.claude/skills" -maxdepth 2 -name SKILL.md -newermt "-30 minutes" 2>/dev/null | wc -l)
  echo "$(date -Is) прогон завершён; скилов обновлено за 30 мин: $NEW" >> "$LOG"
  echo "готово; обновлённых скилов: $NEW (лог: $LOG)"
fi
