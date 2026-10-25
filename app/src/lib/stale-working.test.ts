import { describe, expect, test } from "bun:test";
import { nextWorking } from "./stale-working";

describe("само-починка индикатора работы", () => {
  test("два «хост не работает» подряд гасят залипший индикатор", () => {
    const first = nextWorking(true, false, 0);
    expect(first).toMatchObject({ working: true, idleHits: 1, healed: false });
    const second = nextWorking(true, false, first.idleHits);
    expect(second).toMatchObject({ working: false, healed: true });
  });

  test("один такт отставания реестра не мигает", () => {
    expect(nextWorking(true, false, 0).working).toBe(true);
    expect(nextWorking(true, true, 1)).toMatchObject({ working: true, idleHits: 0 });
  });

  test("реестр «работает» не включает индикатор сам", () => {
    expect(nextWorking(false, true, 0)).toMatchObject({ working: false, healed: false });
  });

  test("нет данных о хосте — индикатор не трогаем", () => {
    expect(nextWorking(true, null, 0)).toMatchObject({ working: true, idleHits: 0 });
  });

  test("уже погашенный индикатор не считается починкой", () => {
    expect(nextWorking(false, false, 0)).toMatchObject({ working: false, healed: false });
  });
});
