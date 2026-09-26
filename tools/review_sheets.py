"""QA sheets of the final picks: one row per place (hero, then alternates), four places per image.

Usage: python tools/review_sheets.py tokyo

Reads the finished <city>/manifest.json and photos, writes _work/<city>/review/review-NNN.jpg plus
review-index.json mapping each sheet to its slugs. Labels are drawn only on these QA sheets.
"""

import sys

from PIL import Image, ImageDraw

from common import city_out, city_work, read_json, write_json
from fetch import font

PER_SHEET = 4
H = 300


def main(city):
    work, out = city_work(city), city_out(city)
    manifest = read_json(out / "manifest.json")
    places = [p for p in manifest["places"] if p["photos"]]
    dest = work / "review"
    dest.mkdir(exist_ok=True)
    for old in dest.glob("review-*.jpg"):
        old.unlink()
    index = {}
    for s in range(0, len(places), PER_SHEET):
        chunk = places[s : s + PER_SHEET]
        rows = []
        for p in chunk:
            tiles = []
            for ph in p["photos"]:
                im = Image.open(out / ph["file"]).convert("RGB")
                if ph["role"] == "hero":
                    # Show the hero the way the card crops it: 1.55:1 around objectPosition.
                    w, h = im.size
                    x_pct, y_pct = [float(v.strip("%")) / 100 for v in ph.get("objectPosition", "50% 50%").split()]
                    if w / h > 1.55:
                        cw = int(h * 1.55)
                        left = int((w - cw) * x_pct)
                        im = im.crop((left, 0, left + cw, h))
                    else:
                        ch = int(w / 1.55)
                        top = int((h - ch) * y_pct)
                        im = im.crop((0, top, w, top + ch))
                im.thumbnail((10_000, H))
                tiles.append((ph["role"], im))
            rows.append((p, tiles))
        width = max(sum(t.width + 6 for _, t in tiles) for _, tiles in rows) + 6
        canvas = Image.new("RGB", (max(width, 900), len(rows) * (H + 40)), "white")
        d = ImageDraw.Draw(canvas)
        for r, (p, tiles) in enumerate(rows):
            y = r * (H + 40)
            d.text((6, y + 8), f"{p['slug']}  |  {p['name']}  |  {p.get('placeKind')}  |  {p['status']}", fill="black", font=font(18))
            x = 6
            for role, im in tiles:
                canvas.paste(im, (x, y + 36))
                d.rectangle((x, y + 36, x + 70, y + 60), fill="black")
                d.text((x + 5, y + 38), role, fill="yellow", font=font(16))
                x += im.width + 6
        name = f"review-{s // PER_SHEET + 1:03d}.jpg"
        canvas.save(dest / name, quality=80)
        index[name] = [p["slug"] for p in chunk]
    write_json(dest / "review-index.json", index)
    print(f"{len(index)} review sheets for {len(places)} places")


if __name__ == "__main__":
    main(sys.argv[1])
