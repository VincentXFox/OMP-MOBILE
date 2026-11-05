#!/usr/bin/env bash
# GRANDMASTER regression v4: deterministic unit-level checks of both hooks via bun,
# plus one live omp -p smoke for the real pipeline. Run after every `omp update`.
# v4 (7.4): memory is delivered via { systemPrompt } (GM-MEMORY block + MEMORY-CHECKSUM),
# session_compact resets dedup, stop-gate enforces ПАМЯТЬ: <метка>. Probes read the new
# return shape; GM_HOOK/GM_GATE overrides let the same suite run against old copies
# (fail-on-old proof) or against unpacked kit archives.
# Exit 0 = all PASS. On FAIL restore hooks from ~/.omp/agent/GRANDMASTER_7_1/ and retest.
set -u
export PATH="/home/vincentfox/.bun/bin:/home/vincentfox/.local/bin:$PATH"
HOOK="${GM_HOOK:-/home/vincentfox/.omp/agent/hooks/pre/grandmaster-memory.ts}"
GATE="${GM_GATE:-/home/vincentfox/.omp/agent/hooks/pre/grandmaster-stop-gate.ts}"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }
check() { if [ "$2" = "0" ]; then ok "$1"; else bad "$1"; fi; }

[ -f "$HOOK" ] && ok "хук памяти на месте" || bad "хук памяти отсутствует"
[ -f "$GATE" ] && ok "стоп-гейт на месте" || bad "стоп-гейт отсутствует"

bun -e "const m = await import('$HOOK'); if (typeof m.default !== 'function') process.exit(1)" 2>/dev/null
check "хук памяти импортируется" $?
bun -e "const m = await import('$GATE'); if (typeof m.default !== 'function') process.exit(1)" 2>/dev/null
check "стоп-гейт импортируется" $?

# Probe of the memory hook: registers handlers, calls before_agent_start twice with a
# host-like base systemPrompt (second call re-feeds the first result — idempotency),
# optionally fires session_compact between the calls; the memory-dir snapshot is taken
# AFTER the first call (seeding happens inside the handler).
MEM_PROBE='
const m = await import(process.env.GM_HOOK);
const handlers = {};
m.default({ on: (e, h) => { (handlers[e] = handlers[e] || []).push(h); } });
const cwd = process.env.GM_CWD;
const fs = require("fs");
const BASE = ["BASE-SYSTEM-PROMPT"];
const call = (prev) => handlers.before_agent_start[0]({ systemPrompt: prev || BASE }, { cwd });
const r1 = await call(null);
const files = fs.existsSync(cwd + "/.omp/memory") ? fs.readdirSync(cwd + "/.omp/memory").sort().join(",") : "";
const sp1 = r1 && r1.systemPrompt ? r1.systemPrompt.join("\n") : null;
const d1 = m.gm74DedupState ? m.gm74DedupState() : null;
let dc = null;
if (process.env.GM_COMPACT === "1") {
  handlers.session_compact[0]({}, { cwd });
  dc = m.gm74DedupState ? m.gm74DedupState() : null;
}
const r2 = await call(r1 && r1.systemPrompt ? r1.systemPrompt : null);
const sp2 = r2 && r2.systemPrompt ? r2.systemPrompt.join("\n") : null;
const d2 = m.gm74DedupState ? m.gm74DedupState() : null;
console.log(JSON.stringify({ files, sp1, sp2, d1, dc, d2 }));
'

# Probe of the stop gate: feeds a list of final-answer texts through session_stop
# with an optional __gmMemory state, prints the decision sequence.
GATE_PROBE='
const m = await import(process.env.GM_GATE);
let handler; m.default({ on: (e, h) => { handler = h; } });
const cwd = process.env.GM_CWD;
if (process.env.GM_STATE) globalThis.__gmMemory = JSON.parse(process.env.GM_STATE);
const texts = JSON.parse(process.env.GM_TEXTS);
const sid = process.env.GM_SID || "probe-fixed";
const decisions = [];
for (const t of texts) {
  const r = await handler({ last_assistant_message: t, session_id: sid }, { cwd });
  decisions.push(r ? r.decision : null);
}
console.log(JSON.stringify({ decisions }));
'

# T1. Ожидание: в чистом git-проекте хук засевает ровно 6 шаблонов и НЕ вставляет память
# (все файлы шаблонные) — sp1 должно быть null. Проверка сохранённого поведения 7.2.
rm -rf /tmp/gmr1; mkdir -p /tmp/gmr1; git -C /tmp/gmr1 init -q
OUT=$(GM_HOOK="$HOOK" GM_CWD=/tmp/gmr1 bun -e "$MEM_PROBE" 2>&1)
echo "$OUT" | grep -q '"files":"CURRENT.md,DECISIONS.md,EVIDENCE.md,FAILURES.md,QUALITY.md,TASKS.md"' && ok "T1 автосев: 6 шаблонов" || bad "T1 автосев: $OUT"
echo "$OUT" | grep -q '"sp1":null' && ok "T1 шаблоны молчат" || bad "T1 инжект при шаблонах: $OUT"

