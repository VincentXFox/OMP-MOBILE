
## Внешние хранилища сессий (2026-10-24)

Шлюз сканировал только `~/.omp/agent/sessions/<slug>/`. Мост Telegram
(`~/.tgbot/tg2omp.py`) запускает omp с `--session-dir ~/.tgbot/sessions`, поэтому
переписка с ботом жила только в Telegram.

`sessions.ts` получил `EXTRA_SESSION_DIRS` (сейчас — `~/.tgbot/sessions`) и
`extraSessionDirs()`: список сессий, `findSessionFile` и `tailEntries` теперь
видят и плоские `*.jsonl` из внешних каталогов (в листинге они идут под
`projectSlug: external:sessions`), а полнотекстовый поиск (`session-search.ts`)
индексирует их наравне с корнем omp.
