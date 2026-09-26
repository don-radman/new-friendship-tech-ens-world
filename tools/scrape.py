"""Pull Google Maps listing data plus photo candidates via Apify (compass/crawler-google-places).

Usage: python tools/scrape.py tokyo [--max-images 10] [--batch 100] [--cap-usd 2]

Resumable: places already present in _work/<city>/raw/*.json are skipped.
Cost (Bronze tier, 2026-09): about $0.003/place + $0.002 detail page + $0.0005/image.
"""

import argparse
import json
import time

import requests

from common import apify_token, city_work, load_raw, read_json, write_json

ACTOR = "compass~crawler-google-places"
API = "https://api.apify.com/v2"


def start_run(token, cids, max_images, cap):
    body = {
        "startUrls": [{"url": f"https://www.google.com/maps?cid={c}"} for c in cids],
        "maxCrawledPlacesPerSearch": 1,
        "language": "en",
        "maxImages": max_images,
        "scrapeImageAuthors": True,
        "maxReviews": 0,
    }
    r = requests.post(
        f"{API}/acts/{ACTOR}/runs",
        params={"memory": 4096, "maxTotalChargeUsd": cap},
        headers={"Authorization": f"Bearer {token}"},
        json=body,
        timeout=60,
    )
    r.raise_for_status()
    return r.json()["data"]


def wait_run(token, run_id):
    while True:
        r = requests.get(
            f"{API}/actor-runs/{run_id}",
            params={"waitForFinish": 60},
            headers={"Authorization": f"Bearer {token}"},
            timeout=90,
        )
        r.raise_for_status()
        run = r.json()["data"]
        if run["status"] not in ("READY", "RUNNING"):
            return run
        time.sleep(2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("city")
    ap.add_argument("--max-images", type=int, default=10)
    ap.add_argument("--batch", type=int, default=100)
    ap.add_argument("--cap-usd", type=float, default=2.0)
    ap.add_argument("--retry-empty", action="store_true", help="re-scrape listings that came back without a title")
    a = ap.parse_args()

    token = apify_token()
    work = city_work(a.city)
    raw_dir = work / "raw"
    raw_dir.mkdir(exist_ok=True)
    index = read_json(work / "index.json")
    done = load_raw(work)
    if a.retry_empty:
        todo = [p["cid"] for p in index if p["cid"] in done and not done[p["cid"]].get("title")]
    else:
        todo = [p["cid"] for p in index if p["cid"] and p["cid"] not in done]
    print(f"{len(done)} already scraped, {len(todo)} to go")

    batches = [todo[i : i + a.batch] for i in range(0, len(todo), a.batch)]
    runs = [(b, start_run(token, b, a.max_images, a.cap_usd)) for b in batches]
    for b, run in runs:
        print("started", run["id"], len(b), "places")

    total = 0.0
    for b, run in runs:
        run = wait_run(token, run["id"])
        total += run.get("usageTotalUsd") or 0
        r = requests.get(
            f"{API}/datasets/{run['defaultDatasetId']}/items",
            params={"clean": "true", "format": "json"},
            headers={"Authorization": f"Bearer {token}"},
            timeout=120,
        )
        r.raise_for_status()
        items = r.json()
        wanted = set(b)
        for it in items:
            # Match on the URL we asked for; the listing's own cid can differ after a merge.
            src = it.get("inputStartUrl") or ""
            cid = src.split("cid=")[-1] if "cid=" in src else it.get("cid")
            it["_targetCid"] = cid if cid in wanted else it.get("cid")
            it["_runId"] = run["id"]
        write_json(raw_dir / f"{run['id']}.json", items)
        got = {it["_targetCid"] for it in items}
        missing = wanted - got
        print(f"run {run['id']} {run['status']}: {len(items)} items, missing {len(missing)}, ${run.get('usageTotalUsd')}")
        if missing:
            print("  missing:", sorted(missing))
    print(f"total ${total:.4f}")


if __name__ == "__main__":
    main()
