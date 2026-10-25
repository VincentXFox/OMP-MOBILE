# OMP Pocket — деплой на мини-ПК

Клиент управления агентами — **OMP Pocket** (лёгкий PWA в этом репозитории): живые сессии OMP через нативный OMP Collab — транскрипт, подтверждения, пуши. Панели терминалов держит собственный демон рантайма (`omp-pocket-runtime`, см. раздел «Рантайм терминалов»), поэтому внешний терминал-менеджер не нужен.

Слой управления агентами — **нативный OMP Collab**: каждая интерактивная сессия OMP публикует E2E-шифрованную комнату (AES-256-GCM, ключ внутри ссылки), gateway по реестру `omp collab list --json` показывает живые сессии и выдаёт ссылки `omp collab link`. Трафик сессий идёт напрямую телефон → релей (`my.omp.sh`, content-blind, сквозное шифрование) — управляющее API OMP наружу не открыто.

## Установка (одноразово)

```bash
# 1. Сборка PWA
cd ~/omp-mobile/app && bun install && bun run build

# 2. Gateway (конфиг/токен/VAPID-ключи создаются при первом старте)
cd ~/omp-mobile/gateway && bun install
systemctl --user enable --now omp-pocket-gateway   # слушает 127.0.0.1:8088

# 3. Рантайм панелей (PTY-панели агентов; юнит лежит в deploy/)
cp ~/omp-mobile/deploy/omp-pocket-runtime.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now omp-pocket-runtime

# 4. Автохостинг всех сессий OMP (каждая новая интерактивная сессия сама публикуется)
omp config set collab.autoStart control

# 5. HTTPS (публичный доступ)
sudo cp ~/omp-mobile/deploy/Caddyfile /etc/caddy/Caddyfile && sudo systemctl reload caddy
# + на роутере пробросить 80 и 443 -> 192.168.1.88 (как существующий :8089)
```

Уже запущенные сессии публикуются командой `/collab` внутри них (один раз); все новые — автоматически (шаг 4).

## Телефон (Android)

1. Открыть `https://pocket.31-77-109-219.sslip.io` (через reverse-туннель на VPS `de5`) → «Добавить на главный экран» (установится как приложение).
2. Настройки → Подключение: вставить токен из `~/omp-mobile/gateway/config.json`.
3. Настройки → Уведомления: включить push (разрешение + подписка).

## Устойчивость связи (не теряется при смене сети)

Связь держат три независимых механизма — обрыв канала на любой стороне лечится сам:

| Слой | Механизм | Файл |
|---|---|---|
| Туннель Thor1 → de5 | `ssh -R` c `ServerAliveInterval=5/CountMax=2` (детект молчаливого обрыва ≤10 с), `ConnectTimeout=8`, `Restart=always`, `RestartSec=3`, **`StartLimitIntervalSec=0`** (юнит не сдаётся никогда) | `deploy/omp-pocket-tunnel.service` |
| Watchdog | раз в 30 с проверяет сквозную доступность gateway через туннель с самого de5 (`GET /api/health`); два провала подряд → `systemctl --user restart omp-pocket-tunnel` | `deploy/tunnel-watchdog.sh`, `omp-pocket-tunnel-watchdog.{service,timer}` |
| Клиент PWA | список адресов-кандидатов + авто-failover, health-check `/api/health`, реакция на `online`/`offline` | `app/src/lib/gateway.ts`, `app/src/app.tsx` |

Почему так: при переключении роутера/Wi-Fi у Thor1 пропадал интернет, ssh-туннель падал, а из-за `StartLimitBurst=5/120s` юнит уходил в `start-limit-hit` — и связь не возвращалась до ручного `systemctl --user reset-failed`. Теперь лимита нет: как только сеть вернулась, туннель поднимается сам (проверено: `kill -9` ssh → публичный путь живой за ~6 с; убитый listener на de5 → watchdog восстановил ≤70 с).

