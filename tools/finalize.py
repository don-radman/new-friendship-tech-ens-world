"""Turn curated picks into the deliverable: clean webp photos plus manifest.json and manifest.csv.

Usage: python tools/finalize.py tokyo

Reads  _work/<city>/{index.json, raw/*.json, candidates.json, picks/*.json}
Writes <city>/photos/<slug>/{hero,alt-1,alt-2,alt-3}.webp, <city>/manifest.json, <city>/manifest.csv

Photos are re-encoded from the source pixels only: no captions, credits or overlays are
drawn on them and no EXIF is carried over. Credit lives in the manifest.
"""

import csv
import re
import sys
import unicodedata
from datetime import datetime, timezone

from PIL import Image, ImageOps

from common import CATALOG_PATH, CATALOG_REPO, city_out, city_work, duplicate_primaries, load_raw, read_json, write_json

LONG_EDGE = 1600
QUALITY = 80
ROLES = ["hero", "alt-1", "alt-2", "alt-3"]
SUBJECTS = {"space-interior", "space-exterior", "food", "drink", "view", "detail", "art", "nature", "activity"}
CATEGORIES = {"Eat", "Coffee", "Drink", "Work", "Culture", "Outdoors", "Meet"}


def norm(s):
    s = unicodedata.normalize("NFKC", s or "").casefold()
    return re.sub(r"[\W_]+", "", s)


def encode(src, dst):
    im = Image.open(src)
    im = ImageOps.exif_transpose(im).convert("RGB")
    im.thumbnail((LONG_EDGE, LONG_EDGE), Image.LANCZOS)
    dst.parent.mkdir(parents=True, exist_ok=True)
    im.save(dst, "WEBP", quality=QUALITY, method=6)
    return im.size


def orientation(w, h):
    r = w / h
    return "landscape" if r >= 1.15 else "portrait" if r <= 0.87 else "square"


