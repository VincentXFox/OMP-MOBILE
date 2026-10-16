# @oh-my-pi/collab-web

Web client for [omp collab sessions](../../docs/collab.md). Paste a `/collab` link into the browser and you get the same live session guests see in the TUI: streaming transcript, tool-call cards, subagent panel with live transcripts, and a composer that prompts (or interrupts) the host agent.

## Quick start

```sh
# dev server (Bun HTML dev server with HMR) — http://localhost:3000
bun run dev

# offline demo: local relay + scripted mock host; prints a ws://localhost link
bun run mock-host
```

Host a session from any omp instance (`/collab`, or `/collab ws://localhost:7466` to use the mock relay), then paste the printed link into the connect screen. Deep links work too: `http://localhost:3000/#<roomId>.<key>` auto-connects on load.

## Build & deploy

```sh
bun run build   # static site in dist/
```

`dist/` is a fully static SPA — host it anywhere. JS/CSS bundles are content-hashed; favicons, `manifest.webmanifest`, `robots.txt`, `sitemap.xml`, and `og-image.png` come from `public/` and are emitted at the site root under stable names (canonical URL: `https://my.omp.sh/`). Two runtime requirements:

- **Secure context**: room keys are unwrapped with WebCrypto (`crypto.subtle`), which browsers expose only on `https://` or `localhost`.
- **Relay reachability**: the client connects straight to the relay over WebSocket (`wss://` for anything that isn't localhost). The default relay is `wss://my.omp.sh`; bare `<roomId>.<key>` links resolve against it (legacy `<roomId>#<key>` and `%23`-mangled links still parse).

The room key never leaves the URL fragment — it is not sent to the relay or any server.

## Architecture

- `src/lib/` — vendored wire codec (`codec.ts` AES-256-GCM, `link.ts` envelope + link grammar), `socket.ts` reconnecting relay socket, `client.ts` guest session store (`GuestClient` + immutable snapshots for `useSyncExternalStore`). Shared protocol shapes come from `@oh-my-pi/pi-wire`.
- `src/components/` — `transcript/` (entries, markdown, tool cards), `agents/` (panel + transcript drawer), `shell/` (connect screen, header, composer, banners, toasts).
- `src/tool-render/` — per-tool React renderers shared with coding-agent HTML session exports: one view per built-in tool, common `ToolView` chrome, theme-adaptive `tv-` design tokens, and an `<omp-tool-view>` web-component wrapper. The `ToolRenderHost` seam lets hosts wire agent-id chips to a sub-session view (drawer here, overlay in exports).
- `scripts/` — `local-relay.ts` (content-blind relay on `Bun.serve`), `mock-host.ts` + `fixture.ts` (scripted host for offline dev), `build-tool-views.ts` (bundles `src/tool-render/` + React into `packages/coding-agent/src/export/html/tool-views.generated.js` for self-contained exports).

The package is intentionally standalone — no dependency on `@oh-my-pi/pi-coding-agent` at runtime or type level. Wire-shape drift is prevented by consuming the same `@oh-my-pi/pi-wire` contracts as the host, with sealed-frame interop still covered by `test/codec.test.ts`.

## Дизайн v2 (2026-10-13)

Редизайн по Apple HIG + Material 3: нижняя навигация из 5 вкладок с M3-индикатором (super/sessions/updates доступны из хедера Агентов, Настроек и Проектов), сессия addressable через `#/session/<instanceId>` с восстановлением после F5, keep-alive для Памяти/Настроек. Дизайн-токены: `src/styles/tokens.css` (шкалы `--sp-*`, z-шкала `--z-*`, контрастные `--fg-secondary/--fg-tertiary` ≥4.5:1 в обеих темах), примитивы `.pk-btn/.pk-chip/.pk-card/.pk-sheet/.pk-toast/.pk-empty/.pk-skeleton` и общий `shell/ConfirmSheet` для всех опасных операций. Список работ: `local://omp-pocket-audit.md`, контракт: `local://omp-pocket-design.md`.

## Автоворестор, имена, туду (2026-10-14)

**Восстановление после сбоя питания.** Шлюз на каждом опросе реестра пишeт `gateway/runtime-manifest.json` (какие omp-сессии должны жить: sessionId, cwd, модель, имя). При старте шлюза `gateway/restore.ts` ждёт реестр и поднимает каждую жертву через `omp --restore` (доделывает прерванный ход и перезапускает субагентов), затем добирает осиротевшие herdr-панели (omp-агенты без живого хоста — свежайший `interrupted/aborted`-файл их cwd). Старые instanceId маппятся на новые (`restore-remap.json`, маршрут `/api/sessions/remap`). Приложение: упавший чат сам ищет хост с тем же sessionId и переоткрывается; устаревший `#/session/<id>` проходит ремап в `openInstance`.

**Имена.** Пользовательская кириллица переживает всё: `POST /api/sessions/rename` и rename агента пишут официальный 256-байтовый title-слот omp (in-place, `source:"user"`, + audit-строка `title_change`) и хранят имя в `gateway/agent-names.json` по стабильному sessionId. `HostInfo.displayName` идёт с шлюза; herdr-слаг остаётся служебным (`[a-z0-9_-]`). Без title имя сессии = первый пользовательский запрос (preview), не UUID.

**Список сессий.** Показывается дата создания (из имени файла) + свежая активность; форки/сиблинги (`parentSession` в header) помечены чипом «продолжение»; `прерван/прерван при сбое` поднимается кнопкой «Поднять с доделкой» (`--restore`), остальные — обычный resume.

**Туду всегда перед глазами.** `lib/todo-board.ts` достаёт последний `todo`-результат из транскрипта (details.phases), `TodoBar` липнет над композером: N/M, прогресс, текущая фаза, тап — полный борд.

## Супер-раздача по плану + CLI-мост (2026-10-14)

**Режимы раздачи в «Супер-агенте».** Переключатель «Всем одинаково / По плану»: прежний broadcast без изменений; в режиме «По плану» каждый выбранный агент получает свою карточку с задачей (черновики per-agent переживают снятие выбора и переключение режима). Валидация до POST: непустой текст у каждого выбранного (подсказка с именами), ≤12 агентов, ≤64 КиБ на текст (лимиты gateway). Отправка — снапшот текстов; после результатов очищаются только успешно отправленные и неизменённые за время полёта. Любая правка компоуза (текст/режим/выбор) сбрасывает показ результатов — подсказки валидации не глушатся старым ✓/✗.

**CLI для OMP-сессий.** `bin/super-dispatch.ts` — супер-чат сам читает доску и раздаёт задачи воркерам, не выходя из своей сессии: `board` (таблица target/имя/статус/модель/cwd, read-only), `send <target> <файл|->` (одна задача, текст из файла/stdin через JSON, pre-check 64 КиБ), `activity <target>` (статус, хвост терминала, субагенты). Конфиг — `gateway/config.json` (`SUPER_GATEWAY_CONFIG` перекрывает), токен не печатается никогда. Exit-коды: 0 ок, 1 ошибка API/агента, 2 нет конфига, 3 шлюз недоступен, 4 401, 5 плохой ввод. Пример: `bun bin/super-dispatch.ts send w1:p1 task-algol.md`.

## Выбор модели и живое подключение (2026-10-16)

**Модель теперь выбирается, а не набирается.** `GET /api/models` (шлюз, каталог `omp models ls --json` с кэшем 10 мин и stale-on-error) кормит общий лист `shell/ModelPickerSheet`: поиск по провайдеру/id/имени, группировка по провайдеру, контекст и уровни усилия в строке. «Новый агент» открывает его по кнопке «Модель» (последний выбор запоминается в `localStorage`, пункт «По умолчанию» = модель из настроек omp), чат — по тапу на чип модели в композере и строкой «Сменить модель и усилие» в «Об агенте».

**Смена модели живого чата — клавишами в TUI агента** (`GET/POST /api/agents/<id>/settings`). Прежняя реализация собирала `/model <селектор>` одним залпом и отправляла это сообщением в чат: `/model` открывает интерактивный пикер, поэтому текст уходил агенту как промпт («Unknown model» не наступал, модель не менялась). Теперь шлюз ведёт диалог по шагам и сверяет экран панели после каждого: `/` → `model` → пикер открыт → поиск полного селектора → `Enter` (полоса ролей `… → [ default ] …`) → `Enter` (роль) → `Enter` (уровень усилия) → `Esc` до закрытия пикера. Каждый шаг подтверждается фрагментом чужого экрана, поэтому при расхождении возвращается ошибка, а не молча испорченный чат.

**Уровень усилия** — отдельный флоу `/effort`: стрелками до нужной подсветки, `Enter`. Текущее значение читается из статус-строки панели: omp v18.10.4 печатает глиф перед моделью (`⦸ off · ⟳ auto · ◔ low · ◒ high · ◉ max`); прежний парсер ждал «Thinking set to …» из старых версий и всегда возвращал null. Глиф-маппинг снят вживую.

**Esc не шлётся вслепую.** В чистом композере omp `Esc` — это rewind сессии, а под работающим агентом — прерывание хода. Поэтому: смена настроек запрещена, пока агент занят или ждёт подтверждения (и в API, и в UI), меню закрываются по состоянию экрана, остатки ввода убираются backspace'ами.

**Возврат в приложение.** `visibilitychange`/`online`/`pageshow` → `GuestClient.reconnectNow()` (сброс backoff сокета, новый сокет за ~300 мс, свежий welcome со снапшотом; дубли пары событий гасятся троттлингом). Поллинг `/api/hosts` останавливается в скрытой вкладке и обновляется сразу при возврате — телефон не жжёт батарею в фоне. В баннере «Переподключение…» есть кнопка «Сейчас». Фаза `live` теперь пишется «На связи» (прежнее «Работает…» врало у простаивающего агента), а карточка агента в момент открытия показывает «Открываю…» — тап больше не выглядит потерянным.

## Хаб агентов: секции, поиск, закрепление (2026-10-16)

**Почему.** Два десятка сессий лежали одним списком: имена проектов обрезались до «vincen…», сортировка шла по статусу — работающий агент прыгал наверх при каждом изменении хода («агенты перемешиваются»), «21 ч назад» стояло у всех одинаково, поиска и фильтра не было. Плюс четыре сессии вообще были безымянными: реестр `omp collab list` даёт имя только на момент старта и ничего не знает о сессиях без herdr-панели.

**Секции вместо мешка** (`components/agents/AgentsScreen.tsx`): «Закреплённые» → «Ждут ответа» → «Работают» → «На паузе» → «Черновики и эксперименты» (`/tmp`, свёрнуты) → «Спят и без связи» (нет процесса/релея). Внутри секции сортировка по последнему открытию (карта `sessionId → ts` в `localStorage`, `lib/agent-prefs.ts`), а не по статусу: список больше не перетасовывается, а агент, которому нужно действие, не прячется под свёрнутой секцией. Свёрнутость секций помнится; при активном поиске всё раскрывается.

**Поиск и закрепление.** Полоса поиска (имя/путь/модель/имя сессии) липнет под шапкой, сверху — сводка «N агентов · M работают · K ждут ответа». Звезда на карточке закрепляет агента наверху; и закрепление, и «недавние» хранятся по `sessionId` — это переживает перезапуск сессии, сбой питания и remap `instanceId` в шлюзе.

**Карточка.** Имя в две строки, кромка цвета проекта (палитра по алфавиту папок — одинаковый цвет = один проект, столкновений у двух разных папок нет), абсолютное время запуска («вчера 22:52» вместо «21 ч назад»), шильдики «черновик» и «+2 субагента» (из доски «Роя»), «Работает 1 ч 6 мин».

**Имена — одно правило на весь интерфейс** (`lib/agent-name.ts`): переименование пользователя → заголовок сессии → первый запрос → имя из реестра → короткий `sessionId`. Шлюз отдаёт `sessionTitle` (256-байтный title-слот omp из файла сессии, включая переименования из TUI) и `sessionPreview` (первый запрос); чтение заголовка кэшируется по `(путь, mtime, size)`, поэтому 5-секундный опрос реестра не перечитывает по 64 КБ на агента. Этим же правилом пользуется шапка сессии и табличка переименования — раньше после тапа карточка называлась «Почини растдекс», а сессия «vincentfox».

**Парсер превью** (`gateway/sessions.ts`) теперь понимает и `custom_message` с `attribution: "user"` («collab-prompt»): запрос, отправленный из приложения, приходит не `message`, а этим типом, из-за чего начатая с телефона сессия оставалась безымянной. Пустой title-слот («») трактуется как «имени нет» и в списке сессий: показывается первый запрос, а не UUID.

## Поиск по словам во всех сессиях (2026-10-16)

**Зачем.** «Я помню, что про Cudy писал» — а найти это можно было только глазами по списку из 141 сессии. Теперь у поля в хабе два режима: «Агенты» (по имени/проекту/модели, как раньше) и «В переписке» — полнотекстовый поиск по репликам **всех** сессий, включая мёртвые, которых в реестре уже нет.

**Индекс в шлюзе, без базы** (`gateway/session-search.ts`). Файлы сессий занимают 165 МБ, но осмысленного текста в них ~2 МБ: остальное — записи вызовов инструментов и их результаты. Поэтому в индекс идут только реплики (пользователя и ответы агента, без `thinking` и тул-вызовов), и он целиком живёт в памяти Bun-процесса: полный проход корпуса — **0.7–1.3 с**, прогрев при старте шлюза (`[search] индекс сессий: 141 сессий, 8403 реплик за 729 мс`). Обновление инкрементальное по `(mtime, size)`: перечитываются только изменённые файлы, ответ — за 1–30 мс. Строки-кандидаты отбираются подстрокой (`"type":"message"`, `custom_message` + `attribution:user`) **до** `JSON.parse` — вызовы инструментов, которых большинство в файле, не разбираются вовсе. Транскрипты субагентов не индексируются: их «пользовательские» реплики — это задания родительского агента, а не слова человека.

**Два уровня совпадения.** Сильный: все слова запроса в одной реплике («Cudy роутер» рядом) — такие результаты идут первыми и называются «слова рядом». Слабый: слова нашлись в разных репликах одной сессии («где я вообще про это писал»), показывается «слова в разных репликах»; в слабый попадают только сессии, где встретились **все** слова — иначе это шум. Сравнение — подстрока без регистра (`norm` в нижнем регистре, потому что SQLite-free LIKE по кириллице регистр не гасит), поэтому падеж и порядок слов не мешают.

**Что видно и куда идти.** Карточка результата: имя сессии, проект, число совпавших реплик, время последнего совпадения, до трёх отрывков с подсветкой (`<mark>` по смещению, которое отдал шлюз: индексы берутся из нормализованного текста, а вырезается оригинал — регистр автора сохраняется) и роль реплики («я» / «агент»). Переключатель «только мои сообщения» (по умолчанию) против «всё, что говорили». Тап по карточке: сессия живая — открывается чат; мёртвая или вовсе не в реестре — шит возобновления (в него передаётся синтетический хост: `cwd` + путь к файлу сессии, `mode: resume` — без доделки прерванного хода).

**Доопрашивание индекса.** `status.pendingFiles` в ответе говорит, сколько файлов ещё не прочитано (первый холодный запрос при незавершённом прогреве): пока он больше нуля, клиент повторяет запрос каждые 1.5 с и пишет «дочитываю N файлов», иначе пользователь принял бы неполный результат за «ничего не найдено».
