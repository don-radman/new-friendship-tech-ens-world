# QA brief (for the agents that check the final picks)

The photos were already chosen by curators following `tools/CURATION.md` (read it first). Your job is to catch mistakes before they ship. Be strict about real problems and do not nitpick taste.

Each review sheet (`_work/<city>/review/review-NNN.jpg`) shows up to four places, one row each: a title line (`slug | catalog name | placeKind | status`) and then the photos labelled `hero`, `alt-1`, `alt-2` and `alt-3`. The hero is shown cropped exactly as the app's 1.55:1 card will crop it.

## Flag a photo when

- it shows a different place from the others or from the name (a different storefront, a different city, another business)
- it has burned-in text overlays, captions, watermarks, date stamps, borders or a collage layout (signage that is physically part of the scene is fine)
- it is a menu, price board, receipt, flyer or screenshot
- a stranger's face is the main subject
- it is a near-duplicate of another photo in the same row
- it is blurry, very dark, badly tilted or visibly low quality
- it is explicit or otherwise unsafe for a general audience
- (hero only) the card crop cuts off the subject or leaves mostly empty wall, floor or sky, or an alternate would clearly make a much stronger card

Do not flag a photo just because a different pick would also have been fine.

## Fixing

For each flagged photo, open the place's full contact sheet at `_work/<city>/sheets/<slug>.jpg` (numbered candidates) and look for a replacement that is clearly better and not already used in that row. The candidate list with pixel sizes is in `_work/<city>/candidates.json` under the slug.

Actions:
- `{"action": "replace", "role": "alt-2", "n": 7, "subject": "drink", "tags": ["night", "moody"]}`: swap in candidate 7, with its subject and tags from the CURATION.md vocabularies
- `{"action": "drop", "role": "alt-3"}`: remove it (use this when no candidate is good)
- `{"action": "hero", "role": "alt-1"}`: promote that alternate to hero (the old hero becomes that alternate)
- `{"action": "objectPosition", "value": "50% 30%"}`: keep the hero but fix its crop

## Output

Write a JSON array to the path you are given, one object per place that needs a change (leave clean places out):

```json
{"slug": "tokyo-example", "issues": [{"role": "alt-2", "problem": "burned-in date stamp", "fix": {"action": "replace", "role": "alt-2", "n": 7}}]}
```

If every place is clean, write `[]`.
