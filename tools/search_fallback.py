"""Second chance for listings that never load by CID (Google merged or re-keyed them): search Google Maps
by name and accept a result only if it sits on the saved pin (30m) or within --max-meters with a matching name.

Usage: python tools/search_fallback.py tokyo [--max-meters 250]

Accepted results are written to _work/<city>/raw/search-<runId>.json with _targetCid set to the
catalog CID and _matchedBy = "name-search", so the rest of the pipeline treats them like any listing.
"""

import argparse
import math
import re

import requests

from common import apify_token, city_work, load_raw, read_json, write_json
from finalize import norm
from scrape import API, ACTOR, wait_run


def meters(a_lat, a_lng, b_lat, b_lng):
    r = 6371000
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dp, dl = p2 - p1, math.radians(b_lng - a_lng)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def name_overlap(a, b):
    """True when the saved name's lead word (its brand, not a trailing area like "Aoyama") appears in the listing title."""
    na, nb = norm(a), norm(b)
    if na and nb and (na in nb or nb in na):
        return True
    lead = next((t for t in re.split(r"[^\w]+", (a or "").casefold()) if len(t) >= 3), None)
    return bool(lead) and norm(lead) in nb


def acceptable(d, query, title, max_meters):
    # Right on the pin is the same venue even under a new name; further out, the names must agree too.
    return d <= 30 or (d <= max_meters and name_overlap(query, title))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("city")
    ap.add_argument("--max-meters", type=int, default=250)
    ap.add_argument("--max-images", type=int, default=10)
    ap.add_argument("--slug", help="force a search for this one place (manual override)")
    ap.add_argument("--query", help="search text to use with --slug")
    a = ap.parse_args()
    token = apify_token()
    work = city_work(a.city)
    index = read_json(work / "index.json")
    raw = load_raw(work)
    if a.slug:
        todo = [p for p in index if p["slug"] == a.slug]
        queries = {a.query or todo[0]["name"]: todo[0]}
    else:
        todo = [p for p in index if p["cid"] in raw and not raw[p["cid"]].get("title") and p["lat"] is not None]
        queries = {f"{p['name']}": p for p in todo}
    if not todo:
        print("nothing to search")
        return
    body = {
        "searchStringsArray": list(queries),
        "locationQuery": "Tokyo, Japan" if a.city == "tokyo" else a.city,
        "maxCrawledPlacesPerSearch": 3,
        "language": "en",
        "maxImages": a.max_images,
        "scrapeImageAuthors": True,
        "maxReviews": 0,
    }
    r = requests.post(f"{API}/acts/{ACTOR}/runs", params={"memory": 4096, "maxTotalChargeUsd": 1},
                      headers={"Authorization": f"Bearer {token}"}, json=body, timeout=60)
    r.raise_for_status()
    run = wait_run(token, r.json()["data"]["id"])
    items = requests.get(f"{API}/datasets/{run['defaultDatasetId']}/items", params={"clean": "true", "format": "json"},
                         headers={"Authorization": f"Bearer {token}"}, timeout=120).json()
    accepted = []
    for q, p in queries.items():
        best = None
        for it in items:
            if it.get("searchString") != q or not it.get("location"):
                continue
            d = meters(p["lat"], p["lng"], it["location"]["lat"], it["location"]["lng"])
            ok = d <= a.max_meters if a.slug else acceptable(d, q, it.get("title"), a.max_meters)  # --slug: a human chose the query
            if ok and (best is None or d < best[0]):
                best = (d, it)
        if best:
            it = dict(best[1], _targetCid=p["cid"] or p["slug"], _runId=run["id"], _matchedBy="name-search", _matchMeters=round(best[0]), _query=q)
            accepted.append(it)
            print(f"MATCH {p['slug']}: {it.get('title')!r} ({it.get('categoryName')}) {round(best[0])}m, {len(it.get('images') or [])} photos")
        else:
            near = [(it.get("title"), round(meters(p["lat"], p["lng"], it["location"]["lat"], it["location"]["lng"])))
                    for it in items if it.get("searchString") == q and it.get("location")]
            print(f"NO MATCH {p['slug']}: nearest candidates {near}")
    if accepted:
        write_json(work / "raw" / f"search-{run['id']}.json", accepted)
    print(f"${run.get('usageTotalUsd')}")


if __name__ == "__main__":
    main()
