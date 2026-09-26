# Place photos for New Friendship Tech

Curated photos for the places in [`alexb0wman/new-friendship-tech`](https://github.com/alexb0wman/new-friendship-tech) `content/asia-catalog.json`, keyed by that catalog's place `slug`.

This branch (`place-photos`) is an orphan branch. It shares no history with the code branches in this repository, so it can be pulled on its own:

```bash
git clone --branch place-photos --single-branch https://github.com/don-radman/new-friendship-tech-ens-world.git place-photos
```

## What is here

| City | Places | Photos | Manifest |
|---|---|---|---|
| Tokyo | 401 (all catalog places): 360 with 4 photos, 35 with 1 to 3, 6 with none | 1,536 | [`tokyo/manifest.json`](tokyo/manifest.json), [`tokyo/manifest.csv`](tokyo/manifest.csv) |

Only Tokyo is done. The other catalog cities are not started (see "Adding a city").

### Tokyo places worth a human look before publishing

- **Listing now points somewhere else:** `tokyo-hanadaikon`. The saved Google ID resolves to Ginza Negura at a different address. It is probably a rename and move, but that is unconfirmed.
- **Duplicates in the catalog:** `tokyo-bar-ro-taru` = `tokyo-1`, and `tokyo-m-whisky-shop-ginza` = `tokyo-m-whisky-shop-ginza-m-whisky-museum-ginza` (`sameListingAs`).
- **Marked closed by Google at scrape time (20):** see `google.permanentlyClosed` / `google.temporarilyClosed`.
- **No photos (6):** `tokyo-bloom-branch-aoyama` and `tokyo-gumtree-coffee-company` (the listings no longer exist; possibly closed), `tokyo-nomena-gallery-asakusa`, `tokyo-drawing-and-manual` (nothing usable), `tokyo-hachioji` (only a text-heavy marker), `tokyo-times-car-rental` (practical pin, nothing to show).
- **Photos of the area, not the venue (11, `photosDepict` of `surroundings` or `mixed`):** bare addresses, roads and buildings. `tokyo-t-ky-prefectural-rte-305` shows LIQUIDROOM next to the pin, which may or may not be what the pin was saved for.
- **Heroes that are not landscape (19):** no good landscape candidate existed. Each has an `objectPosition` so the card crop keeps the subject.

```
tokyo/
  manifest.json               one entry per catalog place, including places with no photos
  manifest.csv                one row per photo (same data, flat)
  photos/<slug>/hero.webp     the card image
  photos/<slug>/alt-1.webp    alternates, best first
  photos/<slug>/alt-2.webp
  photos/<slug>/alt-3.webp
tools/                        the pipeline that produced this, re-runnable per city
```

## For the agent wiring this into the app

1. Join on `slug`. Every Tokyo place in the catalog (at the commit recorded in `manifest.catalog.commit`) has exactly one entry in `tokyo/manifest.json`, whatever its `status`.
2. Use `photos[0]` (role `hero`) for the place card. The card is landscape 1.55:1 with `object-fit: cover`; apply the hero's `objectPosition` as CSS `object-position`.
3. Use the `alt-*` photos for a gallery on the place page.
4. Credit comes from the manifest, never from the image. Photos carry no captions, watermarks or overlays, and EXIF is stripped. Each photo has `credit.creditLine` (for example `Photo: HIRO O via Google Maps`), plus `credit.authorName`, `credit.authorUrl` and `source.pageUrl` for building your own credit tag.
5. Check `status` before relying on a place:
   - `ok`: 4 photos
   - `partial`: 1 to 3 photos (fewer good candidates existed; see `notes`)
   - `no-photos`: nothing usable was found (see `notes`)
6. Check `photosDepict` too. `place` means the photos show the venue itself. `surroundings` means the pin is a bare address, road or building with no usable listing photos, so the photos are freely licensed street shots within 150m (every photo also carries its own `depicts`). Show these as "the area", or skip them. `mixed` means some of each.
7. Read `notes` for anything flagged by a curator. The ones that matter most:
   - `listingMatchesName: false`: the saved Google ID now points at a differently named business (for example `tokyo-hanadaikon` now resolves to Ginza Negura). Confirm before publishing.
   - `sameListingAs`: two catalog entries are the same Google listing (a duplicate in the catalog). Both get the same photos. Keep one.
   - `listingRecoveredBy: "name-search"`: the saved Google ID no longer loads, so the listing was found by name within 30m of the pin (or 250m with a matching name).
8. `google.permanentlyClosed` and `google.temporarilyClosed` are true for venues Google marks closed at scrape time. Worth hiding or re-checking those.
9. Bonus data you can ignore: `suggestedCategory` (most catalog places are `Meet` by default; this is a curator's read of the right category from your enum, and shops, hotels and saunas mostly land in `Meet` or `Culture` because the enum has no shopping or stay category), `placeKind`, `vibe`, per-photo `subject` and `tags`, and the `google` block (rating, category, address, coordinates, place ID).

## Photo spec

WebP, 1600px on the long edge, quality 80, sRGB, EXIF stripped, no overlays. Orientation is recorded per photo. Heroes are landscape wherever a good landscape shot existed.

## Rights: read this before shipping

1,498 of the 1,536 photos come from the places' public Google Maps listings. Copyright stays with whoever uploaded each one: the business itself (`credit.uploadedByBusiness: true`, a name-match heuristic) or a Google Maps contributor. They are not licensed to this project. Every photo records its author and source so the app can credit it, filter it, or swap it out. `source.license` is `google-maps-contributor` for these.

The other 38 are Wikimedia Commons photos under CC0, public domain, CC BY or CC BY-SA. `source.license` holds the exact license and `source.pageUrl` the file page. CC BY and CC BY-SA require a visible credit plus the license name or link.

The app's content importer asserts `originalOrLicensed: true`. Decide how these photos fit that before they go into production content.

## How they were picked

1. `tools/build_index.py` joins the catalog with Dan's saved-list export on the Google CID.
2. `tools/scrape.py` pulls each listing's cover plus up to 10 more photos, with author names, via Apify's Google Maps Scraper. `--retry-empty` re-tries listings that failed to load.
3. `tools/search_fallback.py` recovers listings whose saved ID no longer loads, by name near the pin, with a distance and name-match guard. `--slug/--query` forces a search for one place.
4. `tools/fetch.py` downloads candidates at 2048px, drops anything under 1000px and near-duplicates, and draws a numbered contact sheet per place.
5. `tools/commons_fallback.py` adds freely licensed Wikimedia Commons photos within 150m for places with no usable listing photos.
6. Curator agents review every contact sheet against [`tools/CURATION.md`](tools/CURATION.md): the most atmospheric landscape shot becomes the hero, three varied alternates follow, and menus, text overlays, blurry shots and stranger portraits are rejected. `tools/validate_picks.py` checks their output.
7. `tools/finalize.py` re-encodes the picks and writes the manifests. `tools/review_sheets.py` renders every final set (heroes shown with the card crop), and QA agents check them against [`tools/QA.md`](tools/QA.md). `tools/apply_qa.py` applies their fixes, then finalize runs again.

## Adding a city

```bash
python tools/build_index.py osaka
python tools/scrape.py osaka --max-images 10
python tools/scrape.py osaka --retry-empty
python tools/search_fallback.py osaka
python tools/fetch.py osaka
python tools/commons_fallback.py osaka    # only touches places left with no candidates
python tools/make_batches.py osaka       # curation batches for agents, per tools/CURATION.md
# curators write _work/osaka/picks/*.json
python tools/validate_picks.py osaka
python tools/finalize.py osaka
python tools/review_sheets.py osaka      # QA agents, per tools/QA.md, write _work/osaka/qa/qa-*.json
python tools/apply_qa.py osaka
python tools/finalize.py osaka
```

`_work/` is scratch and is not committed. Put `asia-catalog.json` (from the catalog repo) and `Asia-Places-Full-Details.csv` (Dan's export) in `_work/source/` first. Scraping needs `APIFY_TOKEN`. It costs about $0.01 per place.
