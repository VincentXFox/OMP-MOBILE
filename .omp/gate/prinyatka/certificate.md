# Сертификат приёмки

Задача: Автономная доказательная приёмка: движок + сертификат + стоп-гейт
Риск: high
Статус: ГОТОВО

```text
CONTRACT: AC-01 движок проходит свои тесты, включая найденные ревьюером дыры; AC-02 хук отвергает подложенный и чужой сертификат; AC-03 регрессия хуков зелёная
BASELINE: git HEAD = 200f7da, git изменений = 20, снято = 2026-10-26T23:13:22.521Z, юниты до = omp-pocket-gateway=active, omp-pocket-runtime=active, omp-local-relay=active
EVIDENCE [тесты движка]: bun test bin/quality-gate.test.ts → код 0 за 6671 мс
EVIDENCE [юнит-контракты хуков]: cd /home/vincentfox/.omp/agent && bun test GRANDMASTER_8/tests/gm8.test.ts → код 0 за 105 мс
EVIDENCE [регрессия хуков]: bash /home/vincentfox/.omp/agent/hooks/tests/gm-regression.sh | tail -1 → код 0 за 135490 мс
REGRESSION: тесты движка → PASS; юнит-контракты хуков → PASS; регрессия хуков → PASS
INVARIANTS: секреты не в диффе → соблюдён (строк 1284, файлов 8, совпадений 0); в проверках нет необратимых git-команд → соблюдён (проверено объявленных команд: 3)
OBSERVABILITY: юниты после = omp-pocket-gateway=active, omp-pocket-runtime=active, omp-local-relay=active; git после = 200f7da
ROLLBACK: git 200f7da → откат рабочего дерева, PLANNED (не проверялся)
INDEPENDENT REVIEW: reviewer → PASS (независимый ревьюer GateReview2, 4 прохода: закрыты обходы через self/автор/subagent:self, подложенный сертификат, удалённые reviews[], мёртвую свежесть, logFile-каталог; тесты 21 и 29 зелёные)
RESIDUAL: в охвате выполненных проверок дефектов не найдено
СЕРТИФИКАТ: .omp/gate/prinyatka/certificate.json · статус ГОТОВО
```
