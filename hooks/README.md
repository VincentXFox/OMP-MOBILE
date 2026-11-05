# Грандмастер 10.0 — версионированная копия

Живая копия устанавливается в каталог агента (`~/.omp/agent/hooks` у владельца,
`/var/lib/omp-exec/.omp/agent/hooks` у исполнителя). Здесь — та же версия для истории
и независимой проверки.

- `pre/` — хуки: `grandmaster-stop-gate`, `grandmaster-todo-first`, `grandmaster-loop-breaker`,
  `grandmaster-goldfish`, `grandmaster-adversarial-review`, `you-should-know`, `no-cjk-guard` и др.
- `lib/` — общие модули: `version.ts` (версия 10.0), `task-state.ts` (устойчивое состояние задачи),
  `trusted-verification.ts` (свидетельство приёмки), `gate-state.ts`, `lock.ts`, `evidence.ts`, `status.ts`.
- `bin/` — отдельный runner наблюдателя.
- `tests/` — приёмка, негативные пробы, состояние задачи, замок, регрессия хуков, ru-lint.

Проверки: `bun test hooks/tests/acceptance.test.ts`, `bun test hooks/tests/task-state.test.ts`,
`bash hooks/tests/gm-regression.sh`, `bun hooks/tests/ru-lint.ts`.
