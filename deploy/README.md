# OMP Pocket — деплой на мини-ПК

Мобильный центр управления OMP-агентами: PWA (~/omp-mobile/app) + Bun-gateway (~/omp-mobile/gateway) + Caddy (TLS).

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

1. Открыть `https://vincentfox.ru` → «Добавить на главный экран» (установится как приложение).
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
| `/etc/caddy/Caddyfile` | TLS-фронт |
