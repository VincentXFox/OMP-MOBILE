# Установленные скилы OMP (внешние источники)

| Скил | Источник | Лицензия | Куда поставлен | Как проверить |
|---|---|---|---|---|
| `unslop` | github.com/heydamir/unslop (Damir Sokolovsky) | CC-BY-4.0 | `~/skills/unslop/unslop`, каталог в `skills.customDirectories` | `omp skill list \| grep unslop`, `skill://unslop` |
| `quality-gate`, `autonomy`, `adversarial-review`, `gm-harness` | собственные | — | `~/skills/grandmaster` | те же |
| EGM (7 скилов + персоны) | `~/skills/egm` | Apache-2.0 | `~/skills/egm/skills` | `omp skill list` |

## Скрипты unslop в OMP

Playwright целиком не ставится: хватает `playwright-core` (лежит в `~/skills/unslop/node_modules`), браузер берётся системный.

```bash
cd ~/skills/unslop
CHROME_PATH=/usr/bin/google-chrome bun unslop/scripts/snapshot.mjs <url> unslop/original.html before --width=390 --height=844
CHROME_PATH=/usr/bin/google-chrome bun unslop/scripts/story.mjs unslop-story/story.html unslop-story.mp4   # нужен ffmpeg, он есть
```

Проверка до/после — нашим движком: `bun ~/omp-mobile/bin/visual-gate.ts run --auto` (снимки экранов и деталей, разбор vision-моделью и геометрией, код 1 при дефектах).

Атрибуция и текст лицензии лежат рядом со скилом: `~/skills/unslop/LICENSE`, `CITATION.cff`, `README.md`.