def main(city):
    work, out = city_work(city), city_out(city)
    index = read_json(work / "index.json")
    cands = read_json(work / "candidates.json", {})
    raw = load_raw(work)
    picks = {}
    for f in sorted((work / "picks").glob("*.json")):
        for p in read_json(f, []):
            picks[p["slug"]] = p

    dupes = duplicate_primaries(index, raw)
    for secondary, primary in dupes.items():
        if primary in picks:
            picks[secondary] = dict(picks[primary], slug=secondary)
    same_listing = {}
    for secondary, primary in dupes.items():
        same_listing.setdefault(primary, []).append(secondary)
        same_listing.setdefault(secondary, []).append(primary)

    photos_dir = out / "photos"
    built = read_json(work / "built.json", {})  # "<slug>/<role>.webp" -> source file it was encoded from
    wanted = {}

    places, rows, problems = [], [], []
    for p in index:
        slug = p["slug"]
        item = raw.get(p["cid"]) if p["cid"] else None
        pick = picks.get(slug)
        by_n = {c["n"]: c for c in cands.get(dupes.get(slug, slug), [])}
        retrieved = (item or {}).get("scrapedAt", "")[:10] or None

        google = None
        if item:
            loc = item.get("location") or {}
            google = {
                "title": item.get("title"),
                "category": item.get("categoryName"),
                "categories": item.get("categories") or [],
                "rating": item.get("totalScore"),
                "reviewsCount": item.get("reviewsCount"),
                "priceLevel": item.get("price"),
                "address": item.get("address"),
                "neighborhood": item.get("neighborhood"),
                "lat": loc.get("lat"),
                "lng": loc.get("lng"),
                "placeId": item.get("placeId"),
                "website": item.get("website"),
                "permanentlyClosed": bool(item.get("permanentlyClosed")),
                "temporarilyClosed": bool(item.get("temporarilyClosed")),
                "listingPhotoCount": item.get("imagesCount"),
            }

        photos = []
        for role, sel in zip(ROLES, (pick or {}).get("photos", [])):
            c = by_n.get(sel["n"])
            if not c:
                problems.append(f"{slug}: pick {sel['n']} is not a kept candidate")
                continue
            if sel.get("subject") not in SUBJECTS:
                problems.append(f"{slug}: bad subject {sel.get('subject')!r}")
            rel = f"photos/{slug}/{role}.webp"
            key = f"{slug}/{role}.webp"
            wanted[key] = c["file"]
            if built.get(key) == c["file"] and (out / rel).exists():
                with Image.open(out / rel) as im:
                    w, h = im.size
            else:
                w, h = encode(work / c["file"], out / rel)
            src_type = c.get("sourceType", "google-maps-listing")
            by_business = None
            if src_type == "google-maps-listing" and c.get("authorName") and google:
                by_business = norm(c["authorName"]) == norm(google["title"])
            via = "Google Maps" if src_type == "google-maps-listing" else "Wikimedia Commons"
            credit_line = f"Photo: {c['authorName']} via {via}" if c.get("authorName") else f"Photo via {via}"
            photo = {
                "role": role,
                "file": rel,
                "width": w,
                "height": h,
                "orientation": orientation(w, h),
                "subject": sel.get("subject"),
                "depicts": sel.get("depicts") or ("place" if src_type == "google-maps-listing" else "surroundings"),
                "tags": sel.get("tags", []),
                "credit": {
                    "authorName": c.get("authorName"),
                    "authorUrl": c.get("authorUrl"),
                    "uploadedByBusiness": by_business,
                    "creditLine": credit_line,
                },
                "source": {
                    "type": src_type,
                    "photoUrl": c["sourceUrl"],
                    "pageUrl": c.get("pageUrl") or p["mapUrl"],
                    "uploadedAt": (c.get("uploadedAt") or "")[:10] or None,
                    "retrievedAt": retrieved or c.get("retrievedAt"),
                    "license": c.get("license", "google-maps-contributor"),
                },
            }
            if role == "hero":
                photo["objectPosition"] = sel.get("objectPosition", "50% 50%")
            photos.append(photo)
            rows.append({
                "slug": slug, "name": p["name"], "role": role, "file": f"{city}/{rel}",
                "width": w, "height": h, "orientation": photo["orientation"],
                "subject": photo["subject"], "depicts": photo["depicts"], "tags": "|".join(photo["tags"]),
                "authorName": c.get("authorName") or "", "authorUrl": c.get("authorUrl") or "",
                "uploadedByBusiness": "" if by_business is None else str(by_business).lower(),
                "creditLine": photo["credit"]["creditLine"], "license": photo["source"]["license"],
                "photoUrl": c["sourceUrl"], "mapUrl": p["mapUrl"],
            })

        status = "ok" if len(photos) == 4 else "partial" if photos else "no-photos"
        depicts = sorted({ph["depicts"] for ph in photos})
        photos_depict = None if not depicts else depicts[0] if len(depicts) == 1 else "mixed"
        sources = sorted({ph["source"]["type"] for ph in photos})
        if pick and pick.get("suggestedCategory") and pick["suggestedCategory"] not in CATEGORIES:
            problems.append(f"{slug}: bad category {pick['suggestedCategory']!r}")

        places.append({
            "slug": slug,
            "name": p["name"],
            "city": p["city"],
            "catalogCategory": p["catalogCategory"],
            "mapUrl": p["mapUrl"],
            "cid": p["cid"],
            "status": status,
            "photoCount": len(photos),
            "photosDepict": photos_depict,
            "photoSources": sources,
            "hasGoogleListing": bool(item and item.get("title")),
            "vibe": (pick or {}).get("vibe", []),
            "placeKind": (pick or {}).get("placeKind"),
            "suggestedCategory": (pick or {}).get("suggestedCategory"),
            "listingMatchesName": (pick or {}).get("listingMatchesName"),
            "sameListingAs": sorted(same_listing.get(slug, [])),
            "listingRecoveredBy": "name-search" if (item or {}).get("_matchedBy") == "name-search" else None,
            "notes": (pick or {}).get("notes") or None,
            "google": google,
            "photos": photos,
        })

    # Drop photos no longer picked, then record what each file was built from.
    if photos_dir.exists():
        for f in photos_dir.rglob("*.webp"):
            if f.relative_to(photos_dir).as_posix() not in wanted:
                f.unlink()
        for d in photos_dir.iterdir():
            if d.is_dir() and not any(d.iterdir()):
                d.rmdir()
    write_json(work / "built.json", wanted)

    counts = {}
    for pl in places:
        counts[pl["status"]] = counts.get(pl["status"], 0) + 1
    manifest = {
        "schemaVersion": 1,
        "city": city,
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "catalog": {"repo": CATALOG_REPO, "path": CATALOG_PATH, "commit": read_json(work / "catalog-commit.json", {}).get("commit")},
        "photoSpec": {"format": "webp", "longEdge": LONG_EDGE, "quality": QUALITY, "overlays": "none", "exif": "stripped"},
        "counts": {"places": len(places), "photos": len(rows), "byStatus": counts},
        "places": places,
    }
    write_json(out / "manifest.json", manifest)
    with open(out / "manifest.csv", "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()) if rows else ["slug"], lineterminator="\n")
        w.writeheader()
        w.writerows(rows)
    print(manifest["counts"])
    for line in problems:
        print("PROBLEM", line)
    if problems:
        sys.exit(1)


if __name__ == "__main__":
    main(sys.argv[1])
