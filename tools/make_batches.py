"""Split a city's contact sheets into curation batches (one per curator agent).

Usage: python tools/make_batches.py tokyo [--size 40]

Writes _work/<city>/batches/batch-NN.json: the places to curate, each with its sheet path, the
catalog name, the Google listing title and category, and every candidate's n and pixel size.
Places whose picks already exist in _work/<city>/picks/ are skipped, so this is safe to re-run.
"""

import argparse

from common import city_work, duplicate_primaries, load_raw, read_json, write_json


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("city")
    ap.add_argument("--size", type=int, default=40)
    a = ap.parse_args()
    work = city_work(a.city)
    index = read_json(work / "index.json")
    cands = read_json(work / "candidates.json", {})
    raw = load_raw(work)
    done = {p["slug"] for f in (work / "picks").glob("*.json") for p in read_json(f, [])}
    dupes = duplicate_primaries(index, raw)  # secondaries reuse the primary's picks in finalize

    todo = []
    for p in index:
        kept = cands.get(p["slug"]) or []
        sheet = work / "sheets" / f"{p['slug']}.jpg"
        if not kept or not sheet.exists() or p["slug"] in done or p["slug"] in dupes:
            continue
        item = raw.get(p["cid"], {}) if p["cid"] else {}
        todo.append({
            "slug": p["slug"],
            "name": p["name"],
            "googleTitle": item.get("title"),
            "googleCategory": item.get("categoryName"),
            "sheet": str(sheet),
            "candidates": [{"n": c["n"], "w": c["width"], "h": c["height"]} for c in kept],
        })

    out = work / "batches"
    out.mkdir(exist_ok=True)
    for old in out.glob("batch-*.json"):
        old.unlink()
    for i in range(0, len(todo), a.size):
        write_json(out / f"batch-{i // a.size + 1:02d}.json", todo[i : i + a.size])
    print(f"{len(todo)} places in {(len(todo) + a.size - 1) // a.size} batches; {len(done)} already curated")


if __name__ == "__main__":
    main()