# T2. Ожидание: при заполненном DECISIONS память попадает в ВОЗВРАЩАЕМЫЙ systemPrompt
# (sp1): маркеры <<<GM-MEMORY/GM-MEMORY>>>, строка MEMORY-CHECKSUM:, инструкция «ПАМЯТЬ: »,
# цитата маркера внутри контента сохраняется; повторный вызов с уже содержащим блок
# systemPrompt НЕ дублирует блок (ровно по одному вхождению маркера на каждый промпт,
# суммарно 2). На коде 7.2 (возврат {message}) тест обязан падать: sp1=null.
rm -rf /tmp/gmr2; mkdir -p /tmp/gmr2/.omp/memory; git -C /tmp/gmr2 init -q
printf '# Durable decisions (append-only, newest LAST)\n2026-01-01T00:00Z | keep `<!-- TEMPLATE -->` literal | unit probe | -\n' > /tmp/gmr2/.omp/memory/DECISIONS.md
OUT=$(GM_HOOK="$HOOK" GM_CWD=/tmp/gmr2 bun -e "$MEM_PROBE" 2>&1)
echo "$OUT" | grep -q 'BASE-SYSTEM-PROMPT' && ok "T2 база системного промпта сохранена" || bad "T2 база потеряна: $OUT"
echo "$OUT" | grep -q '"sp1":"[^n]' && echo "$OUT" | grep -q 'MEMORY-CHECKSUM:' && echo "$OUT" | grep -q 'GM-MEMORY>>>' && echo "$OUT" | grep -q 'ПАМЯТЬ: ' && ok "T2 память в systemPrompt: маркеры+checksum+инструкция" || bad "T2 нет блока в systemPrompt: $OUT"
echo "$OUT" | grep -q '## DECISIONS' && ok "T2 заполненный файл инжектится" || bad "T2 нет секции: $OUT"
echo "$OUT" | grep -q 'TEMPLATE' && ok "T2 цитата маркера внутри инжекта" || bad "T2 цитата потерялась"
n=$(echo "$OUT" | grep -o '<<<GM-MEMORY' | wc -l)
[ "$n" = "2" ] && ok "T2 идемпотентность: блок не дублируется (2 вхождения на 2 промпта)" || bad "T2 дублирование блока (n=$n): $OUT"

# T3. Ожидание: в домашнем каталоге (~ с заполненным ~/.omp/memory) инжектится CURRENT.md.
OUT=$(GM_HOOK="$HOOK" GM_CWD=/home/vincentfox bun -e "$MEM_PROBE" 2>&1)
echo "$OUT" | grep -q '## CURRENT.md' && ok "T3 home: заполненный реестр инжектится" || bad "T3 home: $OUT"

# T8a. Ожидание: без compact повторные вызовы с тем же содержимым НЕ переигрывают вставку:
# lastHash после первого и второго вызова совпадает. На старом коде gm74DedupState нет → падение.
OUT=$(GM_HOOK="$HOOK" GM_CWD=/tmp/gmr2 bun -e "$MEM_PROBE" 2>&1)
h1=$(echo "$OUT" | grep -o '"d1":{"lastHash":"[0-9a-f]*"' | grep -o '[0-9a-f]\{64\}')
h2=$(echo "$OUT" | grep -o '"d2":{"lastHash":"[0-9a-f]*"' | grep -o '[0-9a-f]\{64\}')
[ -n "$h1" ] && [ "$h1" = "$h2" ] && ok "T8a без compact lastHash стабилен" || bad "T8a: h1='$h1' h2='$h2' ($OUT)"

# T8b. Ожидание: session_compact сбрасывает дедупликацию (lastHash="" сразу после события) и
# следующий вызов вставляет память заново, хотя содержимое не менялось (d2.lastHash ненулевой,
# sp2 доставлен). На старом коде обработчика session_compact нет → падение.
OUT=$(GM_HOOK="$HOOK" GM_COMPACT=1 GM_CWD=/tmp/gmr2 bun -e "$MEM_PROBE" 2>&1)
echo "$OUT" | grep -q '"dc":{"lastHash":""' && echo "$OUT" | grep -q '"d2":{"lastHash":"[0-9a-f]' && echo "$OUT" | grep -q '"sp2":"[^n]' && ok "T8b compact сбрасывает дедуп, следующий ход вставляет заново" || bad "T8b: $OUT"

# T4. Ожидание: гейт блокирует фальшивое ГОТОВО при PENDING-реестре; общий лимит 6 блоков на
# сессию (7.5), затем разрешение (6×block, null, null). Состояние __gmMemory не задано —
# ack-правило 7.4 молчит, работают правила 7.3/7.5.
rm -rf /tmp/gmr4; mkdir -p /tmp/gmr4/.omp/memory; git -C /tmp/gmr4 init -q
printf '# Quality gate\n| Criterion | Evidence | Result | Risk | Status |\n|---|---|---|---|---|\n| dummy | y | z | - | PENDING |\n' > /tmp/gmr4/.omp/memory/QUALITY.md
OUT=$(GM_GATE="$GATE" GM_CWD=/tmp/gmr4 GM_TEXTS='["СТАТУС: ГОТОВО","СТАТУС: ГОТОВО","СТАТУС: ГОТОВО","СТАТУС: ГОТОВО","СТАТУС: ГОТОВО","СТАТУС: ГОТОВО","СТАТУС: ГОТОВО","СТАТУС: ГОТОВО"]' bun -e "$GATE_PROBE" 2>&1)
echo "$OUT" | grep -q '"decisions":\["block","block","block","block","block","block","block",null\]' && ok "T4 фальшивое ГОТОВО: 6 блоков + последнее требование честного статуса, затем отпуск" || bad "T4: $OUT"

# T5. Ожидание: честный PARTIAL не блокируется.
OUT=$(GM_GATE="$GATE" GM_CWD=/tmp/gmr4 GM_TEXTS='["СТАТУС: PARTIAL\nБЛОКЕР: нет доступа к устройству\nПробовал: ssh, adb"]' bun -e "$GATE_PROBE" 2>&1)
echo "$OUT" | grep -q '"decisions":\[null\]' && ok "T5 честный PARTIAL проходит" || bad "T5: $OUT"

