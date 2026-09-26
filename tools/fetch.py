"""Download photo candidates for scraped places, drop weak ones, and build numbered contact sheets.

Usage: python tools/fetch.py tokyo

For each place:
  - candidates = listing cover + scraped images, deduped by Google photo id
  - downloaded at 2048px long edge into _work/<city>/img/<slug>/NN.jpg
  - dropped: long edge under 1000px, near-duplicates (difference hash)
  - contact sheet at _work/<city>/sheets/<slug>.jpg with each tile labelled by its NN
Writes _work/<city>/candidates.json.
"""

import io
import sys
from concurrent.futures import ThreadPoolExecutor

import requests
from PIL import Image, ImageDraw, ImageFont, ImageOps

from common import city_work, load_raw, photo_base, read_json, write_json

MIN_LONG_EDGE = 1000
DUP_DISTANCE = 6


def dhash(im, size=8):
    g = ImageOps.grayscale(im).resize((size + 1, size), Image.LANCZOS)
    px = list(g.get_flattened_data()) if hasattr(g, "get_flattened_data") else list(g.getdata())
    bits = 0
    for row in range(size):
        for col in range(size):
            left = px[row * (size + 1) + col]
            right = px[row * (size + 1) + col + 1]
            bits = (bits << 1) | (left > right)
    return bits


UA = {"User-Agent": "nft-place-photos/1.0 (github.com/don-radman/new-friendship-tech-ens-world)"}


def download(job):
    path, url = job
    if path.exists() and path.stat().st_size > 0:
        return True
    for attempt in range(3):
        try:
            r = requests.get(url, timeout=45, headers=UA)
            if r.status_code == 200 and r.headers.get("content-type", "").startswith("image"):
                path.write_bytes(r.content)
                return True
        except requests.RequestException:
            pass
    return False


def font(size):
    for name in ("arialbd.ttf", "arial.ttf", "DejaVuSans-Bold.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def sheet(title, tiles, out):
    W, H, cols = 360, 270, 4
    rows = (len(tiles) + cols - 1) // cols
    canvas = Image.new("RGB", (cols * W, rows * H + 40), "white")
    d = ImageDraw.Draw(canvas)
    d.text((8, 8), title[:150], fill="black", font=font(18))
    for k, (n, path) in enumerate(tiles):
        im = Image.open(path).convert("RGB")
        im.thumbnail((W - 8, H - 8))
        x, y = (k % cols) * W + 4, 40 + (k // cols) * H + 4
        canvas.paste(im, (x, y))
        label = f"{n:02d}"
        d.rectangle((x, y, x + 44, y + 28), fill="black")
        d.text((x + 6, y + 3), label, fill="yellow", font=font(20))
    canvas.save(out, quality=82)


def main(city):
    work = city_work(city)
    index = read_json(work / "index.json")
    raw = load_raw(work)

    jobs, plan = [], {}
    for p in index:
        item = raw.get(p["cid"]) if p["cid"] else None
        if not item:
            continue
        seen, cands = set(), []
        authors = {photo_base(im["imageUrl"]): im for im in (item.get("images") or []) if im.get("imageUrl")}
        urls = ([item["imageUrl"]] if item.get("imageUrl") else []) + [im["imageUrl"] for im in (item.get("images") or []) if im.get("imageUrl")]
        for u in urls:
            if "streetviewpixels" in u:
                continue  # Street View thumbnails 403 outside Google's own pages
            b = photo_base(u)
            if b in seen:
                continue
            seen.add(b)
            meta = authors.get(b, {})
            n = len(cands) + 1
            path = work / "img" / p["slug"] / f"{n:02d}.jpg"
            path.parent.mkdir(parents=True, exist_ok=True)
            cands.append({
                "n": n,
                "file": str(path.relative_to(work)).replace("\\", "/"),
                "sourceUrl": b + "=s2048",
                "photoId": b.rsplit("/", 1)[-1],
                "authorName": meta.get("authorName"),
                "authorUrl": meta.get("authorUrl"),
                "uploadedAt": meta.get("uploadedAt"),
                "isListingCover": u == item.get("imageUrl"),
            })
            jobs.append((path, b + "=s2048"))
        plan[p["slug"]] = cands

    with ThreadPoolExecutor(16) as ex:
        ok = list(ex.map(download, jobs))
    print(f"downloaded {sum(ok)}/{len(jobs)}")

    sheets = work / "sheets"
    sheets.mkdir(exist_ok=True)
    cache_path = work / "imgcache.json"
    cache = read_json(cache_path, {})
    out = {}
    by_slug = {p["slug"]: p for p in index}
    for slug, cands in plan.items():
        kept, hashes = [], []
        for c in cands:
            path = work / c["file"]
            if not path.exists():
                continue
            key = f"{c['file']}:{path.stat().st_mtime_ns}"
            if key not in cache:
                try:
                    im = Image.open(path)
                    im.load()
                except Exception:
                    continue
                cache[key] = [im.size[0], im.size[1], dhash(im.convert("RGB"))]
            w, h, hsh = cache[key]
            c["width"], c["height"] = w, h
            if max(w, h) < MIN_LONG_EDGE:
                continue
            twin = next((k for o, k in zip(hashes, kept) if bin(hsh ^ o).count("1") <= DUP_DISTANCE), None)
            if twin is not None:
                # Same frame twice (usually the listing cover plus its credited copy): keep the first, keep the credit.
                if not twin.get("authorName") and c.get("authorName"):
                    for field in ("authorName", "authorUrl", "uploadedAt"):
                        twin[field] = c.get(field)
                continue
            hashes.append(hsh)
            kept.append(c)
        out[slug] = kept
        item = raw.get(by_slug[slug]["cid"], {})
        title = f"{by_slug[slug]['name']}  |  Google: {item.get('title')} / {item.get('categoryName')}"
        target = sheets / f"{slug}.jpg"
        fresh = target.exists() and all(target.stat().st_mtime > (work / c["file"]).stat().st_mtime for c in kept)
        if kept and not fresh:
            sheet(title, [(c["n"], work / c["file"]) for c in kept], target)
    write_json(cache_path, cache)
    write_json(work / "candidates.json", out)
    few = {s: len(v) for s, v in out.items() if len(v) < 4}
    print(f"{len(out)} places with candidates; {len(few)} have fewer than 4 usable: {few}")


if __name__ == "__main__":
    main(sys.argv[1])
