"""Apply QA fixes (tools/QA.md) to the curated picks.

Usage: python tools/apply_qa.py tokyo [--dry-run]

Reads _work/<city>/qa/qa-*.json and rewrites the matching entries in _work/<city>/picks/*.json.
Roles in a fix always refer to the picks as QA saw them. Within one place: replacements and crop
fixes apply first, then a hero promotion, then drops. Every change is logged to qa/applied.json.
"""

import argparse

from common import city_work, duplicate_primaries, load_raw, read_json, write_json

ROLES = ["hero", "alt-1", "alt-2", "alt-3"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("city")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    work = city_work(a.city)
    cands = read_json(work / "candidates.json", {})
    dupes = duplicate_primaries(read_json(work / "index.json"), load_raw(work))

    files, where = {}, {}
    for f in sorted((work / "picks").glob("*.json")):
        files[f] = read_json(f, [])
        for p in files[f]:
            where[p["slug"]] = p

    log, problems = [], []
    for qf in sorted((work / "qa").glob("qa-*.json")):
        for entry in read_json(qf, []):
            slug = dupes.get(entry["slug"], entry["slug"])
            pick = where.get(slug)
            if not pick:
                problems.append(f"{qf.name}: {entry['slug']} has no picks")
                continue
            valid = {c["n"] for c in cands.get(slug, [])}
            photos = [dict(ph) for ph in pick["photos"]]
            before = [ph["n"] for ph in photos]
            fixes = [i["fix"] for i in entry.get("issues", []) if i.get("fix")]

            def idx(role):
                i = ROLES.index(role)
                if i >= len(photos):
                    raise IndexError(role)
                return i

            try:
                for fx in fixes:
                    if fx["action"] == "replace":
                        if fx["n"] not in valid:
                            raise ValueError(f"n={fx['n']} is not a candidate")
                        i = idx(fx["role"])
                        new = {"n": fx["n"], "subject": fx.get("subject", photos[i].get("subject")), "tags": fx.get("tags", [])}
                        if i == 0:
                            new["objectPosition"] = photos[0].get("objectPosition", "50% 50%")
                        photos[i] = new
                    elif fx["action"] == "objectPosition":
                        photos[0]["objectPosition"] = fx["value"]
                for fx in fixes:
                    if fx["action"] == "hero":
                        i = idx(fx["role"])
                        photos[0].pop("objectPosition", None)  # the old hero's crop does not apply to an alternate
                        photos[0], photos[i] = photos[i], photos[0]
                        photos[0]["objectPosition"] = fx.get("objectPosition", "50% 50%")
                drops = sorted((idx(fx["role"]) for fx in fixes if fx["action"] == "drop"), reverse=True)
                for i in drops:
                    photos.pop(i)
                if photos and "objectPosition" not in photos[0]:
                    photos[0]["objectPosition"] = "50% 50%"
                for ph in photos[1:]:
                    ph.pop("objectPosition", None)
                ns = [ph["n"] for ph in photos]
                if len(set(ns)) != len(ns):
                    raise ValueError(f"duplicate picks after fixes {ns}")
            except (ValueError, IndexError) as e:
                problems.append(f"{qf.name}: {slug}: {e}")
                continue

            log.append({"slug": slug, "qaFile": qf.name, "before": before, "after": [ph["n"] for ph in photos],
                        "problems": [i.get("problem") for i in entry.get("issues", [])]})
            pick["photos"] = photos
            if len(photos) < 4 and not pick.get("notes"):
                pick["notes"] = "QA removed weak photos; fewer than 4 good ones were available."

    for line in problems:
        print("PROBLEM", line)
    print(f"{len(log)} places changed")
    if not a.dry_run:
        for f, data in files.items():
            write_json(f, data)
        write_json(work / "qa" / "applied.json", log)


if __name__ == "__main__":
    main()
