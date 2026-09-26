"""Build the target list for one city by joining Alex's catalog with Dan's saved-list export.

Usage: python tools/build_index.py tokyo

Inputs (in _work/source/):
  asia-catalog.json              content/asia-catalog.json from alexb0wman/new-friendship-tech
  Asia-Places-Full-Details.csv   Dan's Google Maps saved-list export

Output: _work/<city>/index.json, one record per catalog place in that city.
"""

import csv
import sys

from common import SOURCE, city_work, read_json, write_json


def main(city: str) -> None:
    catalog = read_json(SOURCE / "asia-catalog.json")
    rows = list(csv.DictReader(open(SOURCE / "Asia-Places-Full-Details.csv", encoding="utf-8-sig")))
    by_cid = {r["Google CID"]: r for r in rows if r["Google CID"]}

    places = [p for p in catalog["places"] if p["city"] == city]
    if not places:
        raise SystemExit(f"No catalog places for city {city!r}.")

    out = []
    for p in places:
        cid = p["mapUrl"].split("cid=")[-1] if "cid=" in p["mapUrl"] else None
        row = by_cid.get(cid) if cid else None
        rec = {
            "slug": p["slug"],
            "city": p["city"],
            "name": p["name"],
            "catalogCategory": p["category"],
            "mapUrl": p["mapUrl"],
            "cid": cid,
            "lat": float(row["Latitude"]) if row and row["Latitude"] else None,
            "lng": float(row["Longitude"]) if row and row["Longitude"] else None,
            "address": row["Address"] if row else None,
        }
        if not cid:
            # Coordinate-only pin: no Google listing to pull photos from.
            q = p["mapUrl"].split("q=")[-1]
            lat, lng = q.split(",")
            rec["lat"], rec["lng"] = float(lat), float(lng)
        out.append(rec)

    write_json(city_work(city) / "index.json", out)
    listed = sum(1 for r in out if r["cid"])
    print(f"{city}: {len(out)} places, {listed} with a Google listing, {len(out) - listed} coordinate-only pins")


if __name__ == "__main__":
    main(sys.argv[1])
