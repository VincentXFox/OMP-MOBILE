# OMP Pocket — деплой на мини-ПК

Два независимых клиента управления агентами:

1. **Herdr Mobile** (основной, готовое решение) — агенты живут в Herdr, телефон через herdr-mobile-relay. См. раздел «Herdr» ниже.
2. **OMP Pocket** (собственный лёгкий PWA, этот репозиторий) — управление любыми интерактивными сессиями OMP через нативный OMP Collab: живой транскрипт, подтверждения, пуши. Слои не конфликтуют и работают параллельно.

Слой управления агентами — **нативный OMP Collab**: каждая интерактивная сессия OMP публикует E2E-шифрованную комнату (AES-256-GCM, ключ внутри ссылки), gateway по реестру `omp collab list --json` показывает живые сессии и выдаёт ссылки `omp collab link`. Трафик сессий идёт напрямую телефон → релей (`my.omp.sh`, content-blind, сквозное шифрование) — управляющее API OMP наружу не открыто.

## Установка (одноразово)

```bash
# 1. Сборка PWA
cd ~/omp-mobile/app && bun install && bun run build

# 2. Gateway (конфиг/токен/VAPID-ключи создаются при первом старте)
cd ~/omp-mobile/gateway && bun install
systemctl --user enable --now omp-pocket-gateway   # слушает 127.0.0.1:8088

# 3. Автохостинг всех сессий OMP (каждая новая интерактивная сессия сама публикуется)
omp config set collab.autoStart control

# 4. HTTPS (публичный доступ)
sudo cp ~/omp-mobile/deploy/Caddyfile /etc/caddy/Caddyfile && sudo systemctl reload caddy
# + на роутере пробросить 80 и 443 -> 192.168.1.88 (как существующий :8089)
```

Уже запущенные сессии публикуются командой `/collab` внутри них (один раз); все новые — автоматически (шаг 3).

## Телефон (Android)

1. Открыть `https://pocket.31-77-109-219.sslip.io` (через reverse-туннель на VPS `de5`) → «Добавить на главный экран» (установится как приложение).
2. Настройки → Подключение: вставить токен из `~/omp-mobile/gateway/config.json`.
3. Настройки → Уведомления: включить push (разрешение + подписка).

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
| `~/.config/systemd/user/omp-pocket-tunnel.service` | user-юнит reverse-SSH-туннеля: `de5:8088` → gateway `127.0.0.1:8088` (публичный адрес `https://pocket.31-77-109-219.sslip.io`) |
| `~/.config/systemd/user/herdr-mobile-relay.service` | user-юнит фонового сервиса релея (env: `~/.config/herdr/plugins/config/herdr-mobile-relay.events/relay.env`) |
| `/etc/caddy/Caddyfile` | TLS-фронт (системный юнит `caddy`) |

## Systemd-юниты и linger

Стек держат три user-юнита плюс системный Caddy — итого 4 юнита:

```bash
systemctl --user is-enabled omp-pocket-gateway omp-pocket-tunnel herdr-mobile-relay   # все: enabled
```

Чтобы user-юниты стартовали при загрузке (пока пользователь не вошёл в сессию), обязателен linger:

```bash
loginctl show-user vincentfox -p Linger   # должно быть Linger=yes
sudo loginctl enable-linger vincentfox    # если no
```

После правки любых `*.service` в `~/.config/systemd/user/` — `systemctl --user daemon-reload`; проверка корректности: `systemd-analyze --user verify omp-pocket-gateway.service omp-pocket-tunnel.service herdr-mobile-relay.service`.

## Herdr + herdr-mobile-relay (основной мобильный клиент)

Установлено: Herdr 0.9.3 (`~/.local/bin/herdr`), плагин herdr-mobile-relay 0.22.9, интеграция omp.

```bash
herdr                      # запустить рантайм (терминал-менеджер); агенты живут в его панелях
herdr agent start <имя> --kind omp --pane <PANE_ID>   # агент OMP внутри herdr
```

Setup-меню релея (QR/транспорт/сервис):

```bash
herdr plugin pane open --plugin herdr-mobile-relay.events --entrypoint setup --placement zoomed --focus
```

Постоянный транспорт (временный trycloudflare умирает при перезапуске) — выбрать в setup-меню:
- **Stable Tunnel** (постоянный hostname, нужен домен на Cloudflare), или
- **Deploy Your Own WebRTC Gateway** на VPS (рекомендуется: свой сервер уже есть), или
- origin приложения на `vincentfox.ru`: Caddy уже стоит; отдать `~/.local/share/herdr-mobile-relay/releases/*/web` (SPA требует корень хоста) + проброс 443.

Фоновый сервис релея (переживает перезапуск): пункт `install-service` в setup-меню.

Подтверждения: приложение показывает вопросы агентов (Approve/Deny). Чтобы они появлялись, режим OMP не должен быть `yolo`:
`omp config set tools.approvalMode write` (bash/exec — спрашивает, правки файлов — нет).

## Супер-агент (раздача задач)

Экран «Супер» (`#/super`) в PWA: одна задача уходит выбранным агентам, доска показывает живой статус каждого и его субагентов.

- Источники статусов: `herdr agent list` (статус/заголовок терминала агента) + `omp collab list` (сессия, busy, relay) + субагенты из `<sessions>/<cwd>/<ts>_<sessionId>/<Имя>.jsonl` (хвост транскрипта = текущий инструмент/текст).
- Раздача: `herdr agent prompt <pane> <текст> --wait --until working`; ультабыстрые ответы подтверждаются хвостом терминала (`agent_prompt_stalled` → проверка доставки). Blocked-агенту задача не отправляется.
- API: `GET /api/super/board`, `POST /api/super/dispatch` (`{items:[{target,text}]}`, ≤12 × 64KB), `GET /api/super/agent/<pane>/activity`. Файлы: `gateway/super.ts`, `app/src/components/super/`.

## Центр обновлений (внутри OMP Pocket)

Вкладка «Обновления» в PWA: проверка версий **OMP** (официальный установщик omp.sh, пин версии, SHA-256), **Gateway** и **Фронтенд** (этот git-репозиторий: pull + build + рестарт systemd-юнита). Перед каждым обновлением — автоматический бэкап конфигов в `~/omp-mobile/backups/`, есть откат к предыдущей версии. Обновление OMP блокируется, пока хоть один агент занят (`busy`), либо требует явного подтверждения. О новых версиях приходит push (проверка раз в 6 ч).

Чтобы обновления кода Gateway/Фронта работали, добавьте remote: `git -C ~/omp-mobile remote add origin <url>`.

