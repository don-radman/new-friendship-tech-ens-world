"""Shared paths and helpers for the place-photos pipeline.

Layout:
  _work/                 scratch (gitignored): sources, raw scrapes, downloads, contact sheets, picks
  <city>/manifest.json   the deliverable index for one city
  <city>/manifest.csv    same data, one row per photo
  <city>/photos/<slug>/  hero.webp, alt-1.webp, alt-2.webp, alt-3.webp
"""

import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WORK = ROOT / "_work"
SOURCE = WORK / "source"

CATALOG_REPO = "https://github.com/alexb0wman/new-friendship-tech"
CATALOG_PATH = "content/asia-catalog.json"


def city_work(city: str) -> Path:
    p = WORK / city
    p.mkdir(parents=True, exist_ok=True)
    return p


def city_out(city: str) -> Path:
    p = ROOT / city
    p.mkdir(parents=True, exist_ok=True)
    return p


def read_json(path: Path, default=None):
    if not path.exists():
        return default
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, path)


def apify_token() -> str:
    token = os.environ.get("APIFY_TOKEN")
    if token:
        return token
    # Fall back to the Marketing OS env file on Dan's machine.
    env = ROOT.parent / "mos-ideation" / ".env"
    if env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            if line.startswith("APIFY_TOKEN="):
                return line.split("=", 1)[1].strip().strip('"')
    raise SystemExit("Set APIFY_TOKEN.")


def load_raw(work: Path) -> dict:
    """Scraped listings by target CID. When a place was scraped more than once (retries),
    a result that actually loaded the listing (has a title) wins over one that did not."""
    best = {}
    files = sorted((work / "raw").glob("*.json"), key=lambda f: f.stat().st_mtime)
    for f in files:
        for item in read_json(f, []):
            cid = item.get("_targetCid")
            if not cid:
                continue
            if cid not in best or item.get("title") or not best[cid].get("title"):
                best[cid] = item
    return best


def duplicate_primaries(index: list, raw: dict) -> dict:
    """Catalog places that resolve to the same Google listing: {secondary slug: primary slug}.
    The primary is the one whose own CID loaded directly; name-search recoveries become secondaries."""
    groups = {}
    for p in index:
        item = raw.get(p["cid"]) if p["cid"] else None
        if item and item.get("title"):
            groups.setdefault(item.get("placeId") or item.get("cid"), []).append(p)
    out = {}
    for members in groups.values():
        if len(members) < 2:
            continue
        members.sort(key=lambda m: raw[m["cid"]].get("_matchedBy") == "name-search")
        for m in members[1:]:
            out[m["slug"]] = members[0]["slug"]
    return out


def photo_base(url: str) -> str:
    """Google photo URLs carry size params after '='; the part before is the stable identity."""
    return url.split("=")[0]
