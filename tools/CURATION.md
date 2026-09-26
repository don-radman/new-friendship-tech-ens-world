# Curation brief (for the agents that pick photos)

You are choosing photos for New Friendship Tech, an app that shows travellers the places a well-travelled founder actually rates. Every place gets a landscape card (1.55:1, `object-fit: cover`) and a detail page with a small gallery. The bar is high: someone scrolling should feel the place and want to go.

For each place you get a contact sheet: a title line (`catalog name | Google: listing title / Google category`) and numbered tiles. The yellow number on each tile is the candidate id `n`. The numbers exist only on the sheet; the delivered photos are clean.

## Pick up to 4 photos per place

1. **hero**: the single most atmospheric, representative shot of the place itself. The space, the view, the signature experience. Good light, strong composition, mood. It will be cropped to a landscape card, so strongly prefer a landscape shot. Use a portrait or square one only when no landscape candidate is good, and then set `objectPosition` (CSS, e.g. `"50% 35%"`) so the crop keeps the subject.
2. **three alternates**: the next best, chosen for variety. Aim to cover different angles of the place, for example exterior, interior, the signature food or drink, the view, a detail. No two picks that show nearly the same frame.

Order the alternates best first.

## Never pick

- menus, price boards, receipts, flyers, screenshots, maps, or a logo on its own
- anything with burned-in text overlays, captions, watermarks, borders, or collage layouts
- blurry, very dark, noisy, badly tilted, or heavily filtered shots
- a person's face as the main subject (people in the scene are fine; a portrait of a stranger is not)
- a photo that is clearly not of this place
- warped 360 or Street View panoramas, unless nothing else exists and it reads well

If fewer than 4 candidates clear the bar, return fewer. Never pad with a weak photo. If none clear it, return an empty `photos` list and say why in `notes`.

## Tags

For each picked photo:
- `subject`: exactly one of `space-interior`, `space-exterior`, `food`, `drink`, `view`, `detail`, `art`, `nature`, `activity`
- `tags`: 1 to 4 from `night`, `golden-hour`, `daytime`, `neon`, `candlelit`, `moody`, `bright`, `cozy`, `minimal`, `lively`, `serene`, `green`, `retro`, `counter-seating`, `rooftop`, `waterfront`, `skyline`, `street`, `garden`, `crowd`, `intimate`, `design`

For the place:
- `vibe`: 2 to 4 of the same mood words that fit the place overall
- `placeKind`: a short plain label, e.g. `"standing sake bar"`, `"third-wave coffee stand"`, `"shrine"`
- `suggestedCategory`: one of `Eat`, `Coffee`, `Drink`, `Work`, `Culture`, `Outdoors`, `Meet` (Meet = a social spot that fits nothing else, or a neighbourhood or landmark)
- `listingMatchesName`: `false` only if the Google listing looks like a different place from the catalog name (a rename to the same venue counts as a match)
- `notes`: empty unless something is worth flagging (closed-looking, listing mismatch, fewer than 4 good photos and why)

## Output

Write a JSON array to the path you are given, one object per place, in this exact shape:

```json
{
  "slug": "tokyo-bar-example",
  "photos": [
    {"n": 3, "subject": "space-interior", "tags": ["night", "moody"], "objectPosition": "50% 50%"},
    {"n": 7, "subject": "drink", "tags": ["candlelit", "intimate"]},
    {"n": 1, "subject": "space-exterior", "tags": ["street", "night"]},
    {"n": 9, "subject": "view", "tags": ["skyline", "golden-hour"]}
  ],
  "vibe": ["moody", "intimate"],
  "placeKind": "cocktail bar",
  "suggestedCategory": "Drink",
  "listingMatchesName": true,
  "notes": ""
}
```

The first photo is the hero. `objectPosition` is only read on the hero. Use only `n` values that appear on that place's sheet.