`GET /api/health` отдаётся **без** Bearer-токена (только `{ok:true}`, секретов нет) — иначе внешний watchdog и проверка кандидатов у клиента до ввода токена не работают. Кросс-origin запросы разрешены (CORS: reflect `Origin`, `authorization,content-type`, плюс `Access-Control-Allow-Private-Network` на preflight) — PWA, открытая с публичного домена, может уходить API-запросами на LAN-адрес, когда публичный путь недоступен.

При появлении/смене сети туннель перезапускает NetworkManager-хук `/etc/NetworkManager/dispatcher.d/50-omp-pocket-tunnel` (root:root 0755, антидребезг 10 с) — окно недоступности сокращается до одного реконнекта ssh. Без него связь восстанавливают `ServerAliveInterval` и `Restart=always`.

Клиент в Настройках → Подключение принимает несколько адресов (по одному в строке, порядок = приоритет): пусто = адрес самого приложения; типовой набор — публичный домен (`https://pocket.31-77-109-219.sslip.io`) и LAN (`https://192.168.1.4:8443` или `https://thor1.local:8443`). Активный адрес переключается на первый живой автоматически; при нескольких адресах POST-запросы уходят только на активный (перебор дал бы дубль задачи).

LAN-кандидат требует доверия к локальному CA на устройстве: сертификат `leaf.crt` подписан `OMP Pocket Local CA` (тот же `certs/ca.crt`, отдаётся как `https://pocket.31-77-109-219.sslip.io/pocket-root-ca.crt`) и покрывает `192.168.1.4`, `192.168.1.18`, `thor1.local`, `localhost`, `127.0.0.1`. IP Thor1 приходит по DHCP и уже менялся (`.18` → `.4`): после смены адреса SAN перевыпускается (`certs/*.bak-*` — старые копии), иначе LAN-вход отдаёт ошибку сертификата. Без доверия к CA браузер отклоняет LAN-адрес до всякого CORS. Свежие Chrome дополнительно спрашивают разрешение на доступ к локальной сети.

## Безопасность

- `/api/*` закрыты Bearer-токеном (`gateway/config.json`); статика и SW — без секретов.
- Ссылка на сессию = ключ шифрования: full-control ссылка выдаётся только после токен-авторизации, наружу не пишется.
- Push-уведомления не содержат текста агента — только факт события («Требуется разрешение», «Агент завершил»).

## Режим подтверждений (важно)

Сейчас глобально стоит `tools.approvalMode: yolo` — OMP выполняет всё без вопросов, и в приложении не будет запросов «Разрешить/Отклонить». Рекомендуемый профиль для управления с телефона:

```bash
omp config set tools.approvalMode write   # правки файлов — сами, bash/exec — с подтверждением
```

(`always-ask` — спрашивать и про правки файлов; `yolo` — никогда не спрашивать.)

## LAN без домена (fallback)

Сервис-воркер и WebCrypto требуют HTTPS. Без домена: `mkcert -install && mkcert 192.168.1.88`, затем в Caddyfile `tls /path/192.168.1.88.pem /path/192.168.1.88-key.pem`, корневой CA mkcert установить на телефоне. Либо пользоваться VPN (WireGuard) + вариант с доменом.

## Компоненты

