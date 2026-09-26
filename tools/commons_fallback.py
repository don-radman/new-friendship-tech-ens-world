"""Fallback for places with no Google listing photos: freely licensed Wikimedia Commons photos
taken within a radius of the pin.

Usage: python tools/commons_fallback.py tokyo [--radius 150]

Adds candidates (sourceType "wikimedia-commons", with license and author) to
_work/<city>/candidates.json and draws a contact sheet, so curation works the same way.
Only places whose candidate list is empty are touched.

Commons results are frozen in _work/<city>/commons.json the first time a place is searched, because
curators pick by candidate number and new uploads to Commons would otherwise renumber them. Pass
--refresh to search again (and re-curate those places afterwards).
"""

import argparse
import hashlib
import html
import re
import time
from datetime import date

import requests

from common import city_work, read_json, write_json
from fetch import MIN_LONG_EDGE, UA, download, sheet

API = "https://commons.wikimedia.org/w/api.php"
FREE = re.compile(r"^(CC0|CC BY(-SA)? [0-9.]+|Public domain|PD)", re.I)


def strip_html(s):
    return html.unescape(re.sub(r"<[^>]+>", "", s or "")).strip()


def query(params):
    for attempt in range(5):
        r = requests.get(API, headers=UA, timeout=30, params=params)
        if r.status_code == 200 and r.headers.get("content-type", "").startswith("application/json"):
            return r.json()
        time.sleep(2 + attempt * 3)
    r.raise_for_status()
    raise SystemExit(f"Commons API kept failing: HTTP {r.status_code}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("city")
    ap.add_argument("--radius", type=int, default=150)
    ap.add_argument("--force", nargs="*", default=[], help="slugs to add Commons candidates to even if Google ones exist")
    ap.add_argument("--refresh", action="store_true", help="search Commons again instead of reusing frozen results")
    a = ap.parse_args()
    work = city_work(a.city)
    index = read_json(work / "index.json")
    cands = read_json(work / "candidates.json", {})
    frozen = read_json(work / "commons.json", {})

    for p in index:
        if p["lat"] is None:
            continue
        # Only places with no Google candidates; drop any earlier Commons result so re-runs are clean.
        google = [c for c in cands.get(p["slug"], []) if c.get("sourceType", "google-maps-listing") != "wikimedia-commons"]
        if google and p["slug"] not in a.force:
            continue
        if p["slug"] in frozen and not a.refresh:
            cands[p["slug"]] = google + frozen[p["slug"]]
            print(p["slug"], len(frozen[p["slug"]]), "Commons candidates (frozen)")
            continue
        data = query({
            "action": "query", "format": "json", "generator": "geosearch",
            "ggscoord": f"{p['lat']}|{p['lng']}", "ggsradius": a.radius, "ggsnamespace": 6, "ggslimit": 40,
            "prop": "imageinfo", "iiprop": "url|size|extmetadata", "iiurlwidth": 2048,
        })
        pages = (data.get("query") or {}).get("pages", {})
        found = []
        for page in sorted(pages.values(), key=lambda pg: pg.get("index", 0)):  # nearest first
            if len(found) >= 12:
                break
            ii = (page.get("imageinfo") or [{}])[0]
            meta = ii.get("extmetadata") or {}
            lic = (meta.get("LicenseShortName") or {}).get("value", "")
            if not FREE.match(lic) or max(ii.get("width", 0), ii.get("height", 0)) < MIN_LONG_EDGE:
                continue
            thumb = ii.get("thumburl", "").split("?")[0]
            if not thumb.lower().endswith((".jpg", ".jpeg")):
                continue
            n = 51 + len(found)  # 51+ keeps Commons ids clear of Google candidate ids
            # File name comes from the Commons title, so a re-run can never pair a file with another photo's credit.
            path = work / "img" / p["slug"] / f"commons-{hashlib.sha1(page['title'].encode()).hexdigest()[:12]}.jpg"
            path.parent.mkdir(parents=True, exist_ok=True)
            if not download((path, thumb)):
                continue
            found.append({
                "n": n,
                "file": str(path.relative_to(work)).replace("\\", "/"),
                "sourceType": "wikimedia-commons",
                "sourceUrl": thumb,
                "pageUrl": ii.get("descriptionurl"),
                "photoId": page.get("title"),
                "authorName": strip_html((meta.get("Artist") or {}).get("value")),
                "authorUrl": None,
                "uploadedAt": (meta.get("DateTimeOriginal") or {}).get("value", "")[:10] or None,
                "retrievedAt": date.today().isoformat(),
                "license": lic,
                "width": ii.get("thumbwidth"),
                "height": ii.get("thumbheight"),
                "isListingCover": False,
            })
        cands[p["slug"]] = google + found
        frozen[p["slug"]] = found
        print(p["slug"], len(found), "Commons candidates")
        if found:
            allc = google + found
            sheet(f"{p['name']}  |  Google listing + Wikimedia Commons within {a.radius}m" if google else f"{p['name']}  |  Wikimedia Commons within {a.radius}m of the pin",
                  [(c["n"], work / c["file"]) for c in allc], work / "sheets" / f"{p['slug']}.jpg")
    write_json(work / "commons.json", frozen)
    write_json(work / "candidates.json", cands)


if __name__ == "__main__":
    main()
