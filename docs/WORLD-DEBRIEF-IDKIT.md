> Trip activation uses IDKit v4 with Proof of Human, verified server-side through the Developer Portal. A World ID 4.0 proof is one-time per action, so an account proves it is human once and later trips reuse that proof. Setup: [WORLD-V4-FIX.md](WORLD-V4-FIX.md).

# World ID integration debrief: IDKit at trip activation

Required by the "Best Use of IDKit" prize. Written while building; the two timing figures are filled in from the first live run against the World simulator and staging.

## The trust moment

Activating a trip is the moment a member becomes publicly present in a city: their trip name resolves, they can host a table with strangers and ask for seats at other people's tables. Before that moment the app needs to know one thing about the person, that they are one human, so that one person cannot flood a city with trips or hold several seats at a table through several accounts.

## Why Proof of Human is the minimum sufficient assurance

We do not need to know who the member is (Privy already authenticates the account), where they are from, or how old they are. We need uniqueness. Proof of Human gives exactly that: a nullifier that is stable per person per action and unlinkable across apps. Passport is offered as the second path for members who have not visited an Orb; it proves the same thing at a slightly different assurance level and produces its own nullifier. Selfie Check and Identity Check would ask for more than the product needs, so they are not requested.

## What happens on success

1. The backend signs the request (`rp_context`) with the RP signing key; the browser never sees the key.
2. The widget requests `proofOfHuman({ signal: city })`; the signal binds the proof to the city so it cannot be replayed for another city.
3. The backend forwards the IDKit result unchanged to `POST /api/v4/verify/{rp_id}`, requires `success`, requires the environment to match, recomputes the signal hash with `hashSignal` and compares.
4. The nullifier is stored as `NUMERIC(78,0)` with the city. If any active trip in that city already carries this nullifier, the activation fails with `HUMAN_ALREADY_PRESENT`. Otherwise the trip name is registered on ENSv2 with the departure date as its expiry.

## The alternative paths, all demonstrated

- Widget closed or cancelled: `onError` fires, the UI says "You closed World ID. No trip was created." No request reaches the backend.
- Credential unavailable: the verify endpoint fails, the UI maps it to "This World ID has no Proof of Human credential yet. Try the passport path." No trip row, no proof row.
- Same human, second account: `HUMAN_ALREADY_PRESENT` (409). The second account is told one human, one trip. Nothing is written.
- Tampered or foreign proof: `WORLD_VERIFY_FAILED` or `WORLD_SIGNAL_MISMATCH` (422). Nothing is written.

The local demo exercises every one of these through a simulated World adapter that hits the same backend code paths (`tests/trips.test.ts`, `tests/world.test.ts`).

## Time to first success

- Local (simulated adapter, same backend paths): under two hours from reading the docs to a green activation test.
- Live (simulator plus staging): `[fill after the first live run: minutes from creating the app in the Developer Portal to a verified proof]`

## Friction encountered

- The v4 response carries the nullifier in more than one place depending on the proof type (`body.nullifier`, `results[0].nullifier`, `responses[0].nullifier`). The backend reads all three defensively.
- `signal_hash` in the v4 uniqueness example is `0x0` when no signal is set; the docs do not say which hash function the widget uses for a set signal. `@worldcoin/idkit-core/hashing` exports `hashSignal`, which resolved it, but it is not mentioned on the integration page.
- `allow_legacy_proofs: true` means a v3 nullifier and a v4 nullifier for the same person differ. We store `issuer_schema_id` with each proof so the two can be told apart, but uniqueness across the two protocol versions is not something the app can enforce.
- The React widget needs `react >= 18` and pulls `qrcode`; in a Next 16 app it must be loaded with `next/dynamic` and `ssr: false`, which is not called out.

## Missing capability or documentation

- A server-side helper to validate a full IDKit result offline (schema and signal binding) before the network call would let the backend reject malformed payloads without spending a verify request.
- An explicit list of error `code` values returned by `/api/v4/verify` for "credential not held" versus "invalid proof", so the two alternative paths can be distinguished reliably instead of by substring matching.

## The one improvement with the greatest impact

Document `hashSignal` next to the `signal` parameter on the integration page, with the sentence "your backend must recompute this and compare it to `responses[0].signal_hash`". Signal binding is the difference between a proof of human and a proof of human for this action, and today the docs only tell you to "enforce the same value" without saying how.