| Путь | Что |
|---|---|
| `~/omp-mobile/app` | PWA (React+Bun, форк официального клиента omp collab-web, протокол не изменён) |
| `~/omp-mobile/gateway` | API реестра + выдача ссылок + Web Push + статика |
| `~/.config/systemd/user/omp-pocket-gateway.service` | user-юнит gateway |
| `~/.config/systemd/user/omp-pocket-tunnel.service` | user-юнит reverse-SSH-туннеля: терминатор — de5 (`de5:8088` → gateway `127.0.0.1:8088`), соединение идёт через шлюз `srv78` (`ProxyCommand ssh -W 127.0.0.1:2222 srv78`, в нём тоже `BatchMode`/`ConnectTimeout=8`/keepalive); публичный адрес `https://pocket.31-77-109-219.sslip.io`; самовосстанавливающийся, без start-limit |
| `~/.config/systemd/user/omp-pocket-tunnel-watchdog.{service,timer}` + `deploy/tunnel-watchdog.sh` | watchdog туннеля: раз в 30 с проба `GET /api/health` через de5, два провала → рестарт юнита |
| `~/.config/systemd/user/omp-pocket-organizer.{service,timer}` + `bin/organizer.ts` | штат агентов: раз в сутки (04:00, `Persistent=true`) раскладывает агентов по папкам `~/OMP/<slug>` и фиксирует ответственности; модель — `OMP_POCKET_ORGANIZER_MODEL` или `--model`, без модели действует «один агент = один стол» |
| `~/OMP/` | сами столы: `AGENTS.md` (устав стола, omp читает его как правила проекта), `JOURNAL.md`, `CREW.md` — индекс «кто за что отвечает» |
| `/etc/NetworkManager/dispatcher.d/50-omp-pocket-tunnel` | NM-хук: при появлении/смене сети мгновенно `try-restart` туннеля (антидребезг 10 с), источник — `deploy/50-omp-pocket-tunnel` |
| `~/.config/systemd/user/omp-pocket-runtime.service` | user-юнит рантайма панелей (PTY + эмуляция экрана): демон `gateway/runtime/main.ts`, сокет `$XDG_RUNTIME_DIR/omp-pocket-runtime.sock`, состояние в `~/.local/state/omp-pocket/runtime` |
| `/etc/caddy/Caddyfile` | TLS-фронт (системный юнит `caddy`) |
| `~/tools/gigaam-data` | STT-сервис GigaAM2-RNNT (распознавание голосовых) |

## Голосовой ввод (STT)

Голосовое из приложения уходит на `POST /api/stt` шлюза (Bearer-токен); шлюз конвертирует
webm → wav (ffmpeg) и распознаёт GigaAM2-RNNT (Sber) на `127.0.0.1:9110`, при отказе —
whisper.cpp на `127.0.0.1:9100` (медленнее и хуже на русском). С 2026-10-16 основной STT
живёт на DE5 (4 vCPU VPS, ~2 ГБ с mmap модели): Thor1 ходит к нему через user-юнит
`gigaam-tunnel.service` (`ssh -L 127.0.0.1:9110:127.0.0.1:9110 de5`), локальная копия
сервиса на Thor1 осталась ручным фолбэком и конфликтует с туннелем по порту.
Шлюз о переезде не знает — он всегда ходит в `127.0.0.1:9110`. Установка, патч
`weights_only=False` под torch≥2.6, переключение и замеры — `~/tools/gigaam-data/README.md`.

## Systemd-юниты и linger

Стек держат четыре user-юнита (gateway, туннель, рантайм панелей, релей) плюс системный Caddy — итого 5 юнитов. Плюс суточный таймер штата (не сервис: сработал и погас):

```bash
systemctl --user is-enabled omp-pocket-gateway omp-pocket-tunnel omp-pocket-runtime # все: enabled
systemctl --user is-enabled omp-pocket-organizer.timer                                # enabled = enabled
cp ~/omp-mobile/deploy/omp-pocket-organizer.service ~/omp-mobile/deploy/omp-pocket-organizer.timer ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now omp-pocket-organizer.timer
systemctl --user start omp-pocket-organizer.service   # прогон прямо сейчас, вывод — в journalctl
```

Чтобы user-юниты стартовали при загрузке (пока пользователь не вошёл в сессию), обязателен linger:

```bash
loginctl show-user vincentfox -p Linger   # должно быть Linger=yes
sudo loginctl enable-linger vincentfox    # если no
```

После правки любых `*.service` в `~/.config/systemd/user/` — `systemctl --user daemon-reload`; проверка корректности: `systemd-analyze --user verify omp-pocket-gateway.service omp-pocket-tunnel.service omp-pocket-runtime.service omp-pocket-organizer.service`.