# T9. Ожидание ack-правила 7.4 (проект с реальной CURRENT.md, открытых пунктов нет):
# без метки → block; текущая метка → проход; метка предыдущей вставки → проход; чужая метка →
# block; ответ без СТАТУС (тривиальный) → не блокируется. На гейте 7.3 все пять → null, тест падает.
rm -rf /tmp/gmr9; mkdir -p /tmp/gmr9/.omp/memory; git -C /tmp/gmr9 init -q
printf '# CURRENT\ngoal: seeds for the garden\n' > /tmp/gmr9/.omp/memory/CURRENT.md
GM_STATE='{"checksum":"aaaaaaaaaaaa","prev":"bbbbbbbbbbbb","injectedAt":"2026-01-01T00:00:00Z"}'
GM_TEXTS='["СТАТУС: ГОТОВО","СТАТУС: ГОТОВО\nПАМЯТЬ: aaaaaaaaaaaa; цель: seeds for the garden\nEVIDENCE: probe -> ok\nCONTRACT: AC-01 результат проверен\nREGRESSION: смежные сценарии → ok\nINVARIANTS: доступ и секреты → соблюдены\nRESIDUAL: нет в охвате проверки","СТАТУС: ГОТОВО\nПАМЯТЬ: bbbbbbbbbbbb; цель: x\nEVIDENCE: probe -> ok\nCONTRACT: AC-01 результат проверен\nREGRESSION: смежные сценарии → ok\nINVARIANTS: доступ и секреты → соблюдены\nRESIDUAL: нет в охвате проверки","СТАТУС: ГОТОВО\nПАМЯТЬ: cccccccccccc; цель: x\nEVIDENCE: probe -> ok\nCONTRACT: AC-01 результат проверен\nREGRESSION: смежные сценарии → ok\nINVARIANTS: доступ и секреты → соблюдены\nRESIDUAL: нет в охвате проверки","Просто привет"]'
OUT=$(GM_GATE="$GATE" GM_CWD=/tmp/gmr9 GM_STATE="$GM_STATE" GM_TEXTS="$GM_TEXTS" bun -e "$GATE_PROBE" 2>&1)
echo "$OUT" | grep -q '"decisions":\["block",null,null,"block",null\]' && ok "T9 ack: нет/своя/предыдущая/чужая/тривиальный" || bad "T9: $OUT"

# T13. Ожидание: лимит блокировок общий для всех правил (MAX_BLOCKS=6): восемь фальшивых
# ГОТОВО при заданном __gmMemory дают 6×block, null, null — цикла нет.
OUT=$(GM_GATE="$GATE" GM_CWD=/tmp/gmr9 GM_STATE="$GM_STATE" GM_TEXTS='["СТАТУС: ГОТОВО","СТАТУС: ГОТОВО","СТАТУС: ГОТОВО","СТАТУС: ГОТОВО","СТАТУС: ГОТОВО","СТАТУС: ГОТОВО","СТАТУС: ГОТОВО","СТАТУС: ГОТОВО"]' bun -e "$GATE_PROBE" 2>&1)
echo "$OUT" | grep -q '"decisions":\["block","block","block","block","block","block","block",null\]' && ok "T13 общий лимит 6 + последнее требование честного статуса" || bad "T13: $OUT"

# T14 (8.0). Ожидание: ГОТОВО-С-ОГРАНИЧЕНИЯМИ без тега блокируется; с тегом, но без
# доказанной попытки — тоже блокируется (8.0: оговорка без «пробовал» = несделанная работа);
# и только тег + попытка проходят. Три текста → block, block, null.
OUT=$(GM_GATE="$GATE" GM_CWD=/tmp/gmr9 GM_STATE="$GM_STATE" GM_TEXTS='["СТАТУС: ГОТОВО-С-ОГРАНИЧЕНИЯМИ\nПАМЯТЬ: aaaaaaaaaaaa; цель: x\nНе проверено на телефоне","СТАТУС: ГОТОВО-С-ОГРАНИЧЕНИЯМИ\nПАМЯТЬ: aaaaaaaaaaaa; цель: x\nНе проверено на телефоне [железо]","СТАТУС: ГОТОВО-С-ОГРАНИЧЕНИЯМИ\nПАМЯТЬ: aaaaaaaaaaaa; цель: x\nПробовал: adb devices → устройства нет\nНе проверено на телефоне [железо]\nCONTRACT: AC-01 результат проверен\nREGRESSION: смежные сценарии → ok\nINVARIANTS: доступ и секреты → соблюдены\nRESIDUAL: нет в охвате проверки"]' bun -e "$GATE_PROBE" 2>&1)
echo "$OUT" | grep -q '"decisions":\["block","block",null\]' && ok "T14 (8.0) оговорки: тег + доказанная попытка" || bad "T14: $OUT"
OUT=$(GM_GATE="$GATE" GM_CWD=/tmp/gmr4 GM_STATE="$GM_STATE" GM_TEXTS='["СТАТУС: ГОТОВО-С-ОГРАНИЧЕНИЯМИ\nПАМЯТЬ: aaaaaaaaaaaa; цель: x\nНе проверено [железо]"]' bun -e "$GATE_PROBE" 2>&1)
echo "$OUT" | grep -q '"decisions":\["block"\]' && ok "T15 оговорка не закрывает PENDING-реестр" || bad "T15: $OUT"

# T16 (7.5). Ожидание: ГОТОВО без строки EVIDENCE блокируется; с ней — проходит.
OUT=$(GM_GATE="$GATE" GM_CWD=/tmp/gmr9 GM_TEXTS='["СТАТУС: ГОТОВО\nПАМЯТЬ: aaaaaaaaaaaa; цель: x","СТАТУС: ГОТОВО\nПАМЯТЬ: aaaaaaaaaaaa; цель: x\nEVIDENCE: omp --version -> 18.10.4\nCONTRACT: AC-01 результат проверен\nREGRESSION: смежные сценарии → ok\nINVARIANTS: доступ и секреты → соблюдены\nRESIDUAL: нет в охвате проверки"]' bun -e "$GATE_PROBE" 2>&1)
echo "$OUT" | grep -q '"decisions":\["block",null\]' && ok "T16 ГОТОВО требует доказательства" || bad "T16: $OUT"

# T17 (7.5). Ожидание: PARTIAL без БЛОКЕР/попыток блокируется, честный PARTIAL проходит.
OUT=$(GM_GATE="$GATE" GM_CWD=/tmp/gmr9 GM_TEXTS='["СТАТУС: PARTIAL","СТАТУС: PARTIAL\nБЛОКЕР: нет доступа к устройству\nПробовал: ssh, adb"]' bun -e "$GATE_PROBE" 2>&1)
echo "$OUT" | grep -q '"decisions":\["block",null\]' && ok "T17 PARTIAL требует блокер и попытки" || bad "T17: $OUT"

