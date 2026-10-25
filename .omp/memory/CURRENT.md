# CURRENT
## USER GOAL
Избавиться от HERDR в OMP Pocket, не потеряв функционал: агенты, терминал (чтение и ввод),
перезапуск и восстановление сессий, обновление компонентов, доска задач — всё должно работать
на собственном рантайме панелей шлюза.

## Acceptance criteria
- В коде шлюза нет обращений к CLI herdr: панели держит собственный демон `gateway/runtime/`
  (юнит `omp-pocket-runtime.service`, unix-сокет, durable `panes.json`).
- Идентичность панели — запись состояния (`sessionId`/`instanceId`/`sessionFile`/`launchArgv`),
  а не догадка по cwd; при неоднозначности операция отменяется.
- Рестарт ШЛЮЗА не убивает агентов; рестарт РАНТАЙМА поднимает панели и возвращает агентов
  (`--restore`, для панели с ожидающим подтверждением — `--resume`), продолжение турна
  отправляется ровно один раз по метке `restoredAt`.
- Публичный API шлюза не изменился: приложение работает без переписывания раскладки.
- Компонент обновлений `herdr` заменён на `runtime`; chaos-набор зелёный.
- `herdr-server` и `herdr-mobile-relay` остановлены и disabled (19:02 2026-10-25): второй
  мобильный клиент выведен, панели ведёт только рантайм шлюза.

## Current phase
ЗАКРЫТО 2026-10-25. Herdr в OMP Pocket больше нет: панели ведёт только `omp-pocket-runtime.service`
(42 панели = 42 живых агента, legacy не осталось), `herdr-server` и `herdr-mobile-relay`
остановлены и disabled в 19:02.

## Verified completed steps
- Ядро рантайма: `gateway/runtime/{protocol,keys,process,screen,store,server,client,main}.ts`;
  тесты `gateway/runtime/tests/runtime.test.ts` (7 шт) — PTY, UTF-8 через границу буфера,
  bracketed paste, resize, порядок кадров подписки, отказ на битый кадр, восстановление
  без дублей, отказ на незнакомый argv.
- Адаптер шлюза: `gateway/panes.ts` (единственная точка «шлюз → панели»).
- Перевод потребителей: `agents.ts`, `files.ts`, `names.ts`, `super.ts`, `restore.ts`,
  `recovery/*` (включая новый `runtimeControl.ts` и вотчер `runtimeWatch.ts`),
  `update/*` (компонент `runtime`), `main.ts` (коды `agent_not_managed`, вотчер восстановления).
- Приложение: `app/src` без herdr-терминологии, ошибка «агент не управляется панелью» приходит
  кодом, компонент обновлений `runtime`; `bun run check` чисто, 20 тестов зелёные, dist собран.

## Unfinished work
Нет. Осталось на диске (не влияет на работу, удаление — отдельным решением): пакет
`~/.local/bin/herdr` (30 МиБ), `~/.config/herdr` (45 МиБ, история панелей), плагин
`~/.local/share/herdr-mobile-relay` (24 МиБ), два disabled-юнита в `~/.config/systemd/user/`.