## Скилы: внешние библиотеки (anthropics/skills + mattpocock/skills)

omp читает скилы как `<каталог>/<имя>/SKILL.md` (frontmatter `name` + `description`) и умеет брать их из любых каталогов через `skills.customDirectories`. Оба публичных набора подключены так, чтобы репозитории оставались чистыми клонами и обновлялись `git pull`:

```bash
~/skills/anthropic-skills                      # github.com/anthropics/skills  → customDirectories: ~/skills/anthropic-skills/skills
~/skills/mattpocock-skills/skills/{engineering,productivity,misc}   # github.com/mattpocock/skills (по категориям)
```

`deprecated` и `in-progress` у mattpocock не подключены: автор сам помечает их как устаревшие/нестабильные. Обновление и проверка:

```bash
bash ~/omp-mobile/deploy/skills-sync.sh          # git pull + перезапись skills.customDirectories + сводка
bash ~/omp-mobile/deploy/skills-sync.sh --check  # только проверка (каталоги на месте, git чистый)
omp skill list --json | jq '.skills | length'    # сколько скилов видит omp (сейчас 50)
```

Сейчас подключено **50 скилов** (anthropic: 19, mattpocock engineering: 20, productivity: 7, misc: 4). Это видно в каждой сессии — в том числе у агентов, запущенных из PWA, потому что настройка пользовательская, а не проектная. Цена: каталог «имя + описание» занимает ~14.7 КБ (≈3.7k токенов) системного промпта каждой сессии. Если нужно ужать — точечно выключать ненужное:

```bash
omp config set skills.ignoredSkills '["academy-guide","brand-guidelines","slack-gif-creator"]'
omp config set skillful false    # полностью убрать список из промпта (скилы останутся, но модель о них не знает)
```

Свой скил (повторяемая процедура, а не факт) кладётся в `~/.omp/agent/managed-skills/<имя>/SKILL.md` — omp подхватит его как обычный скил в следующей сессии и не тронет чужие.

## Библиотека системных промптов AI-инструментов

Второй (после скилов) внешний источник: публичный репозиторий [x1xhlol/system-prompts-and-models-of-ai-tools](https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools) (GPL-3.0) — 111 файлов по 31 инструменту: Cursor, Windsurf, Devin, v0, Claude Code, Xcode, Poke, Manus, Comet и т.д. Это **не скилы** (не процедуры), а уставы: чужой системный промпт годится и как образец, и как готовый характер агента.

```bash
git clone --depth 1 https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools.git ~/prompts/ai-tools-prompts
git -C ~/prompts/ai-tools-prompts pull        # обновление
```

Шлюз читает только локальный клон (никаких сетевых вызовов на поиск): `GET /api/prompts?q=&tool=` — поиск по названию и по тексту с отрывком совпадения, `GET /api/prompts/<id>` — полный файл (до 200 КБ). Индекс — 60 с TTL, поэтому свежий `git pull` виден почти сразу.

В приложении — чип **«Промпты»** в шапке хаба: поиск, фильтр по инструменту, превью, и две кнопки на выбранном файле — «Стол по промпту» (заводит стол `~/OMP/<slug>`, пишет промпт уставом в `AGENTS.md` и стартует там агента) и «Копировать». Устав из библиотеки переживает суточную синхронизацию штата: он лежит в ручной части `AGENTS.md`, которую `syncAllCharters` не затирает, а источник записан в реестре (`charterSource`). Ограничение запроса — 200 КБ на устав; в интерфейсе размер файла показан до запуска, потому что устав попадает в системный промпт каждого хода (самый большой файл, `Claude Fable 5`, — 120 КБ ≈ 30k токенов).

## Разбор чужого omp-дампа: что взяли, что отвергли