# T18 (7.5). Ожидание: запрещённые формулировки внутри цитат/кода — это документация, а не
# обещание; без кавычек та же фраза блокируется.
OUT=$(GM_GATE="$GATE" GM_CWD=/tmp/gmr9 GM_TEXTS='["СТАТУС: ГОТОВО\nПАМЯТЬ: aaaaaaaaaaaa; цель: x\nEVIDENCE: probe -> ok\nCONTRACT: AC-01 результат проверен\nREGRESSION: смежные сценарии → ok\nINVARIANTS: доступ и секреты → соблюдены\nRESIDUAL: нет в охвате проверки\nГейт ловит формулировки «по запросу» и «если скажешь»","СТАТУС: ГОТОВО\nПАМЯТЬ: aaaaaaaaaaaa; цель: x\nEVIDENCE: probe -> ok\nСделаю по запросу"]' bun -e "$GATE_PROBE" 2>&1)
echo "$OUT" | grep -q '"decisions":\[null,"block"\]' && ok "T18 цитаты не считаются обещанием" || bad "T18: $OUT"

# T19 (7.5). Ожидание: метка из истории сессии (recent) принимается — правки реестра во время
# работы вращают checksum, и это не должно блокировать финал; чужая метка по-прежнему блокируется.
GM_STATE2='{"checksum":"cccccccccccc","prev":"bbbbbbbbbbbb","recent":["cccccccccccc","bbbbbbbbbbbb","aaaaaaaaaaaa"],"injectedAt":"2026-01-01T00:00:00Z"}'
OUT=$(GM_GATE="$GATE" GM_CWD=/tmp/gmr9 GM_STATE="$GM_STATE2" GM_TEXTS='["СТАТУС: ГОТОВО\nEVIDENCE: probe -> ok\nCONTRACT: AC-01 результат проверен\nREGRESSION: смежные сценарии → ok\nINVARIANTS: доступ и секреты → соблюдены\nRESIDUAL: нет в охвате проверки\nПАМЯТЬ: aaaaaaaaaaaa; цель: x","СТАТУС: ГОТОВО\nEVIDENCE: probe -> ok\nПАМЯТЬ: dddddddddddd; цель: x"]' bun -e "$GATE_PROBE" 2>&1)
echo "$OUT" | grep -q '"decisions":\[null,"block"\]' && ok "T19 метка из истории сессии принимается" || bad "T19: $OUT"

# T12. Ожидание: проект с TEMPLATE-памятью не требует метки ПАМЯТЬ (memoryExists=false), но
# правило 7.5 о доказательстве действует всегда: ГОТОВО без EVIDENCE → block, с EVIDENCE → null.
rm -rf /tmp/gmr12; mkdir -p /tmp/gmr12/.omp/memory; git -C /tmp/gmr12 init -q
printf '<!-- TEMPLATE -->\n# CURRENT\n' > /tmp/gmr12/.omp/memory/CURRENT.md
OUT=$(GM_GATE="$GATE" GM_CWD=/tmp/gmr12 GM_STATE="$GM_STATE" GM_TEXTS='["СТАТУС: ГОТОВО","СТАТУС: ГОТОВО\nEVIDENCE: probe -> ok\nCONTRACT: AC-01 результат проверен\nREGRESSION: смежные сценарии → ok\nINVARIANTS: доступ и секреты → соблюдены\nRESIDUAL: нет в охвате проверки"]' bun -e "$GATE_PROBE" 2>&1)
echo "$OUT" | grep -q '"decisions":\["block",null\]' && ok "T12 шаблонная память: ack не нужен, доказательство нужно" || bad "T12: $OUT"

# T6. Ожидание: вне проекта (нет .git и .omp) — ни посева/инжекта, ни вмешательства гейта.
rm -rf /tmp/gmr6; mkdir -p /tmp/gmr6
OUT=$(GM_HOOK="$HOOK" GM_CWD=/tmp/gmr6 bun -e "$MEM_PROBE" 2>&1)
echo "$OUT" | grep -q '"files":""' && ok "T6a посев/инжект вне проекта молчат" || bad "T6a: $OUT"
OUT=$(GM_GATE="$GATE" GM_CWD=/tmp/gmr6 GM_STATE="$GM_STATE" GM_TEXTS='["СТАТУС: ГОТОВО"]' bun -e "$GATE_PROBE" 2>&1)
echo "$OUT" | grep -q '"decisions":\[null\]' && ok "T6b стоп-гейт не вмешивается вне проекта" || bad "T6b: $OUT"

# T7. Ожидание: живой пайплайн (omp -p) с автосев оставляет ровно 6 файлов реестра.
# Бюджет 240 с на попытку + один повтор. Вывод сохраняется: при обрыве причина (сеть/провайдер/
# падение хука) должна попадать в строку FAIL, а не теряться в /dev/null.
rm -rf /tmp/gmr7; mkdir -p /tmp/gmr7; git -C /tmp/gmr7 init -q
n=0; rc=0; diag=""
for attempt in 1 2; do
  # stdin обязан быть /dev/null: при наследованном stdin `omp -p` навсегда встаёт в фазу
  # readPipedInput и не доходит до сессии (4/4 падения, 150 с, 0 файлов — замерено независимым
  # разбором 2026-10-27). С </dev/null тот же блок проходит за 40 с. --max-time режет модельную
  # фазу: контракт под проверкой — загрузка хуков и посев, он случается ДО вызова модели;
  # под нагрузкой старт доходит до 140 с, поэтому бюджет 300 с, а rc — только диагностика.
  (cd /tmp/gmr7 && timeout 300 omp -p --auto-approve --max-time 20 "Reply one word: ok" </dev/null >/tmp/gmr7.out 2>&1)
  rc=$?
  n=$(ls /tmp/gmr7/.omp/memory 2>/dev/null | wc -l)
  [ "$n" = "6" ] && break
  diag=$(tr -d "\r" </tmp/gmr7.out | tail -3 | tr "\n" " ")
done
check "T7 живой пайплайн: автосев 6 шаблонов (попытка $attempt, файлов $n, rc=$rc${diag:+, вывод: $diag})" $(( n == 6 ? 0 : 1 ))

