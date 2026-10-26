#!/usr/bin/env python3
"""Состязательный пробник API памяти OMP Pocket.

Пытается ОПРОВЕРГНУТЬ утверждения:
  1) инъекция в q/source/kind не проходит (bind-параметры + ESCAPE);
  2) API не врёт о количестве строк (сверка с самой базой Mnemopi);
  3) сортировки монотонны, пагинация не теряет и не дублирует строки;
  4) фильтр не применимый к таблице не игнорируется молча;
  5) время в UTC, регистр кириллицы не режет выдачу, кривой ввод не роняет шлюз.
Negative control: та же полезная нагрузка подаётся в наивную конкатенацию LIKE —
она ОБЯЗАНА сломаться, иначе проверка бессмысленна.

Запуск: python3 /tmp/memory-api-probe.py
Выход: VERDICT: PASS|FAIL + найденные дефекты.
"""
import datetime
import json
import os
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

CONFIG = os.path.expanduser("~/omp-mobile/gateway/config.json")
BANKS = os.path.expanduser("~/.omp/agent/memories/mnemopi/banks")
BASE = "http://127.0.0.1:8088"
BANK = "vincentfox-1ecs4vgag6mnf"

failures: list[str] = []


def check(name: str, ok: bool, detail: str) -> None:
    print(("  ok   " if ok else "  FAIL ") + name + ": " + detail)
    if not ok:
        failures.append(name + " → " + detail)


def api(path: str, **params):
    token = json.load(open(CONFIG))["token"]
    url = BASE + path + ("?" + urllib.parse.urlencode(params) if params else "")
    req = urllib.request.Request(url, headers={"authorization": "Bearer " + token})
    try:
        with urllib.request.urlopen(req, timeout=90) as res:
            return res.status, json.loads(res.read().decode())
    except urllib.error.HTTPError as err:
        return err.code, json.loads(err.read().decode() or "{}")


def db_count(table: str) -> int:
    con = sqlite3.connect("file:%s?mode=ro" % os.path.join(BANKS, BANK, "mnemopi.db"), uri=True)
    try:
        return con.execute('SELECT count(*) FROM "%s"' % table).fetchone()[0]
    finally:
        con.close()


def ts_ms(value):
    """Время записи в мс: наивные строки SQLite считаем UTC, как и сам шлюз."""
    if not value:
        return -1
    text = value.strip()
    if re.match(r"^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$", text):
        text = text.replace(" ", "T") + "Z"
    return int(datetime.datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp() * 1000)


def raw_get(path: str):
    """Запрос с путём как есть: urllib кодирует недопустимые %-последовательности."""
    import http.client

    token = json.load(open(CONFIG))["token"]
    conn = http.client.HTTPConnection("127.0.0.1", 8088, timeout=60)
    conn.putrequest("GET", path, skip_accept_encoding=True)
    conn.putheader("authorization", "Bearer " + token)
    conn.endheaders()
    res = conn.getresponse()
    body = res.read().decode("utf8", "replace")
    conn.close()
    return res.status, body[:120]


print("1) API против самой базы")
for table in ("facts", "working_memory", "episodic_memory", "annotations"):
    db = db_count(table)
    _, body = api("/api/memory/banks/%s/entries" % BANK, type=table, limit=1)
    check("count " + table, db == body.get("total"), "db=%s api=%s" % (db, body.get("total")))

print("2) инъекции в q / source / kind")
for payload in ["' OR 1=1 --", "'; DROP TABLE facts;--", '"', "%", "_", "\\"]:
    code_q, body_q = api("/api/memory/banks/%s/entries" % BANK, type="facts", q=payload, limit=3)
    code_f, body_f = api("/api/memory/banks/%s/entries" % BANK, type="working_memory", source=payload, kind=payload, limit=3)
    check(
        "payload %r" % payload,
        code_q == 200 and code_f == 200 and body_q.get("error") is None,
        "q=%s/%s filter=%s/%s" % (code_q, body_q.get("total"), code_f, body_f.get("total")),
    )
check("facts цела после инъекций", db_count("facts") > 0, "facts=%s" % db_count("facts"))

print("3) negative control: наивная конкатенация ОБЯЗАНА сломаться")
con = sqlite3.connect("file:%s?mode=ro" % os.path.join(BANKS, BANK, "mnemopi.db"), uri=True)
naive = "SELECT count(*) FROM facts WHERE object LIKE '%%%s%%'" % "' OR 1=1 --"
try:
    rows = con.execute(naive).fetchone()[0]
    total = db_count("facts")
    check("negative control", rows == total, "наивная конкатенация вернула %s из %s строк — payload реален" % (rows, total))
except sqlite3.Error as err:
    check("negative control", True, "наивная конкатенация падает: %s" % err)
finally:
    con.close()

