> Concierge approvals run through the official World ID for Agents dev environment (`sandbox.auth.world.org`, OIDC) when `WORLD_APPROVALS=agents`, which is how the hackathon build is configured. Setup: [WORLD-V4-FIX.md](WORLD-V4-FIX.md). Without the flag, approvals fall back to IDKit sessions.

# World ID integration debrief: World ID for Agents

Required by the "Best Use of World ID for Agents" prize. Written while building; the timing figure is filled in from the first live run against the sandbox.

## The agent and the actions it must not take alone

The concierge (`concierge.<parent>.eth`) is a named agent with exactly two on-chain permissions (the `friendship.now` and `friendship.table` text records on the app resolver, granted per key with `grantSetterRoles`). It can read who is around and which tables are open, and it can propose. It cannot put a member in a room with a stranger, publish where a member is, or reveal a member's contact without that member authenticating freshly with World ID.

Protected actions in v1:

| Action           | What the concierge does after approval                                                 |
| ---------------- | -------------------------------------------------------------------------------------- |
| `now.publish`    | Posts the member's Right now invitation and writes `friendship.now` on their trip name |
| `table.request`  | Asks the host for a seat (the attendee row is created only at approval time)           |
| `table.approve`  | The host admits a member; the concierge rewrites the table's attendee record           |
| `contact.reveal` | Accepts an introduction, which reveals the member's contact to the other person        |
| `agent.link`     | The one-time connection (stores the pairwise subject on the account)                   |

## The complete journey

1. Request: the member (or the concierge on their behalf) creates an `agent_approvals` row with a nonce, a PKCE verifier and a two-minute expiry, and gets an authorization URL for the sandbox IdP with `state = approval id`, `nonce`, `code_challenge`, `prompt=login` and `max_age=0`.
2. User completes it: the member signs in fresh in the World ID sandbox.
3. Validated result: the callback exchanges the code (client secret, PKCE verifier), validates the RS256 ID token against the JWKS (issuer, audience), checks `nonce` equals the row's nonce, `sub` equals the subject stored at link time, and `auth_time` is not older than the approval.
4. Protected action: inside the same database transaction the row flips to approved, the executor runs, and the row is marked consumed with the result id. A second callback for the same row is rejected and audited.

## The unsuccessful paths, all demonstrated

- Denied: the IdP redirects with `error=access_denied`; the row becomes `denied`; nothing runs.
- Expired: two minutes pass; the row becomes `expired` on the next status read or callback; nothing runs.
- Wrong person: a different pairwise subject answers; `APPROVAL_SUBJECT`; nothing runs.
- Stale: `auth_time` older than the approval; `APPROVAL_STALE`; nothing runs.
- Replay: the same code or the same approval used twice; `APPROVAL_CONSUMED` and an audit row.

`tests/world.test.ts` and `tests/gatherings.test.ts` cover every one of these against the real handlers.

## Time to first success

- Local (simulated IdP identity, same state machine): about three hours including the approval executor design.
- Live (sandbox): `[fill after the first live run: minutes from registering the OIDC client to a consumed approval]`

## Friction encountered

- The sandbox refuses `http://localhost` redirect URIs, so the agent flow cannot be exercised on a laptop without a public HTTPS tunnel. We had to build a simulated IdP path for the local demo and tests.
- Registering the OIDC client requires a Google sign-in on the portal and a human approving the request within 20 minutes; it cannot be scripted from CI.
- The discovery document lists `prompt` values `none` and `login` but does not list `max_age`. We send both `prompt=login` and `max_age=0` and validate `auth_time` ourselves; whether the sandbox honours `max_age` is unverified until the live run.
- The prize page says proofs are mocked in the sandbox; the docs at `sandbox.auth.world.org/docs` still describe the sandbox app flow. It was not obvious which applied during the hackathon.

## Missing capability or documentation

- A "step-up" endpoint or parameter documented as such (RFC 9470 is referenced on the docs page, but the concrete parameter set for a fresh authentication is not shown with an example).
- A way to attach a short human-readable description of the pending action to the authorization request, so the World ID screen can show "approve joining Kenji's dinner" rather than a generic sign-in. Today the summary lives only in our modal.
- Sandbox support for loopback redirect URIs, or a documented tunnel recipe, for local development.

## The one improvement with the greatest impact

Let the authorization request carry an action description that World ID shows to the person at the moment of consent. An agent approval is only meaningful if the human sees what they are approving in the same surface that authenticates them.
