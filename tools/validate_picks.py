"""Check curator output against the brief before finalizing.

Usage: python tools/validate_picks.py tokyo

Fails loudly on: unreadable JSON, unknown slugs, places curated twice, n values that are not kept
candidates, repeated n within a place, off-vocabulary subjects/tags/categories, more than 4 photos,
and portrait heroes chosen while a landscape candidate was picked as an alternate. Also lists places
that have candidates but no picks yet.
"""

import json
import sys

from common import city_work, duplicate_primaries, load_raw, read_json

SUBJECTS = {"space-interior", "space-exterior", "food", "drink", "view", "detail", "art", "nature", "activity"}
TAGS = {"night", "golden-hour", "daytime", "neon", "candlelit", "moody", "bright", "cozy", "minimal", "lively",
        "serene", "green", "retro", "counter-seating", "rooftop", "waterfront", "skyline", "street", "garden",
        "crowd", "intimate", "design"}
CATEGORIES = {"Eat", "Coffee", "Drink", "Work", "Culture", "Outdoors", "Meet"}


def main(city):
    work = city_work(city)
    index = read_json(work / "index.json")
    cands = read_json(work / "candidates.json", {})
    dupes = duplicate_primaries(index, load_raw(work))
    slugs = {p["slug"] for p in index}
    errors, warnings, seen = [], [], {}

    for f in sorted((work / "picks").glob("*.json")):
        try:
            picks = json.loads(f.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            errors.append(f"{f.name}: invalid JSON ({e})")
            continue
        for p in picks:
            slug = p.get("slug")
            where = f"{f.name}:{slug}"
            if slug not in slugs:
                errors.append(f"{where}: unknown slug")
                continue
            if slug in seen:
                errors.append(f"{where}: also curated in {seen[slug]}")
            seen[slug] = f.name
            by_n = {c["n"]: c for c in cands.get(slug, [])}
            photos = p.get("photos", [])
            if len(photos) > 4:
                errors.append(f"{where}: {len(photos)} photos")
            ns = [ph.get("n") for ph in photos]
            if len(set(ns)) != len(ns):
                errors.append(f"{where}: repeated n {ns}")
            for ph in photos:
                if ph.get("n") not in by_n:
                    errors.append(f"{where}: n={ph.get('n')} is not a candidate")
                if ph.get("subject") not in SUBJECTS:
                    errors.append(f"{where}: subject {ph.get('subject')!r}")
                bad = [t for t in ph.get("tags", []) if t not in TAGS]
                if bad:
                    errors.append(f"{where}: tags {bad}")
            if p.get("suggestedCategory") not in CATEGORIES:
                errors.append(f"{where}: category {p.get('suggestedCategory')!r}")
            bad = [t for t in p.get("vibe", []) if t not in TAGS]
            if bad:
                errors.append(f"{where}: vibe {bad}")
            if photos and photos[0].get("n") in by_n:
                h = by_n[photos[0]["n"]]
                landscape_alts = [ph["n"] for ph in photos[1:] if ph.get("n") in by_n and by_n[ph["n"]]["width"] / by_n[ph["n"]]["height"] >= 1.15]
                if h["width"] / h["height"] < 1.15 and landscape_alts:
                    warnings.append(f"{where}: non-landscape hero n={photos[0]['n']} while alternates {landscape_alts} are landscape")
            if photos and len(photos) < 4 and not p.get("notes"):
                warnings.append(f"{where}: {len(photos)} photos and no note")

    missing = [s for s, c in cands.items() if c and s not in seen and s not in dupes]
    for w in warnings:
        print("WARN ", w)
    for e in errors:
        print("ERROR", e)
    print(f"{len(seen)} curated, {len(missing)} with candidates but no picks, {len(errors)} errors, {len(warnings)} warnings")
    if missing:
        print("not curated:", missing)
    sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main(sys.argv[1])