print("4) ложные параметры")
check("неизвестный type → 400", api("/api/memory/banks/%s/entries" % BANK, type="sqlite_master")[0] == 400, "см. код")
check("неизвестный банк → 404", api("/api/memory/banks/nonexistent-bank/entries", type="facts")[0] == 404, "см. код")
check("битый bank name → 400", raw_get("/api/memory/banks/%ZZ/entries?type=facts")[0] == 400, "код %s" % raw_get("/api/memory/banks/%ZZ/entries?type=facts")[0])
_, body = api("/api/memory/banks/%s/entries" % BANK, type="facts", limit=100000)
check("limit обрезан (≤200)", len(body.get("entries", [])) <= 200, "вернулось %s" % len(body.get("entries", [])))

print("5) монотонность сортировок")
for field, table, order in (
    ("importance", "working_memory", "importance"),
    ("confidence", "facts", "confidence"),
    ("recallCount", "episodic_memory", "recall"),
):
    _, body = api("/api/memory/banks/%s/entries" % BANK, type=table, sort=order, limit=50)
    values = [e.get(field) for e in body.get("entries", []) if e.get(field) is not None]
    mono = all(values[i] >= values[i + 1] for i in range(len(values) - 1))
    check("sort " + order, mono and len(values) > 0, "n=%s первые %s" % (len(values), values[:3]))

print("6) пагинация: без пересечений и потерь")
for table, sort in (("facts", "ts"), ("working_memory", "importance"), ("all", "ts"), ("all", "importance")):
    pages = []
    for offset in (0, 30):
        _, body = api("/api/memory/banks/%s/entries" % BANK, type=table, sort=sort, limit=30, offset=offset)
        entries = body.get("entries", [])
        pages.append([(e.get("table"), e["id"]) for e in entries])
        if offset == 0 and table == "all":
            stamps = [ts_ms(e.get("ts")) for e in entries]
            mono = all(stamps[i] >= stamps[i + 1] for i in range(len(stamps) - 1))
            check("all/%s сливается по времени" % sort, mono, "первые %s" % [e.get("ts") for e in entries][:2])
    check(
        "%s/%s: страницы без пересечений" % (table, sort),
        len(set(pages[0]) & set(pages[1])) == 0 and len(pages[0]) == 30,
        "пересечений %s, строк %s" % (len(set(pages[0]) & set(pages[1])), len(pages[0])),
    )

print("7) фильтры, время, регистр, кривой ввод")
_, body = api("/api/memory/banks/%s/entries" % BANK, type="all", kind="zzz", limit=5)
check("all + kind=zzz → 0 (не игнорируется)", body.get("total") == 0, "total=%s" % body.get("total"))
_, body = api("/api/memory/banks/%s/entries" % BANK, type="facts", source="zzz", limit=5)
check("facts + source=zzz → 0 (не игнорируется)", body.get("total") == 0, "total=%s" % body.get("total"))
_, body = api("/api/memory/banks/%s/entries" % BANK, type="annotations", limit=10)
stamps = [e.get("ts") for e in body.get("entries", []) if e.get("ts")]
naive_stamps = [ts for ts in stamps if not re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$", ts)]
check("аннотации: ts в ISO с Z", len(naive_stamps) == 0, "наивных %s из %s" % (len(naive_stamps), len(stamps)))
low = api("/api/memory/banks/%s/entries" % BANK, type="working_memory", q="память", limit=1)[1].get("total")
cap = api("/api/memory/banks/%s/entries" % BANK, type="working_memory", q="Память", limit=1)[1].get("total")
check("регистр кириллицы не режет выдачу", low == cap and (low or 0) > 0, "нижний=%s, с заглавной=%s" % (low, cap))
t0 = time.time()
_, far = api("/api/memory/banks/%s/entries" % BANK, type="all", limit=30, offset=10**6)
check("offset=10^6 → пусто и быстро", far.get("entries") == [] and time.time() - t0 < 5, "%.2fs" % (time.time() - t0))

print("8) обогащение и переход «из записи»")
_, body = api("/api/memory/banks/%s/entries" % BANK, type="annotations", limit=40)
rows = body.get("entries", [])
with_parent = [r for r in rows if r.get("memoryId")]
resolved = [r for r in with_parent if r.get("episode")]
check("родитель аннотации найден", len(with_parent) == len(resolved), "%s/%s" % (len(resolved), len(with_parent)))
_, gists = api("/api/memory/banks/%s/entries" % BANK, type="gists", limit=5)
found = checked = 0
for gist in gists.get("entries", []):
    episode = gist.get("episode")
    if not episode:
        continue
    checked += 1
    seed = episode[:48].strip()
    _, hit = api("/api/memory/banks/%s/entries" % BANK, type="episodic_memory", q=seed, limit=5)
    if any(e["id"] == gist.get("memoryId") for e in hit.get("entries", [])):
        found += 1
check("сырой префикс родителя находится поиском", checked > 0 and found == checked, "%s/%s" % (found, checked))

print()
if failures:
    print("VERDICT: FAIL (%d)" % len(failures))
    for item in failures:
        print("  - " + item)
    sys.exit(1)
print("VERDICT: PASS (0 дефектов)")
