#!/usr/bin/env bash
# skills-sync — обновление внешних библиотек скилов и пересборка их списка для omp.
#
# Источники (читаются omp как skills.customDirectories, репозитории остаются
# чистыми клонами — их можно обновлять, не трогая ничего внутри):
#   ~/skills/anthropic-skills                       github.com/anthropics/skills
#   ~/skills/mattpocock-skills                      github.com/mattpocock/skills
#
# omp ищет скилы как <каталог>/<имя>/SKILL.md (frontmatter: name, description),
# поэтому у mattpocock каталоги идут по категориям: engineering/productivity/misc.
# deprecated и in-progress автором помечены как нестабильные/устаревшие — не берём.
#
# Запуск: deploy/skills-sync.sh [--check]
#   --check — только проверить, что каталоги на месте и git чистый, без pull.
set -euo pipefail

ROOT="${SKILLS_ROOT:-$HOME/skills}"
OMP="${OMP_BIN:-$HOME/.local/bin/omp}"
CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

REPOS=(
  "https://github.com/anthropics/skills.git anthropic-skills"
  "https://github.com/mattpocock/skills.git mattpocock-skills"
)

# Каталоги, которые реально видит omp (порядок = порядок в конфиге).
DIRS=(
  "$ROOT/anthropic-skills/skills"
  "$ROOT/mattpocock-skills/skills/engineering"
  "$ROOT/mattpocock-skills/skills/productivity"
  "$ROOT/mattpocock-skills/skills/misc"
)

mkdir -p "$ROOT"

for entry in "${REPOS[@]}"; do
  read -r url dir <<<"$entry"
  target="$ROOT/$dir"
  if [ -d "$target/.git" ]; then
    if [ "$CHECK_ONLY" = 0 ]; then
      echo "обновляю $dir"
      git -C "$target" pull --ff-only --quiet
    fi
  else
    echo "клонирую $dir"
    git clone --depth 1 --quiet "$url" "$target"
  fi
done

# Скилы могли переехать в другую категорию: молча потерять половину хуже,
# чем упасть и показать, чего не хватает.
missing=0
for dir in "${DIRS[@]}"; do
  if ! compgen -G "$dir/*/SKILL.md" >/dev/null; then
    echo "нет скилов в $dir — каталог переименован или скилы переехали" >&2
    missing=1
  fi
done
if [ "$missing" = 1 ]; then
  exit 1
fi

json=$(printf '%s\n' "${DIRS[@]}" | python3 -c 'import json,sys; print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))')
if [ "$CHECK_ONLY" = 0 ]; then
  "$OMP" config set skills.customDirectories "$json" >/dev/null
  echo "skills.customDirectories = $json"
fi

"$OMP" skill list --json | python3 -c '
import json,sys
d=json.load(sys.stdin).get("skills",[])
by_source={}
for s in d:
    base=s.get("baseDir") or ""
    if "mattpocock-skills" in base:
        tail=base.split("mattpocock-skills/skills/",1)[-1]
        src="mattpocock:"+(tail.split("/")[0] if "/" in tail else "-")
    elif "anthropic-skills" in base:
        src="anthropic"
    else:
        src="прочее"
    by_source[src]=by_source.get(src,0)+1
print("скилов:",len(d),"|",", ".join(f"{k}:{v}" for k,v in sorted(by_source.items())))
b=sum(len(s.get("name",""))+len(s.get("description","")) for s in d)
print(f"место в системном промпте: ~{b} байт ≈ {b//4} токенов")
'
