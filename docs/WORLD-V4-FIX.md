# World ID 4.0 fix and hackathon setup

## Problem

World ID 4.0 uniqueness proofs are one-time per human per action ([World docs](https://docs.world.org/world-id/SKILL), [sessions](https://docs.world.org/world-id/idkit/session-proofs)). `main` used one action (`trip-activate`) for every trip and one (`concierge-approve`) for the concierge link and every approval after it. On a real World App the second trip and every approval after linking fail with `nullifier_replayed`. Tests passed only because the verifier mock accepted the same nullifier again.

## Fix

1. **Trips.** The first activation proves the account human under `trip-activate` and stores that proof before the trip insert, so a failed trip cannot strand a spent proof. Later trips reuse it: `world/rp-context` returns `{ verified: true }` and the client skips the widget. A nullifier already bound to another account is refused (one human, one account).
2. **Approvals.** Linking creates a World ID session (`IDKitSessionWidget`); its `session_id` is stored as `world_agent_sub`. Each approval proves that same session (`existing_session_id`, user presence required). The server rejects uniqueness payloads, checks nonce, signal, presence and session, then posts the untouched result to `/api/v4/verify/{rp_id}`.
3. **Widget.** Passes only the five signed `rp_context` fields. World imports come from `@worldcoin/idkit` (the declared dependency), not the transitive `idkit-core`.

4. **World ID for Agents restored.** Codex's rewrite removed the sandbox OIDC client, but the "Best Use of World ID for Agents" prize requires the official dev environment. With `WORLD_APPROVALS=agents`, concierge link and approvals go through `sandbox.auth.world.org` again (authorization code + PKCE S256, pairwise `sub`, `prompt=login` + `max_age=0` step-up on every action). Without it, approvals use the IDKit sessions above.

Files: `src/server/world/{live,approvals,adapter}.ts`, `src/server/ens-world/{trips,router}.ts`, `src/components/{idkit-widget,human-check,approval-modal}.tsx`, `tests/world-{live,agents}.test.ts`, `.env.example`, `deploy/ecosystem.config.cjs`, World docs and debriefs.

## Hackathon setup (both World prizes)

Which prize uses what:

| Prize                           | Flow                                                           | World product                      |
| ------------------------------- | -------------------------------------------------------------- | ---------------------------------- |
| Best Use of IDKit               | Trip activation (Proof of Human: one human, one trip per city) | IDKit v4 + Developer Portal        |
| Best Use of World ID for Agents | Concierge link, then approve each seat request or post         | World ID for Agents sandbox (OIDC) |

### 1. IDKit (developer.world.org)

1. Create an app with mode **External** (IDKit), not Mini App. The mode cannot be changed later.
2. Configure World ID for it. Copy the **app ID** (`app_...`) and **RP ID** (`rp_...`). The **signing key** is shown once: put it straight into the secret store as `WORLD_RP_SIGNING_KEY`.
3. Create the action `trip-activate` in the environment you will demo:
   - **Staging** if you demo with the World ID Simulator (simulator.worldcoin.org). Nobody needs an Orb.
   - **Production** only if the person demoing has an Orb-verified World ID in the real World App.
4. Wait until the RP shows as **registered** for that environment.
5. Env: `WORLD_APP_ID`, `WORLD_RP_ID`, `WORLD_RP_SIGNING_KEY`, `WORLD_ACTION_TRIP=trip-activate`, and either `WORLD_ENVIRONMENT=staging` + `WORLD_ALLOW_STAGING=true` (simulator on a deployed build) or `WORLD_ENVIRONMENT=production`.

Trap: the IDKit environment, the action's environment and simulator-vs-real-app must all match, or the QR scan silently produces nothing.

### 2. World ID for Agents (sandbox.auth.world.org/portal)

1. Register an OIDC client. Redirect URI: `https://<APP_ORIGIN>/api/world/agent/callback`, exactly. It must be public HTTPS; localhost is refused, so use the deployed origin or a tunnel.
2. Env: `WORLD_APPROVALS=agents`, `WORLD_AGENTS_ISSUER=https://sandbox.auth.world.org`, `WORLD_AGENTS_CLIENT_ID`, `WORLD_AGENTS_CLIENT_SECRET` (secret store), `WORLD_AGENTS_REDIRECT_URI` (same string as registered).
3. Proofs are mocked for the event, so no sandbox app is needed.

Trap: `deploy/ecosystem.config.cjs` passes only listed variables; the new ones are listed now, and `WORLD_AGENTS_CLIENT_SECRET` loads through `SECRET_ENV_MAP` like the other secrets. `npm run preflight` will flag sandbox identities as non-production: expected for the hackathon, clear them before a real launch.

### 3. Demo checklist (what judges need to see)

- IDKit: activate a trip (success), and one alternative path: close World ID (cancel) or use a World ID without the credential.
- Agents: link the concierge, approve a seat or post (action runs once), decline one (nothing written), let one expire after two minutes (nothing written).
- Fill the timing line in `docs/WORLD-DEBRIEF-IDKIT.md` and `docs/WORLD-DEBRIEF-AGENTS.md`; both prizes require the debrief.

## Verify

- `npm run typecheck`, `npm test` and `npm run build` pass, including the Agents flow against a fake IdP that signs real RS256 tokens (`tests/world-agents.test.ts`).
- Real phone, once: activate a trip, end it, activate another (no second World prompt). Link the concierge, then approve two actions in a row.

## Not verified

- Nothing here has run against a real World App. Session field names follow World's docs; the server tolerates the verifier omitting `session_id` or `environment` from its reply but rejects a mismatch.
- Sessions give no stable per-human ID, so the concierge link alone no longer stops one human linking two accounts. The one-human-one-account guarantee now comes from the trip proof.