Присланный `omp-llm-request-*.json` (машина gwushor, провайдер cheaperinference) — это дамп запроса omp: системный промпт (41 КБ), правила проекта (5.8 КБ), 16 инструментов и 125 сообщений. Полезное из него:

| Взяли | Куда |
|---|---|
| «узкие вопросы — скриптом, не агентом» + правило «локальная модель возвращает текст, файл пишет тот, кто может проверить» | `RULES.md`, `bin/local-ask.ts`, урок в `harness/LESSONS.md` |
| «язык ответа — часть контракта»: язык не меняется по ходу ответа, ответ не на языке пользователя — ошибка, переписать целиком | `RULES.md` |
| антидубликаты в слое скилов (`update` вместо `create`, один скилл на тему) | уже закрыто autoharness + нашими правилами |

| Отвергли | Почему |
|---|---|
| `/megacave` (文言文) | противоречит нашему правилу «никаких CJK в текстах для пользователя» |
| локальный решатель/ризонер как агент | у них измерено 4 мин 34 с и галлюцинации вызовов; скриптом — 11 с. У нас так же: `omp -p` 125 с против 2.25 с у `local-ask` |
| Obsidian-vault как источник фактов | у них это `/home/gwushor/vault`; у нас эту роль играют Mnemopi, `~/OMP` и поиск по сессиям |
| их стиль «human-voice» для писем | частная редактура под их рынок вакансий, с нашими правилами тона конфликтует |

Проверка `local-ask` (локальный сервер, без агента):

```bash
bun bin/local-ask.ts "Сколько будет 17*23? Ответь одним числом."     # → 391, ~2.3 с
echo "<контекст>" | bin/local-ask.ts --stdin "выдели факты" --json
```

## Autoharness: самопополняемый слой скилов (Claude-плагин + адаптер под omp)