rm -rf /tmp/gmr1 /tmp/gmr2 /tmp/gmr4 /tmp/gmr6 /tmp/gmr9 /tmp/gmr12 /tmp/gmr7

# --- GRANDMASTER 8.0: три новых контракта (todo-first, loop-breaker, gate 8.0) ---
GM8_TEST=/home/vincentfox/.omp/agent/GRANDMASTER_8/tests/gm8.test.ts
if [ -f "$GM8_TEST" ]; then
  OUT8=$(bun test "$GM8_TEST" 2>&1)
  N8=$(printf '%s' "$OUT8" | sed -n 's/^ *\([0-9]\+\) pass$/\1/p' | tail -1)
  if echo "$OUT8" | grep -q " 0 fail" && [ -n "$N8" ] && [ "$N8" -ge 10 ]; then
    ok "gm8: юнит-контракты хуков ($N8 тестов)"
  else
    bad "gm8: юнит-контракты хуков (pass='${N8:-нет}')"; echo "$OUT8" | tail -20
  fi
else
  bad "gm8: тест-файл отсутствует ($GM8_TEST)"
fi
for f in grandmaster-todo-first.ts grandmaster-loop-breaker.ts; do
  bun -e "const m = await import('/home/vincentfox/.omp/agent/hooks/pre/$f'); if (typeof m.default !== 'function') process.exit(1)" 2>/dev/null
  check "gm8: $f установлен и импортируется" $?
done

# --- Файловое дерево агентских процессов: роутер по cwd ---
TREE_HOOK=/home/vincentfox/.omp/agent/hooks/pre/agent-tree-router.ts
TREE_ROOT=/home/vincentfox/OMP/workflows/omp-pocket-release
[ -f "$TREE_HOOK" ] && ok "tree: хук роутера дерева на месте" || bad "tree: хук отсутствует"
[ -d "$TREE_ROOT" ] && ok "tree: живой процесс на месте" || bad "tree: нет $TREE_ROOT"
TREE_PROBE='
const m = await import(process.env.TREE_HOOK);
const inside = m.treeCard(process.env.TREE_TASK);
const outside = m.treeCard("/home/vincentfox/omp-mobile");
let handler = null;
m.default({ on: (ev, fn) => { if (ev === "before_agent_start") handler = fn; } });
const out = await handler({ type: "before_agent_start", prompt: "тест", systemPrompt: ["база"] }, { cwd: process.env.TREE_TASK, sessionManager: { getSessionId: () => "tree-probe" } });
const again = await handler({ type: "before_agent_start", prompt: "тест", systemPrompt: ["база"] }, { cwd: process.env.TREE_TASK, sessionManager: { getSessionId: () => "tree-probe" } });
const injected = Array.isArray(out?.systemPrompt) ? out.systemPrompt.join("\n") : "";
console.log(JSON.stringify({
  card: typeof inside === "string" && inside.includes("ПРОЦЕСС") && inside.includes("Инструкция шага"),
  outside: outside === null,
  injected: injected.includes("AGENT-TREE") && injected.includes("Правила дерева"),
  baseKept: out?.systemPrompt?.[0] === "база",
  deduped: again === undefined,
}));
'
OUT=$(TREE_HOOK="$TREE_HOOK" TREE_TASK="$TREE_ROOT/01-check" bun -e "$TREE_PROBE" 2>&1)
for key in card outside injected baseKept deduped; do
  if printf '%s' "$OUT" | grep -q "\"$key\":true"; then ok "tree: $key"; else bad "tree: $key ($(printf '%s' "$OUT" | tail -1 | cut -c1-140))"; fi
done
# Внешняя проверка через cli: структура процесса валидна и все шаги оставили результат.
TREE_LINT=$(bun /home/vincentfox/omp-mobile/bin/agent-tree.ts lint 2>&1)
if printf '%s' "$TREE_LINT" | grep -q "структура в порядке"; then ok "tree: lint дерева"; else bad "tree: lint дерева ($(printf '%s' "$TREE_LINT" | head -2 | tr '\n' ' '))"; fi

# --- Граф памяти: второй слой рядом с Mnemopi ---
GRAPH_HOOK=/home/vincentfox/.omp/agent/hooks/pre/graph-memory.ts
[ -f "$GRAPH_HOOK" ] && ok "graph: хук графа памяти на месте" || bad "graph: хук отсутствует"
GRAPH_PROBE='
const m = await import(process.env.GRAPH_HOOK);
if (typeof m.default !== "function") process.exit(2);
let handler = null;
m.default({ on: (ev, fn) => { if (ev === "before_agent_start") handler = fn; } });
if (handler === null) process.exit(3);
const out = await handler({ type: "before_agent_start", prompt: "тест", systemPrompt: ["база"] }, { cwd: "/home/vincentfox", sessionManager: { getSessionId: () => "graph-probe" } });
const parts = Array.isArray(out?.systemPrompt) ? out.systemPrompt : [];
const block = parts.join("\n");
const injected = block.includes("GRAPH-MEMORY") && block.includes("Граф памяти проекта");
const baseKept = parts[0] === "база";
// Повторный старт той же сессии не должен дублировать блок.
const again = await handler({ type: "before_agent_start", prompt: "тест", systemPrompt: ["база"] }, { cwd: "/home/vincentfox", sessionManager: { getSessionId: () => "graph-probe" } });
console.log(JSON.stringify({ injected, baseKept, deduped: again === undefined }));
'
OUT=$(GRAPH_HOOK="$GRAPH_HOOK" bun -e "$GRAPH_PROBE" 2>&1)
if printf '%s' "$OUT" | grep -q '"injected":true' && printf '%s' "$OUT" | grep -q '"baseKept":true'; then
  ok "graph: хук инжектит блок и сохраняет базовый промпт"
else
  bad "graph: инъекция не работает ($(printf '%s' "$OUT" | tail -2 | tr '\n' ' '))"
fi
if printf '%s' "$OUT" | grep -q '"deduped":true'; then
  ok "graph: повторный старт не дублирует блок"
