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