[tigerless-labs/autoharness](https://github.com/tigerless-labs/autoharness) (MIT, Python 3.11+, нулевые зависимости) учится **скилам** прямо из реальных сессий: рефлектор читает сырой транскрипт эпизода, сравнивает с существующей библиотекой и **только предлагает** изменения (MCP-инструмент `stage_skill`); отдельный детерминированный промоутер валидирует и пишет файлы, а слой жизненного цикла архивирует неиспользуемое. Ставится как плагин Claude Code, но ядро — обычный Python.

```bash
cd ~/tools/autoharness && uv run --with pytest pytest -q     # 627 passed, 1 skipped
```

**Адаптер под omp** (`~/tools/autoharness-omp/`), потому что хост у нас не Claude Code:

| Часть | Что делает |
|---|---|
| `claude` (shim в PATH) | плагин запускает рефлектора командой `claude -p --agent reflector`, бандл эпизода приходит в stdin — shim переводит это в `omp -p`, роль задаёт `agents/reflector.md` через `--append-system-prompt`, модель — `AUTOHARNESS_SHIM_MODEL` (по умолчанию flash) |
| `~/.omp/agent/mcp.json` | регистрирует `autoharness_stage_skill` (stdio: `python3 -m autoharness.stage_skill.server`, `PYTHONPATH=~/tools/autoharness/src`) — единственный канал записи рефлектора |
| `run-episode.py <session.jsonl> [N]` | играет роль хоста: шлёт `PreToolUse` ×N (счётчик активности) и `Stop` с путём к транскрипту; dispatch плагина сам решает, запускать ли рефлексию (`AUTOHARNESS_REFLECT_EVERY_N`, по умолчанию 50) |

```bash
export PATH=$HOME/tools/autoharness-omp:$PATH
export PYTHONPATH=$HOME/tools/autoharness/src
export AUTOHARNESS_REFLECT_EVERY_N=3 AUTOHARNESS_PROJECT_ROOT=$HOME/omp-mobile
python3 ~/tools/autoharness-omp/run-episode.py ~/.omp/agent/sessions/-/<сессия>.jsonl 3
```

**Расписание.** `deploy/autoharness-run.sh` берёт сессии, изменённые за сутки, и кормит их порциями (до трёх, `AUTOHARNESS_REFLECT_EVERY_N=40`), под `flock` от параллельного прогона; юнит `omp-autoharness.timer` — ежедневно в 05:00, после рефлексии уроков. Проверка без запуска: `deploy/autoharness-run.sh --check` печатает выбранные сессии. Лог: `~/.claude/autoharness/omp-run.log`.

Почему это отдельно от библиотеки уроков Harness²: уроки правят **промпт и правила** (`RULES.md`), autoharness правит **слой скилов** (`~/.claude/skills` проекта или глобально) — и делает это сам, с валидацией на своей стороне. Вместе они покрывают два разных компонента гарнесса.

## Harness²: библиотека уроков гарнесса

Установлен фреймворк рекурсивного улучшения гарнесса — [google-research/harness2](https://github.com/google-research/harness2) (Apache-2.0): он держит два уровня рекурсии, не трогая веса модели — правки гарнесса под текущую задачу (Propose–Probe–Compose) и накопление **уроков с доказательствами** между задачами.

```bash
cd ~/tools/harness2 && . .venv/bin/activate
harness2-demo --output runs/demo --k 2     # локальное демо, без ключей: 2 задачи, 28 исполнений, 32 правки
```

Что взяли в нашу систему (первого уровня — правил и хуков — не хватало именно второго):

| Что | Где |
|---|---|
| Карта восьми компонентов гарнесса (system prompt · guardrails · memory · tool guidance · subagents · skills · scripts · plugins) и что у нас играет каждую роль | `~/.omp/agent/harness/COMPONENTS.md` |
| Библиотека уроков в формате Harness² (`cue → lesson → evidence → confidence`) | `~/.omp/agent/harness/LESSONS.md` |
| Ежедневная рефлексия: факты из сессий за сутки (срабатывания стоп-гейта, отказы todo-first, loop-breaker, падения инструментов, статусы, итоги автономных задач) → уроки | `bin/harness-reflect.ts`, таймер `omp-harness-reflect.timer` (04:30) |
| Принятые правки: топ-8 уроков (high + свежие medium) попадают ограниченным блоком в `RULES.md` | `~/.omp/agent/RULES.md`, маркеры `<!-- harness:lessons -->` |

```bash
cd ~/omp-mobile && bun bin/harness-reflect.ts status
bun bin/harness-reflect.ts run --dry-run --hours 24   # диджест и промпт, без вызова модели
bun bin/harness-reflect.ts run                        # реальный прогон (flash)
```

Правила отбора, чтобы библиотека не разрослась в мусор: урок без факта из диджеста отбрасывается; дубликаты не добавляются; в промпт попадает только топ (high всегда, medium — если свежий, low — только в библиотеке, никогда в промпт); блок в `RULES.md` перезаписывается целиком, остальной текст правил не трогается.

Отличие от Mnemopi: память хранит, что было; библиотека уроков хранит, **что менять в гарнессе** и на каком наблюдении это основано.

## Автономные задачи (серверный цикл)

Пользователь ставит цель один раз — дальше шлюз сам гоняет агента, проверяет результат
и останавливается по делу. Телефон только наблюдает: закрытие приложения ничего не
останавливает, потому что задача живёт в шлюзе (`gateway/tasks/<id>.json`).

```bash
# поставить задачу (критерии пишутся ДО первого действия и модель их не меняет)
curl -s -X POST -H "authorization: Bearer <token>" -H 'content-type: application/json' \
  -d '{"goal":"Создай hello.txt с текстом ok","cwd":"/home/vincentfox/task-live",
       "model":"deepseek/deepseek-v4-flash",
       "criteria":[{"id":"c1","statement":"файл содержит ok","check":{"command":"grep -qx ok hello.txt"}}],
       "budget":{"maxTokens":200000,"reserveTokens":20000}}' \
  http://127.0.0.1:8088/api/tasks

curl -s -H "authorization: Bearer <token>" http://127.0.0.1:8088/api/tasks | jq .
# пауза/продолжить/отмена/разрешение
curl -s -X POST -H "authorization: Bearer <token>" -H 'content-type: application/json' \
  -d '{"decision":"allow"}' http://127.0.0.1:8088/api/tasks/<id>/approval
```

Что важно знать:

- Агент запускается как отдельный `omp --mode rpc-ui --approval-mode always-ask` в
  каталоге задачи: `write`/`exec` требуют разрешения. Пока решения нет — задача в
  `awaiting_approval`, в «Рое» видно заголовок и детали действия.
- Успех — только `done`, и только после зелёного **полного** прогона проверок.
  Остальные остановки честные: `blocked`, `budget_exhausted`, `no_progress`, `paused`,
  `cancelled`, `failed`.
- Прогресс считается закрытыми критериями, а не числом сообщений. После 3 ходов без
  прогресса промпт требует сменить стратегию, после 2 новых неудачных — `no_progress`.
- Токены/деньги — из `get_session_stats` самого omp (`tokens.*`, `cost`); резерв
  бюджета нельзя потратить до финальной приёмки.
- Рестарт шлюза: `resumeAfterRestart()` поднимает незавершённые задачи; ход, который
  мог уйти в модель в момент падения (`pendingAction`), **не повторяется** — задача
  встаёт в `blocked` с причиной «исход неизвестен».
- Транскрипт открывается мгновенно даже у тяжёлых сессий: `GET /api/sessions/tail?path=|id=&limit=` читает хвост
  локально (50–130 мс вместо мегабайт через публичный релей) и приложение рисует его, пока коллаб-гость
  догружает полный снапшот. До этого открытие 9-МБ сессии на мобильном канале не показывало вообще ничего.
- Архитектура, статусы, параметры и ограничения — `gateway/autonomy/README.md`;
  тесты: `cd ~/omp-mobile/gateway && bun test autonomy/tests` (28 проверок).

## Штат агентов (папки и ответственности)

Агенты больше не сваливаются в домашний каталог: у каждого свой стол `~/OMP/<slug>` с уставом `AGENTS.md`, а `~/OMP/CREW.md` — индекс «кто за что отвечает». Раскладку раз в сутки делает организатор (модель решает, какой стол за что отвечает; применение — детерминированный код, модель не двигает чужие файлы). Ручная проверка без изменений и разовый прогон:

```bash
cd ~/omp-mobile && bun bin/organizer.ts status
bun bin/organizer.ts run --dry-run          # только план, ничего не создаёт
bun bin/organizer.ts run --model deepseek/deepseek-v4-flash
curl -s -H "authorization: Bearer <token>" http://127.0.0.1:8088/api/crew | jq .organizer
```

## Рантайм терминалов (`omp-pocket-runtime`)

Панели агентов держит собственный демон рантайма — `gateway/runtime/main.ts` под user-юнитом `omp-pocket-runtime.service`. Он создаёт PTY-панели, эмулирует экран (`@xterm/headless`), хранит привязку панели к сессии и переживает рестарт шлюза: обновление PWA или правка кода агентов не убивают.

```bash
systemctl --user status omp-pocket-runtime    # что с демоном
systemctl --user restart omp-pocket-runtime   # перезапуск: незакрытые панели поднимутся сами
journalctl --user -u omp-pocket-runtime -f    # лог демона
```

- Состояние: `~/.local/state/omp-pocket/runtime/panes.json` — панели, их привязки и `desiredRunning`. Файл durable: после рестарта демон поднимает незакрытые панели тем же `--restore`/`--resume`, а закрытые не воскрешает (`desiredRunning=false`).
- Сокет: `$XDG_RUNTIME_DIR/omp-pocket-runtime.sock`; переопределяется `OMP_RUNTIME_SOCKET`, каталог состояния — `OMP_RUNTIME_STATE_DIR` (обе заданы и в юните).
- Проверка здоровья — тот же health, что спрашивает шлюз и апдейтер:

```bash
printf '{"id":"1","method":"health","params":{}}\n' | nc -U "$XDG_RUNTIME_DIR/omp-pocket-runtime.sock"
# {"id":"1","ok":true,"result":{"version":1,"generation":"…","pid":1234,"ready":true,"panes":3,"restoreIssues":[]}}
```

`ready:false` или непустой `restoreIssues` — панели ещё поднимаются либо часть из них не вернулась; подробности: `journalctl --user -u omp-pocket-runtime`.

Центр обновлений перезапускает рантайм компонентом «Рантайм (терминалы)»: панели гасятся, юнит рестартует, панели поднимаются заново и проверяются по живым процессам.

Подтверждения: приложение показывает вопросы агентов (Approve/Deny). Чтобы они появлялись, режим OMP не должен быть `yolo`:
`omp config set tools.approvalMode write` (bash/exec — спрашивает, правки файлов — нет).

## Перенос агентов из старых панелей

Агенты, поднятые до перехода на рантайм, живут в панелях прежнего менеджера: в списке
приложения они видны, но терминал, смена модели и раздача задач для них недоступны
(шлюз отвечает «агент не управляется панелью шлюза»), а центр обновлений считает их
отдельно и не перезапускает.

```bash
bun bin/migrate-to-runtime.ts list                      # кто ещё вне панелей рантайма
bun bin/migrate-to-runtime.ts run --session <id>        # перенести одного
bun bin/migrate-to-runtime.ts run --cwd ~/OMP/<стол>    # перенести агента стола
bun bin/migrate-to-runtime.ts run --dry-run --force     # показать, что будет сделано со всеми
```

Перенос поднимает сессию в панели рантайма (`--restore <файл сессии>`, для сессии,
ждущей подтверждения, — `--resume`) и гасит прежний процесс только после того, как
новая панель зарегистрировалась под тем же `sessionId`. Текущий ход агента при этом
прерывается — переносите, когда агент не в середине важной работы.

## Супер-агент (раздача задач)

Экран «Супер» (`#/super`) в PWA: одна задача уходит выбранным агентам, доска показывает живой статус каждого и его субагентов.

- Источники статусов: панели рантайма (`gateway/panes.ts`: заголовок и статус панели) + `omp collab list` (сессия, busy, relay) + субагенты из `<sessions>/<cwd>/<ts>_<sessionId>/<Имя>.jsonl` (хвост транскрипта = текущий инструмент/текст).
- Раздача: текст уходит в панель агента через рантайм (литеральный ввод + Enter), ответы подтверждаются хвостом терминала (`agent_prompt_stalled` → проверка доставки). Blocked-агенту задача не отправляется.
- API: `GET /api/super/board`, `POST /api/super/dispatch` (`{items:[{target,text}]}`, ≤12 × 64KB), `GET /api/super/agent/<pane>/activity`. Файлы: `gateway/super.ts`, `app/src/components/super/`.

## Центр обновлений (внутри OMP Pocket)

Вкладка «Обновления» в PWA: проверка версий **OMP** (build-сервис omp: пин версии, проверка размера и SHA-256 перед установкой), **Gateway** и **Фронтенд** (этот git-репозиторий: pull + build + рестарт systemd-юнита), **Рантайм** (перезапуск панелей), **Релей**. Перед каждым обновлением — автоматический бэкап конфигов в `~/.local/state/omp-pocket/updates/<job>` (вне репозитория: там токены), есть откат к предыдущей версии. Обновление OMP блокируется, пока хоть один агент занят (`busy`), либо требует явного подтверждения. О новых версиях приходит push (проверка раз в 6 ч).

Чтобы обновления кода Gateway/Фронта работали, добавьте remote: `git -C ~/omp-mobile remote add origin <url>`.