else
  bad "graph: блок дублируется при повторном старте"
fi

# --- GRANDMASTER 9.0: adversarial review + состязательный harness ---
ADV=/home/vincentfox/.omp/agent/hooks/pre/grandmaster-adversarial-review.ts
HARNESS=/home/vincentfox/.omp/agent/harness/gm-harness.sh

[ -f "$ADV" ] && ok "adv: хук adversarial-review на месте" || bad "adv: хук отсутствует"
bun -e "const m = await import('$ADV'); if (typeof m.default !== 'function' || typeof m.gmAdversarialHandler !== 'function') process.exit(1)" 2>/dev/null
check "adv: хук импортируется и отдаёт обработчик" $?

# Проект нужен, иначе гейт молчит по контракту.
rm -rf /tmp/gmr20; mkdir -p /tmp/gmr20/.omp/memory; printf '# CURRENT\nцель\n' > /tmp/gmr20/.omp/memory/CURRENT.md

ADV_PROBE='
const m = await import(process.env.GM_ADV);
const handler = m.gmAdversarialHandler();
const texts = JSON.parse(process.env.GM_TEXTS);
const out = [];
for (const t of texts) {
  const r = await handler({ last_assistant_message: t, session_id: "adv-probe" }, { cwd: process.env.GM_CWD });
  out.push(r && r.decision === "block" ? "block" : null);
}
console.log(JSON.stringify({ decisions: out }));
'
OUT=$(GM_ADV="$ADV" GM_CWD=/tmp/gmr20 GM_TEXTS='["Сделано.\nСТАТУС: ГОТОВО\nEVIDENCE: bun test → 100 pass"]' bun -e "$ADV_PROBE" 2>&1)
echo "$OUT" | grep -q '"decisions":\["block"\]' && ok "adv: ГОТОВО без опровержения блокируется" || bad "adv: $OUT"

OUT=$(GM_ADV="$ADV" GM_CWD=/tmp/gmr20 GM_TEXTS='["ADVERSARIAL: проверил вроде норм\nСТАТУС: ГОТОВО\nEVIDENCE: probe → ok"]' bun -e "$ADV_PROBE" 2>&1)
echo "$OUT" | grep -q '"decisions":\["block"\]' && ok "adv: строка без артефакта и вердикта блокируется" || bad "adv: $OUT"

# Регрессия находки F1: артефакт и вердикт должны быть В СТРОКЕ разбора, а не в чужом EVIDENCE.
OUT=$(GM_ADV="$ADV" GM_CWD=/tmp/gmr20 GM_TEXTS='["ADVERSARIAL: опровергать нечего, результат очевиден\nСТАТУС: ГОТОВО\nEVIDENCE: bun test → PASS"]' bun -e "$ADV_PROBE" 2>&1)
echo "$OUT" | grep -q '"decisions":\["block"\]' && ok "adv: чужой EVIDENCE не подпирает строку разбора" || bad "adv F1: $OUT"

# Регрессия находки F2: команда в бэктиках внутри строки разбора — это честный отчёт.
OUT=$(GM_ADV="$ADV" GM_CWD=/tmp/gmr20 GM_TEXTS='["ADVERSARIAL: сломал пустым вводом через `gm-harness run s.json` → PASS\nСТАТУС: ГОТОВО"]' bun -e "$ADV_PROBE" 2>&1)
echo "$OUT" | grep -q '"decisions":\[null\]' && ok "adv: бэктики внутри строки не мешают" || bad "adv F2: $OUT"

# Регрессия находки F3: PARTIAL с заявленным результатом тоже требует разбора.
OUT=$(GM_ADV="$ADV" GM_CWD=/tmp/gmr20 GM_TEXTS='["Исправлено два дефекта.\nБЛОКЕР: нет доступа. пробовал: ssh\nСТАТУС: PARTIAL"]' bun -e "$ADV_PROBE" 2>&1)
echo "$OUT" | grep -q '"decisions":\["block"\]' && ok "adv: PARTIAL с результатом требует разбора" || bad "adv F3: $OUT"

OUT=$(GM_ADV="$ADV" GM_CWD=/tmp/gmr20 GM_TEXTS='["ADVERSARIAL: сломал пустым вводом → bun gm-harness run s.json → PASS\nСТАТУС: ГОТОВО\nEVIDENCE: probe → ok","БЛОКЕР: нет доступа. пробовал: ssh, ping → отказ\nСТАТУС: PARTIAL","просто ответ без статуса"]' bun -e "$ADV_PROBE" 2>&1)
echo "$OUT" | grep -q '"decisions":\[null,null,null\]' && ok "adv: полная строка/ PARTIAL / без статуса проходят" || bad "adv: $OUT"

# Вне GRANDMASTER-проекта хук молчит: иначе он вмешивался бы в чужие каталоги.
rm -rf /tmp/gmr24; mkdir -p /tmp/gmr24
OUT=$(GM_ADV="$ADV" GM_CWD=/tmp/gmr24 GM_TEXTS='["СТАТУС: ГОТОВО"]' bun -e "$ADV_PROBE" 2>&1)
echo "$OUT" | grep -q '"decisions":\[null\]' && ok "adv: вне проекта хук молчит" || bad "adv вне проекта: $OUT"
rm -rf /tmp/gmr24

# Формат метки: markdown-префиксы и кириллическая формулировка — это те же честные строки.
OUT=$(GM_ADV="$ADV" GM_CWD=/tmp/gmr20 GM_TEXTS='["**ADVERSARIAL:** сломал → bun x → PASS\nСТАТУС: ГОТОВО","- ADVERSARIAL: сломал → bun x → PASS\nСТАТУС: ГОТОВО","СОСТЯЗАТЕЛЬНАЯ ПРОВЕРКА: сломал пустым вводом → gm-harness → не удалось опровергнуть\nСТАТУС: ГОТОВО"]' bun -e "$ADV_PROBE" 2>&1)
echo "$OUT" | grep -q '"decisions":\[null,null,null\]' && ok "adv: markdown-префиксы и кириллица принимаются" || bad "adv формат: $OUT"

