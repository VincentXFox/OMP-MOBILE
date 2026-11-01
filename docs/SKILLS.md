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

## Доработки unslop для OMP

- **Шаг 0 «Разведка платформы»** (`unslop/references/platforms.md`): определить платформу по файлам, найти точку расширения, зафиксировать `PLATFORM / EXTENSION POINT / ASSET PIPELINE / CACHE RESET`. Есть отдельный разбор Frappe/ERPNext: `apps/<custom_app>/hooks.py` (`app_include_css`, `web_include_css`, `website_context`), DocType `Website Theme`, фикстуры, `bench build` + `bench --site <site> clear-cache`; ядро `apps/frappe` не трогается.
- **Светлая и тёмная тема** (`unslop/references/themes.md`): семантические токены вместо hex, отдельное значение акцента на тему, контраст 4.5:1 в обеих, тени только на светлой, проверка обеих тем в браузере.
- `visual-gate` умеет снимать обе темы: `--schemes dark,light` (эмуляция `prefers-color-scheme`), имена снимков содержат тему.
