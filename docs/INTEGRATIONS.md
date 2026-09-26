# Integration contracts and remaining work

## Privy

Implemented: client provider; email and wallet sign-in; server access-token verification with `@privy-io/node`; unique subject enrollment; server-owned wallet association. Configure `PRIVY_APP_ID` and `PRIVY_APP_SECRET` at runtime. The browser obtains the public app ID from `GET /api/auth/config`, using the same runtime configuration as token verification; it no longer depends on a build-time `NEXT_PUBLIC_PRIVY_APP_ID`. That variable remains a server-side fallback for existing deployments. Keep the secret server-only. Add the exact app origin to Privy's allowed origins. Configure the desired email and embedded-wallet settings in the provider dashboard. A failed bootstrap can be retried with Sign in; clicks while initialization is pending are carried through to the login modal.

Test email login, external wallet login, logout, refresh, expired tokens, wallet unlink/relink, duplicate-account recovery and mobile wallet return navigation. Automatic account merging is deliberately absent. Admin support must review identity conflicts.

Official reference: https://docs.privy.io/

## ENS mainnet and ENSv2 Sepolia

Existing ENS names use Ethereum mainnet by default (`ENS_CHAIN_ID=1`, `ENS_MAINNET_RPC_URL`). Sepolia linking remains selectable with chain 11155111. Fresh normalized resolution must point to a verified linked wallet. Description writes use durable account, chain, sender, resolver and calldata intents, wallet signatures, receipt verification and independent record reads.

The trip namespace remains ENSv2 on Sepolia. **ENSv2 mainnet has not launched.** Configure `ENS_PARENT_NAME`, two distinct funded operator/concierge keys, and `ENS_SEPOLIA_RPC_URL`; run `npm run ens:bootstrap`, set its generated registry/resolver addresses, then run `npm run ens:smoke`. Live execution checks chain identity, deployed code and registry mounts. The worker persists transaction stages and reconciles pending submissions. Concierge permissions are restricted to the two approved record keys. Production periodically expires trips; expired trips cannot authorize new actions.

Nothing in this branch establishes that bootstrap or a real registration has already run. Record real Sepolia receipts in `docs/EVIDENCE.md`. A simulated receipt is never accepted as evidence.

References: https://ens.domains/ensv2 and https://docs.ens.domains/

## World ID production

Both trip activation and concierge approval use IDKit v4 with server-signed RP context. Configure `WORLD_APP_ID`, `WORLD_RP_ID`, `WORLD_RP_SIGNING_KEY`, `WORLD_ENVIRONMENT=production`, and the `trip-activate` action. Concierge approvals use World ID sessions (no action); `WORLD_ACTION_APPROVAL` is unused. See WORLD-V4-FIX.md. Sandbox OIDC credentials are no longer required for the production approval path.

The backend persists expiring, account-bound proof requests, binds the exact action and payload to their signal, validates the nonce and production environment, and requires a successful Proof of Human credential from the official v4 verifier. Weaker credentials and legacy proof/nullifier domains are not silently substituted. Trip proofs enforce one active human per city. Approvals require the linked human, recheck authorization and expiry under a database lock, and consume the proof with the protected action in one transaction. Denied, expired and replayed approvals do not execute business or blockchain writes.

Local demo adapters remain available only in local demo mode. `ENS_SIMULATED=true` outside demo now fails rather than giving a production account a simulated proof. Real proof acceptance and mobile World App return still require operator testing.

References: https://docs.world.org/world-id/idkit/integrate and https://docs.world.org/agents/human-in-the-loop/integrate

## 0G Pay

Membership checkout uses the official TokenFlight HTTP API underlying the pinned 0G Pay SDK, without importing its broken browser `ethers` dependency. The current plan route is **39 native USDC on Base → quoted native 0G to the merchant on chain 16661**. Historical invoices retain their stored price. Routing fees affect the quoted 0G output. Wallet gas is additional. This is not a USDC settlement on 0G or an arbitrary multi-asset checkout.