# Последний статус важнее первого: цитата чужого PARTIAL не отменяет финальное ГОТОВО.
OUT=$(GM_ADV="$ADV" GM_CWD=/tmp/gmr20 GM_TEXTS='["Из памяти: СТАТУС: PARTIAL\nВсё сделано.\nСТАТУС: ГОТОВО"]' bun -e "$ADV_PROBE" 2>&1)
echo "$OUT" | grep -q '"decisions":\["block"\]' && ok "adv: разбирается последний статус" || bad "adv статус: $OUT"

# Разные тексты не должны выжигать бюджет блокировок (иначе гейт выключается за 3 попытки).
OUT=$(GM_ADV="$ADV" GM_CWD=/tmp/gmr20 GM_TEXTS='["Финал один\nСТАТУС: ГОТОВО","Финал два\nСТАТУС: ГОТОВО","Финал три\nСТАТУС: ГОТОВО","Финал четыре\nСТАТУС: ГОТОВО"]' bun -e "$ADV_PROBE" 2>&1)
echo "$OUT" | grep -q '"decisions":\["block","block","block","block"\]' && ok "adv: смена текста сбрасывает счётчик дедлока" || bad "adv бюджет: $OUT"

# Антилооп: не больше трёх блоков за сессию, дальше гейт отпускает.
OUT=$(GM_ADV="$ADV" GM_CWD=/tmp/gmr20 GM_TEXTS='["СТАТУС: ГОТОВО","СТАТУС: ГОТОВО","СТАТУС: ГОТОВО","СТАТУС: ГОТОВО"]' bun -e "$ADV_PROBE" 2>&1)
echo "$OUT" | grep -q '"decisions":\["block","block","block",null\]' && ok "adv: блок не больше 3 раз за сессию" || bad "adv: $OUT"

[ -x "$HARNESS" ] && ok "harness: обёртка исполняемая" || bad "harness: нет $HARNESS"
OUT=$("$HARNESS" self-check 2>&1)
echo "$OUT" | grep -q "вакуумная проверка распознаётся" && ok "harness: negative control и вакуум различаются" || bad "harness self-check: $OUT"

OUT=$("$HARNESS" run /home/vincentfox/.omp/agent/harness/scenarios/self.json 2>&1); rc=$?
if [ "$rc" = "0" ] && printf '%s' "$OUT" | grep -q "ok  *fault"; then
  ok "harness: сценарий self.json проходит (positive+negative+fault)"
else
  bad "harness: self.json rc=$rc — $OUT"
fi

# Регрессия находок F5/F7/F10: смысловые дефекты сценария должны отвергаться.
rm -rf /tmp/gmr23; mkdir -p /tmp/gmr23
# Метаданные кейса лежат вне его каталога: команда не может подделать свой отчёт.
cat > /tmp/gmr23/forge.json <<'JSON'
{ "id": "forge", "positive": { "cmd": ["/bin/bash", "-lc", "echo OK >> .gm-harness/stdout.txt; exit 0"], "expectStdout": "OK" },
  "negative": { "cmd": ["/bin/bash", "-lc", "exit 1"], "expectExit": 1 } }
JSON
OUT=$("$HARNESS" run /tmp/gmr23/forge.json 2>&1); rc=$?
printf '%s' "$OUT" | grep -q "в выводе нет подстроки" && [ "$rc" != "0" ] && ok "harness: кейс не подделывает свой stdout" || bad "harness forge: rc=$rc $OUT"

# fixtures — только подкаталог fixtures рядом со сценарием.
cat > /tmp/gmr23/fixtures.json <<'JSON'
{ "id": "fix", "fixtures": "/etc/hostname", "positive": { "cmd": ["/bin/bash", "-lc", "true"] },
  "negative": { "cmd": ["/bin/bash", "-lc", "exit 1"], "expectExit": 1 } }
JSON
OUT=$("$HARNESS" run /tmp/gmr23/fixtures.json 2>&1); rc=$?
printf '%s' "$OUT" | grep -q "разрешён только" && [ "$rc" != "0" ] && ok "harness: fixtures вне песочницы отвергаются" || bad "harness fixtures: rc=$rc $OUT"

# Поток вывода кейса ограничен: «yes» не заливает диск и не ломает harness.
cat > /tmp/gmr23/flood.json <<'JSON'
{ "id": "flood", "positive": { "cmd": ["/bin/bash", "-lc", "yes OK"], "expectStdout": "OK" },
  "negative": { "cmd": ["/bin/bash", "-lc", "exit 1"], "expectExit": 1 } }
JSON
OUT=$("$HARNESS" run /tmp/gmr23/flood.json --timeout 2 2>&1); rc=$?
printf '%s' "$OUT" | grep -q "таймаут" && [ "$rc" != "0" ] && ok "harness: поток вывода ограничен таймаутом" || bad "harness flood: rc=$rc"

cat > /tmp/gmr23/anyexit.json <<'JSON'
{ "id": "anyexit", "positive": { "cmd": ["/bin/bash", "-lc", "true"] },
  "negative": { "cmd": ["/bin/bash", "-lc", "exit 42"] } }
JSON
OUT=$("$HARNESS" run /tmp/gmr23/anyexit.json 2>&1); rc=$?
printf '%s' "$OUT" | grep -q "нет expectExit" && [ "$rc" != "0" ] && ok "harness: контроль без expectExit отвергается" || bad "harness anyexit: rc=$rc $OUT"

cat > /tmp/gmr23/copy.json <<'JSON'
{ "id": "copy", "positive": { "cmd": ["/bin/bash", "-lc", "exit 0"] },
  "negative": { "cmd": ["/bin/bash", "-lc", "exit 0"], "expectExit": 1 } }
JSON
OUT=$("$HARNESS" run /tmp/gmr23/copy.json 2>&1); rc=$?
printf '%s' "$OUT" | grep -q "совпадает с positive" && [ "$rc" != "0" ] && ok "harness: копия positive как контроль отвергается" || bad "harness copy: rc=$rc $OUT"

