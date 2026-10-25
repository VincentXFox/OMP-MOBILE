/**
 * Само-починка индикатора «thinking…».
 *
 * Проблема (видно на телефоне): индикатор работы живёт по событиям комнаты collab.
 * Если гость пропустил `agent_end` (уснул телефон, оборвался релей, хост упал посреди
 * хода), `isStreaming` остаётся `true` — и в чате вечно висит «thinking…», хотя агент
 * давно молчит.
 *
 * Источник истины о живости — реестр шлюза (`omp collab list`), который приложение
 * опрашивает каждые 5 с. Правило простое и осторожное: если реестр ДВА опроса подряд
 * говорит «не работает», а локально мы считаем, что работает, — верим реестру и
 * гасим индикатор. Два опроса нужны, чтобы не мигать в момент старта хода, когда
 * реестр отстаёт на один такт.
 *
 * Обратное направление сознательно не работает: реестр «работает», локально «тихо» —
 * ничего не включаем сами, иначе на медленном старте появится ложный индикатор.
 */

const IDLE_HITS_TO_CLEAR = 2;

export interface WorkingVerdict {
  working: boolean;
  idleHits: number;
  /** Индикатор снят именно этим шагом — повод показать «агент молчит». */
  healed: boolean;
}

export function nextWorking(wasWorking: boolean, hostBusy: boolean | null, idleHits: number): WorkingVerdict {
  if (hostBusy === null) {
    // Нет данных о хосте (мёртвая сессия вне реестра) — не трогаем индикатор.
    return { working: wasWorking, idleHits: 0, healed: false };
  }
  if (hostBusy) {
    return { working: wasWorking, idleHits: 0, healed: false };
  }
  if (!wasWorking) {
    return { working: false, idleHits: 0, healed: false };
  }
  const hits = idleHits + 1;
  if (hits >= IDLE_HITS_TO_CLEAR) return { working: false, idleHits: IDLE_HITS_TO_CLEAR, healed: true };
  return { working: true, idleHits: hits, healed: false };
}
