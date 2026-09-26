# World ID 4.0 fix

## Problem

World ID 4.0 uniqueness proofs are one-time per human per action ([World docs](https://docs.world.org/world-id/SKILL), [sessions](https://docs.world.org/world-id/idkit/session-proofs)). `main` used one action (`trip-activate`) for every trip and one (`concierge-approve`) for the concierge link and every approval after it. On a real World App the second trip and every approval after linking fail with `nullifier_replayed`. Tests passed only because the verifier mock accepted the same nullifier again.

## Fix

1. **Trips.** The first activation proves the account human under `trip-activate` and stores that proof before the trip insert, so a failed trip cannot strand a spent proof. Later trips reuse it: `world/rp-context` returns `{ verified: true }` and the client skips the widget. A nullifier already bound to another account is refused (one human, one account).
2. **Approvals.** Linking creates a World ID session (`IDKitSessionWidget`); its `session_id` is stored as `world_agent_sub`. Each approval proves that same session (`existing_session_id`, user presence required). The server rejects uniqueness payloads, checks nonce, signal, presence and session, then posts the untouched result to `/api/v4/verify/{rp_id}`.
3. **Widget.** Passes only the five signed `rp_context` fields. World imports come from `@worldcoin/idkit` (the declared dependency), not the transitive `idkit-core`.

Files: `src/server/world/{live,approvals,adapter}.ts`, `src/server/ens-world/{trips,router}.ts`, `src/components/{idkit-widget,human-check,approval-modal}.tsx`, `tests/world-live.test.ts`, launch docs.

## World Developer Portal

- Action `trip-activate` must exist in **production**. Sessions need no action, so `concierge-approve` and `WORLD_ACTION_APPROVAL` are now unused.
- App ID, RP ID and signing key are unchanged. Keep `WORLD_ENVIRONMENT=production`.

## Verify

- `npm run typecheck` and `npm test` (216 tests) pass.
- Real phone, once: activate a trip, end it, activate another (no second World prompt). Link the concierge, then approve two actions in a row.

## Not verified

- Nothing here has run against a real World App. Session field names follow World's docs; the server tolerates the verifier omitting `session_id` or `environment` from its reply but rejects a mismatch.
- Sessions give no stable per-human ID, so the concierge link alone no longer stops one human linking two accounts. The one-human-one-account guarantee now comes from the trip proof.
