# TASKS
| ID | Step | Status | Evidence | Next action |
|---|---|---|---|---|
| U1 | Аудит системы обновлений (read-only) | VERIFIED | `docs/UPDATE_AUDIT.md`: путь кнопка→202→установка→verify, RC1–RC7, D1–D28 | - |
| U2 | Автономный оркестратор (systemd-run, durable state, журнал, lock) | VERIFIED | `gateway/update/orchestrator.ts`, `jobState.ts`, `journal.ts`, `lock.ts`; тесты `update/tests/*` (38) | - |
| U3 | Preflight: диск, зависимости, источник, совместимость | VERIFIED | `preflight.ts`; chaos 8/9/10 PASS | - |
| U4 | Установка OMP по size+SHA-256 с сохранением предыдущего бинаря | VERIFIED | `release.ts`; chaos 7 (подмена SHA → отказ, бинарь цел) | - |
| U5 | Перезапуск компонентов и проверка работающих версий | VERIFIED | `/proc/<pid>/exe`, `/api/health` pid+buildSha, отдаваемый index.html; chaos 1/22/26 | - |
| U6 | Автоматический откат + гейт watchdog | VERIFIED | chaos 18/19, 23 (ROLLED_BACK); `~/watchdog/pocket-watchdog.sh` читает ACTIVE | - |
| U7 | Восстановление сессий: чекпоинт, классификация турна, безопасное продолжение | VERIFIED | `gateway/recovery/{checkpoint,classify,resume,afterRestore}.ts`; chaos 3/4/17/25 | - |
| U8 | Журнал событий с seq + SSE/replay | VERIFIED | `journal.ts`, `/api/update/events`; chaos 5/16 | - |
| U9 | Chaos-набор (26 сценариев) | VERIFIED | `gateway/update/chaos/scenarios.test.ts`; `docs/UPDATE_CHAOS_REPORT.md` | - |
| U10 | Деплой нового движка на живой стенд | VERIFIED | `systemctl --user restart omp-pocket-gateway`; `/api/health` отдаёт `buildSha=f9ef9f6`, `/api/update/status` — 5 компонентов | - |
| U11 | Живая приёмка через PWA + продолжение реальной задачи | VERIFIED | демо-задача `step1 → sleep 90 → step2`: job `live-accept-4` = `restored=1, resumed=1`, `step2.txt=TWO`, транскрипт 12→44 строк; UI-прогон релея `relay-1792884681336` = 0/0 из 36 | - |
| U12 | Дефекты, найденные живыми прогонами (L1–L5) | VERIFIED | `docs/UPDATE_ACCEPTANCE.md`: `--continue` в argv, ранняя проверка регистрации, «восстановление» чужих сессий, парсер `systemctl show`, готовность herdr | - |

## Программа «изъятие herdr» (2026-10-25)

| ID | Step | Status | Evidence | Next action |
|---|---|---|---|---|
| H1 | Свой рантайм панелей: PTY, экран (@xterm/headless), durable `panes.json`, unix-сокет | VERIFIED | `gateway/runtime/{protocol,keys,process,screen,store,server,client,main}.ts`; `bun test gateway/runtime/tests` — 7/7 (разрезанный UTF-8, bracketed paste, resize, порядок кадров, отказ на битый кадр, восстановление без дублей, отказ на незнакомый argv) | - |
| H2 | Единый адаптер «шлюз → панели» | VERIFIED | `gateway/panes.ts`; `tsgo -p gateway/tsconfig.json --noEmit` — чисто | - |
| H3 | Перевод потребителей: agents, files, names, super, restore, recovery, main | VERIFIED | `grep -rn herdr gateway --include=*.ts` — только комментарии о замене в `gateway/runtime/*` и `panes.ts`; тесты `gateway/recovery/tests` + `runtime/tests` — 26/26 | - |
| H4 | Движок обновлений: компонент `runtime` вместо `herdr` | VERIFIED | живой `/api/update/status`: `runtime \| Рантайм (терминалы) \| отвечает \| ok`; chaos 32/32 | - |
| H5 | Chaos-набор играет настоящий демон рантайма | VERIFIED | `bun test update/chaos` — 32 pass / 0 fail (206 с); сценарий 29: рестарт рантайма поднимает панели | - |
| H6 | Приложение: коды ошибок, компонент `runtime`, без herdr-текстов | VERIFIED | `bun run check` чисто; `bun test` в `app/` — 20/20; `grep -r herdr app/src` пусто; dist пересобран, в `app/dist` herdr нет | - |
| H7 | Деплой: юнит рантайма + перезапуск шлюза на живом стенде | VERIFIED | `systemctl --user is-enabled omp-pocket-runtime` → enabled, active; `/api/health` 200 локально и публично; 39 агентов в реестре | - |
| H8 | Живая приёмка полного пути (старт → терминал → ввод → рестарт рантайма посреди хода → рестарт шлюза → остановка) | VERIFIED | `~/OMP/herdr-remove/acceptance.sh` — 20/20 PASS; лог рантайма: «агент поднят (pid …)», «восстановлена (сессия …)» | - |
| H9 | Состязательный разбор независимым агентом + исправления | VERIFIED | `HerdrRemovalReview` — 15 находок; исправлено 13 (жизненный цикл панели, argv, lock, гонка продолжения, чужой агент в панели, раздача в мёртвую панель, legacy-сессии в апдейтере, привязка, источник снимка, статус «завершено», чистка состояния); 2 оставлены осознанно (setsid-потомок, класс «живое состояние в git») | - |
