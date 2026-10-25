/**
 * Запуск рантайма: `bun gateway/runtime/main.ts` (юнит `omp-pocket-runtime.service`).
 *
 * Демон живёт вне шлюза намеренно: рестарт шлюза (обновление PWA, правка кода)
 * не должен убивать агентов, а рестарт рантайма не должен терять их сессии —
 * панели поднимаются из `panes.json` тем же `--restore`/`--resume`.
 */

import { runtimeSocketPath, runtimeStateDir } from "./protocol.ts";
import { startRuntime } from "./server.ts";

const runtime = await startRuntime({
  socketPath: runtimeSocketPath(),
  stateDir: runtimeStateDir(),
  onRestored: (pane) => {
    console.log(`[runtime] панель ${pane.id} восстановлена (сессия ${pane.sessionFile ?? "нет"})`);
  },
});

console.log(`[runtime] сокет ${runtime.socketPath}, поколение ${runtime.generation}, панелей ${runtime.panes().length}`);
await runtime.ready;
console.log(`[runtime] готов; панелей ${runtime.panes().length}`);

let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    console.log(`[runtime] остановка по ${signal}`);
    void runtime.stop().finally(() => process.exit(0));
  });
}
