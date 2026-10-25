# EVIDENCE
2026-10-17T03:05Z | `kill -9` ssh-процесса туннеля | публичный `https://pocket.…/api/health` 502 → 200 за 6.3 с, NRestarts=1 | PASS
2026-10-17T03:11Z | убитый listener 8088 на de5 (ssh жив) | watchdog: «проба 000 (провал 1/2)» → «провал 2/2» → «туннель мёртв — перезапущен» (03:10:27 → 03:11:04) | PASS
2026-10-17T03:17Z | blackhole-маршрут до de5 (имитация смены сети) | во время обрыва unit `activating`, не failed; после снятия маршрута публичный путь 200 за 10 с без вмешательства | PASS
2026-10-17T03:09Z | gateway `/api/health` без токена | 200 `{ok:true}` локально и через публичный домен; preflight 204 с `access-control-allow-origin/headers/methods/private-network` | PASS
2026-10-17T03:12Z | NM dispatcher (ручной вызов wlp2s0 up) | MainPID туннеля сменился, публичный путь 200 | PASS
2026-10-17T03:13Z | клиент: настройки «Подключение» (browser) | пробы: `https://192.168.1.199:8443` = «нет», публичный = «жив», активный = публичный | PASS
2026-10-17T03:14Z | клиент: failover (браузер, 2 кандидата) | `gwActive`=мёртвый → через 9 с `gwActive`=публичный, список 26 агентов отрисован | PASS
2026-10-17T03:14Z | клиент: офлайн-индикатор (браузер emulate offline) | шапка «Нет сети» + кнопка «Повторить»; после online — индикатор исчез | PASS
2026-10-17T03:15Z | сборка клиента | `bun run check` (tsgo) без ошибок, `bun run build` → dist/vabw2d0t.js + tnj60z16.css (03:12) | PASS
2026-10-17T03:16Z | LAN-кандидат в браузере с публичного origin | `fetch https://192.168.1.18:8443` = Failed to fetch (ERR_CERT_AUTHORITY_INVALID до CORS) | ЧАСТИЧНО (нужен доверенный CA на устройстве)
2026-10-25T04:20Z | `bun test gateway/runtime/tests` | 7 pass / 0 fail: PTY-панель, литеральный ввод не выполняет команду, resize, порядок seq подписки, отказ на битый и гигантский кадр, durable-закрытие и восстановление без дублей, отказ на незнакомый argv | PASS
2026-10-25T04:20Z | `bun test gateway/recovery/tests gateway/runtime/tests` | 26 pass / 0 fail | PASS
2026-10-25T04:55Z | `bun test gateway/update/chaos` | 32 pass / 0 fail за 206 с: chaos играет настоящий демон `gateway/runtime/main.ts`, рестарт рантайма поднимает панели (сценарий 29) | PASS
2026-10-25T04:39Z | рестарт юнитов на живом стенде (`systemctl --user restart omp-pocket-runtime omp-pocket-gateway`) | шлюз active/NRestarts=0, `/api/health` 200, публичный `/api/health` 200, 39 агентов живы | PASS
2026-10-25T04:44Z | `/api/update/status` на живом стенде | компоненты: omp 18.12.6, gateway f9ef9f6, frontend f9ef9f6, relay «слушает 7466», `runtime | Рантайм (терминалы) | отвечает | ok` (herdr в списке нет) | PASS
2026-10-25T04:32Z | сборка PWA (`bun run build`) + `bun run check` + `bun test` в `app/` | check чисто, 20 pass / 0 fail, в `app/dist` нет строк herdr | PASS
2026-10-25T05:40Z | `cd gateway && bun test` | 114 pass / 0 fail (11 файлов, 232 с), включая chaos 32/32 с настоящим демоном рантайма | PASS
2026-10-25T05:45Z | `cd app && bun run check && bun test` | check чисто, 20 pass / 0 fail; dist пересобран, herdr в бандле нет | PASS
2026-10-25T05:50Z | `acceptance.sh` (живой прогон на тестовом порту и сокете) | 20/20 PASS: старт агента в панели, терминал text+ansi, ввод доходит, живой ход + привязка файла сессии, рестарт рантайма посреди хода → та же сессия через `--restore` + продолжение турна, рестарт шлюза не трогает агента (pid оболочки тот же), остановка агента, herdr-юниты живы | PASS
2026-10-25T05:55Z | прогон ANSI-снимка через парсер приложения | 1642 байта → 13 строк, 68 отрезков, 47 со стилем (цвета баннера omp) | PASS
2026-10-25T05:55Z | состязательный разбор (независимый субагент) | 15 находок; после исправлений повторные прогоны тестов и приёмки зелёные | НАЙДЕНО 15 → исправлено 13
2026-10-25T06:10Z | перенос агента из старой панели в рантайм (фикстура в /tmp, `bin/migrate-to-runtime.ts run --session …`) | сессия осталась той же (`01a17109…`), процесс сменился 172234 → 175824, прежний погашен, панель рантайма привязана (instanceId `4d315b26…`), терминал читается — 4/4 PASS | PASS
2026-10-25T06:15Z | `bin/migrate-to-runtime.ts list` на живом стенде | показал 39 живых агентов вне панелей рантайма (sessionId, cwd, pid, файл сессии, состояние турна, argv) | PASS