Configure `PAYMENT_RECIPIENT` (EOA treasury), `PAYMENT_SOURCE_RPC_URL` (Base), `PAYMENT_RPC_URL` (0G), `PAYMENT_PROVIDER=0g-pay`, and `CHECKOUT_ENABLED=true`. Both confirmation counts default to a minimum of 12. The destination RPC must support call traces when settlement uses an internal native transfer. `TOKENFLIGHT_INTEGRATOR_ID` is optional fee attribution, if assigned by the provider.

Quotes and permitted wallet requests are server-owned, stored with immutable source/route/destination obligations and expiry. The UI asks the wallet to approve bounded token spending and send the exact built transaction. A browser hash is only a reconciliation hint. The worker binds the provider order to the stored quote, route and payer, verifies the Base source transaction independently, and verifies the canonical destination native transfer/trace and configured confirmation depth. A successful browser callback or provider status alone cannot grant membership. Duplicate settlement evidence cannot pay another invoice. Late or interrupted payments retain references for reconciliation.

Unsupported provider responses or settlement proofs fail closed. Real provider availability, trace support and a real purchase remain unverified until exercised with operator-controlled funds. Do not claim checkout is live from a passing configuration check.

References: https://embed.tokenflight.ai/reference/api-client and the pinned SDK source.

## USDC table splits

Table bills use direct wallet-signed native USDC on Base by default, with Ethereum supported through `SPLIT_NETWORK=ethereum`. Configure `SPLIT_RPC_URL`; retain `SPLIT_BASE_RPC_URL` / `SPLIT_ETHEREUM_RPC_URL` for existing unpaid obligations after switching networks. This is separate from the membership 0G Pay route.

Each share freezes its recipient, chain, USDC token and amount; preparation binds the payer and minimum source block. The table cannot change membership after splitting. The verifier checks canonical finalized receipts, exact sender/calldata/token/amount and matching transfer logs. Payments predating the obligation and reused transactions are rejected. Existing unfinished legacy splits without mainnet obligations require review; they are not silently upgraded.

Reference: https://developers.circle.com/stablecoins/usdc-contract-addresses

## Launch configuration

Use `docs/LIVE-LAUNCH-SPEC.md` for the supported release and activation sequence. `npm run integrations:check` and authenticated `GET /api/admin/integrations` report missing configuration without printing secrets. Production rejects simulated adapters and ephemeral storage. The first-two-wallet automatic membership grant is removed. App and worker must run the same migrations and release.

## KMS and Secret Manager

`src/server/secrets.ts` loads allowed named secrets through ADC using the attached GCE service account. A JSON `SECRET_ENV_MAP` maps server environment names to Secret Manager version resources. Values load within each app/worker child, keeping them out of PM2's persisted parent environment. Do not export actual secret values in the shell used for `pm2 start` or `pm2 save`.

Grant access only to the needed secret versions and the dedicated KMS key. Use the correct KMS encryption/decryption permissions. Test seal/decrypt, denied IAM, corrupt ciphertext, wrong-owner associated data and key rotation. The local crypto test does not call KMS.

## Design and content

Reference system: https://tbdstudio.framer.ai/ . The implementation adopts dark fields, editorial type, restrained borders, generous spacing and lime actions. It is an original implementation, not a scraped copy of the reference source or imagery.

Provide licensed `AeonikPro-Regular.woff2` and `AeonikPro-Medium.woff2` in `public/fonts`. Until then, typography falls back to system sans. Original SVG placeholders live in `public/art`; replace them with the supplied city branding and optimize dimensions/file sizes. Do not commit font binaries unless their license explicitly permits public redistribution.

The former brand references are context, not production data sources: https://urconduit.webflow.io/ and https://www.neighborhood.guide/ . No curated venue accuracy or map inventory import is claimed by the code.
