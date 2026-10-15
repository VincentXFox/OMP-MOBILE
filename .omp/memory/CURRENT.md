# CURRENT
## USER GOAL
Polish OMP Pocket agents-list UI: readable titles, status accents, contrast (user-requested long-task test).

## Acceptance criteria
- Titles wrap to 2 lines instead of single-line ellipsis.
- Running card visibly accented (edge + tint); completed cards dimmed but readable.
- Meta line higher contrast; denser cards.
- Built dist served by gateway; live screenshots before/after taken.

## Current phase
DONE (r12 polish shipped; monitor on phone)
VERIFY

## Verified completed steps
- Recon: stack React19+Bun, gateway serves app/dist on 8088, public via de5 Caddy.
- agents.css polish appended (r12 block).

## Unfinished work
- bun run build + browser re-shot + click-through (settings/transcript).