cat > /tmp/gmr23/efile.json <<'JSON'
{ "id": "efile", "positive": { "cmd": ["/bin/bash", "-lc", "true"], "expectFile": "../../../../etc/hostname" },
  "negative": { "cmd": ["/bin/bash", "-lc", "exit 1"], "expectExit": 1 } }
JSON
OUT=$("$HARNESS" run /tmp/gmr23/efile.json 2>&1); rc=$?
printf '%s' "$OUT" | grep -q "вне каталога кейса" && [ "$rc" != "0" ] && ok "harness: expectFile вне песочницы отвергается" || bad "harness efile: rc=$rc $OUT"

cat > /tmp/gmr23/typo.json <<'JSON'
{ "id": "typo", "positive": { "cmd": ["/nonexistent/binary-xyz"] },
  "negative": { "cmd": ["/bin/bash", "-lc", "exit 1"], "expectExit": 1 } }
JSON
OUT=$("$HARNESS" run /tmp/gmr23/typo.json 2>&1); rc=$?
printf '%s' "$OUT" | grep -q "команда не запускается" && [ "$rc" != "0" ] && ok "harness: опечатка в cmd — FAIL кейса, а не стек" || bad "harness typo: rc=$rc $OUT"

# Песочные переменные должны побеждать env сценария (иначе кейс пишет в реальный HOME).
cat > /tmp/gmr23/home.json <<'JSON'
{ "id": "home", "positive": { "cmd": ["/bin/bash", "-lc", "echo $HOME"], "env": { "HOME": "/home/vincentfox" } },
  "negative": { "cmd": ["/bin/bash", "-lc", "exit 1"], "expectExit": 1 } }
JSON
OUT=$("$HARNESS" run /tmp/gmr23/home.json --keep 2>&1)
KEPT=$(printf '%s' "$OUT" | sed -n 's/^каталог прогона: //p')
if [ -n "$KEPT" ] && grep -q "^$KEPT/home-positive/home$" "$KEPT/home-positive.meta/stdout.txt"; then
  ok "harness: HOME песочницы побеждает env сценария"
else
  bad "harness: env сценария переопределил HOME — $(cat "$KEPT/home-positive.meta/stdout.txt" 2>/dev/null)"
fi
rm -rf "$KEPT"
rm -rf /tmp/gmr23

# Проверка изоляции: кейс пишет в \$HOME — файл должны остаться в песочнице, не в реальном HOME.
rm -rf /tmp/gmr21; mkdir -p /tmp/gmr21
cat > /tmp/gmr21/isolated.json <<'JSON'
{
  "id": "isolated",
  "positive": { "cmd": ["/bin/bash", "-lc", "echo isolated > \"$HOME/marker.txt\"; test -f \"$HOME/marker.txt\""], "expectExit": 0 },
  "negative": { "cmd": ["/bin/bash", "-lc", "exit 3"], "expectExit": 3 }
}
JSON
rm -f "$HOME/marker.txt"
OUT=$("$HARNESS" run /tmp/gmr21/isolated.json 2>&1); rc=$?
check "harness: сценарий в изоляции проходит" $rc
[ -f "$HOME/marker.txt" ] && bad "harness: кейс писал в реальный HOME" || ok "harness: реальный HOME не тронут"

# Сценарий без negative control должен отвергаться: это и есть защита от пустой проверки.
cat > /tmp/gmr21/vacuous.json <<'JSON'
{ "id": "vacuous", "positive": { "cmd": ["/bin/bash", "-lc", "exit 0"], "expectExit": 0 },
  "negative": { "cmd": ["/bin/bash", "-lc", "exit 0"], "expectExit": 0 } }
JSON
OUT=$("$HARNESS" run /tmp/gmr21/vacuous.json 2>&1); rc=$?
echo "$OUT" | grep -q "проверка пустая" && [ "$rc" != "0" ] && ok "harness: пустая проверка отвергается (rc=$rc)" || bad "harness vacuous: rc=$rc $OUT"

# Русский текст: всё, что хуки печатают владельцу, должно быть по-русски. Линтер проверяет
# исходники хуков и harness; negative control — заведомо английская строка, которую он обязан найти.
RU_LINT=/home/vincentfox/.omp/agent/hooks/tests/ru-lint.ts
[ -f "$RU_LINT" ] && ok "ru-lint: линтер на месте" || bad "ru-lint: нет $RU_LINT"
RU_OUT=$(bun "$RU_LINT" 2>&1); rc=$?
RU_FILES=$(printf '%s' "$RU_OUT" | sed -n 's/.*проверено файлов: \([0-9]\+\).*/\1/p')
if [ "$rc" = "0" ] && [ -n "$RU_FILES" ] && [ "$RU_FILES" -ge 5 ]; then
  ok "ru-lint: сообщения хуков и harness по-русски (файлов $RU_FILES)"
else
  bad "ru-lint: rc=$rc, покрытие='${RU_FILES:-нет}' — $RU_OUT"
fi
rm -rf /tmp/gmr22; mkdir -p /tmp/gmr22
# Контроль из трёх стилей, которыми линтер раньше обходили: короткая фраза,
# текст со словом-исключением, сообщение, собранное из кусков.
cat > /tmp/gmr22/en.ts <<'TS'
const a = "Upload failed, please retry";
const b = "Cannot read the reason for failure, please contact support";
const c = "Upload " + "failed, " + "please retry";
TS
bun "$RU_LINT" /tmp/gmr22/en.ts >/dev/null 2>&1
[ $? != "0" ] && ok "ru-lint: три стиля английского текста ловятся" || bad "ru-lint: negative control не пойман"
bun "$RU_LINT" /tmp/gmr22 >/dev/null 2>&1
[ $? = "0" ] && bad "ru-lint: чистая папка без .ts не должна давать PASS" || ok "ru-lint: отсутствие файлов не считается чистотой"
rm -rf /tmp/gmr22

rm -rf /tmp/gmr20 /tmp/gmr21 "$HOME/marker.txt"

echo "=== ИТОГ: PASS=$PASS FAIL=$FAIL ==="
[ "$FAIL" = "0" ]
