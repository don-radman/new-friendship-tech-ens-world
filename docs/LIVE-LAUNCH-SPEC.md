# Live integration launch

Target: September 26, 2026, Tokyo time. This document defines the supported launch path, its external requirements, and the evidence required to call it live. A passing build does not establish a successful payment, World verification, or ENS transaction.

## Product scope

| Feature                                              | Production path                                 | Boundary                                                                                                                                   |
| ---------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Link an existing ENS name; write description         | Ethereum mainnet, chain 1                       | Wallet ownership, resolver authorization and the mined transaction are checked independently.                                              |
| Issue an expiring trip name; concierge table records | ENSv2 on Sepolia, chain 11155111                | ENSv2 mainnet has not launched. These names are real testnet names, never mainnet names.                                                   |
| Activate a trip                                      | World ID production, IDKit v4                   | Server-issued challenge bound to the account, city and action; successful backend credential verification required.                        |
| Approve a concierge action                           | World ID production, IDKit v4                   | Approval binds the account, operation and payload; expires and is consumed once. The sandbox OIDC client is not a prerequisite.            |
| Buy All Access                                       | 0G Pay infrastructure via the TokenFlight API   | Customer sends 19 USDC on Base plus wallet gas; merchant receives the route's quoted native 0G minimum on chain 16661, after routing fees. |
| Split a table bill                                   | Direct native USDC on Base, optionally Ethereum | Separate from 0G membership checkout and ENS network. No simulated currency in production.                                                 |

“All three fully on mainnet” is not an available deployment configuration: ENSv2 is Sepolia-only. The closest truthful release is ENS mainnet identity + ENSv2 Sepolia trip functionality + production World proofs + mainnet payments. Do not rename ENSv1 as ENSv2 or describe testnet evidence as a mainnet deployment.

## Required operator inputs

Place secrets in the runtime secret store. Do not paste private keys into chat, commit them, or put them in public environment variables. `.env.example` lists the complete names, and `SECRET_ENV_MAP` permits the new RPC secrets.

| Owner input                                                                        | Used for                                                                                             |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Production PostgreSQL, Privy app credentials, exact HTTPS app origin, KMS resource | Persistent accounts, private contacts and authentication                                             |
| `ENS_MAINNET_RPC_URL`; `ENS_CHAIN_ID=1`; `ENS_ENABLED=true`                        | Existing mainnet names                                                                               |
| Sepolia parent name, two distinct funded Sepolia keys, `ENS_SEPOLIA_RPC_URL`       | ENSv2 bootstrap, name issuance and limited concierge writes                                          |
| Bootstrap output addresses                                                         | `ENS_PARENT_REGISTRY`, `ENS_CITY_REGISTRY_TOKYO`, `ENS_APP_RESOLVER`                                 |
| World production app ID, RP ID, RP signing key                                     | Real human verification and approval; `WORLD_ENVIRONMENT=production`                                 |
| World action `trip-activate` (production)                                          | One-time Proof of Human per account; approvals use World ID sessions and need no action              |
| Merchant EOA `PAYMENT_RECIPIENT`                                                   | Native 0G settlement destination; current verifier excludes contract treasuries                      |
| `PAYMENT_SOURCE_RPC_URL` for Base; `PAYMENT_RPC_URL` for 0G                        | Independent chain verification; 0G RPC must support call traces for internal transfers               |
| `SPLIT_NETWORK=base`; `SPLIT_RPC_URL`                                              | Real USDC table payments; retain network-specific RPCs for outstanding shares after a network switch |
| Seller, support and actual policy information                                      | Customer support and reconciliation                                                                  |

The payer needs Base USDC and Base ETH for membership checkout. ENS operator and concierge wallets need Sepolia ETH, not real ETH. A user writing mainnet ENS records needs Ethereum gas. ENS bootstrap, wallet transactions and paid purchases require the operator or user to review and sign the specific action; no unattended real purchase is part of this code change.

## Implementation requirements

### ENS

Keep mainnet account identity separate from the ENSv2 namespace adapter. Fresh resolution must point to a Privy-verified wallet. Description writes contain an immutable intent with account, chain, resolver, exact calldata and sender. Confirmation checks the successful canonical receipt and reads the resulting record again.

Bootstrap must validate the Sepolia chain, deployment code, distinct signing identities and namespace ownership. It deploys/mounts the app resolver and registries and restricts the concierge to its two supported record keys. A concierge description-write attempt must fail. Submitted transaction hashes must be durable before reconciliation, so a pending receipt or worker restart does not blindly repeat a registration. The worker must run alongside the web process.

### World

Use the current IDKit v4 server-signed RP context, with production pinned by the server. Accept only supported successful credential responses and require the exact expected action, signal and nonce. A browser success callback never establishes verification.

Store short-lived proof requests durably, bind them to the signed-in account and intended operation, and consume them atomically. World ID 4.0 uniqueness proofs are one-time per human per action. Trip activation therefore proves an account human once (`trip-activate`), stores the nullifier, and reuses it for every later trip; one human cannot verify a second account. The concierge link creates a World ID session and every approval proves that same session again (see WORLD-V4-FIX.md). Payload mutation, different account/human, replay, denial and expiration must not execute the protected action. Denial/expiration audit-state updates are allowed; business writes and blockchain writes are not.

### Membership payments

The installed 0G Pay wrapper fixes its destination to native 0G and does not expose every lifecycle callback. The server uses its underlying documented TokenFlight quote, deposit-build, submit and order endpoints. No `ethers` import enters the browser bundle.

The server fixes the price and Base USDC input, source wallet, treasury, destination network and native asset. It stores the returned route, quote ID, expiry, minimum output and permitted wallet transaction sequence as an immutable invoice obligation. The UI displays source amount, destination amount/network and gas responsibility before the user approves a wallet request.

Only supported transaction-shaped wallet requests may be executed. Browser transaction hashes trigger reconciliation. The server binds the independently fetched provider order to the stored quote/route/payer/source transaction, verifies the exact source transaction on Base, and independently verifies a successful canonical destination transfer with the configured confirmation depth to the treasury. An internal native transfer needs a successful call trace. Membership reconciliation uses at least 12 canonical confirmations on each chain, not the RPC finalized block tag. The operator must accept that confirmation policy before opening checkout; unlike bill splits, this path does not prove protocol finality. Callback data, provider “filled” status or a destination hash alone must never grant membership.

Preserve late or interrupted submissions for reconciliation instead of asking for another payment. Duplicate transaction/event evidence cannot pay another invoice. Unsupported quote formats, token paths, wallet requests, trace responses or contract treasuries fail closed. No recurring debit or infinite token allowance is introduced.

### Table splits

Resolve the host's trip name when the bill is created and freeze recipient, integer share amount, network and USDC contract. Lock the table's membership so later attendance changes cannot change an obligation silently. Freeze the selected linked payer and a minimum source block when preparing a payment. Network changes must not reinterpret an existing share.

Users sign exact ERC20 transfers. The server independently checks the intended network, canonical finalized receipt, exact sender/token/recipient/amount/calldata and a matching transfer log. A payment from before the obligation, a duplicate transaction, mock USDC or an unfinalized receipt cannot mark a share paid. Do not call this direct transfer path “0G Pay.”

## Deployment sequence

1. Build and test this branch. Review the exact migration and environment changes. Back up production PostgreSQL before applying migrations.
2. Set `ENS_SIMULATED=false`, `NFT_EMBEDDED_DB=false`, `APP_MODE=production` and `NEXT_PUBLIC_APP_MODE=production`. Production startup now rejects the former simulated public alpha and ephemeral database. The automatic first-two-wallet access grant is removed. Existing preview grants remain active until their recorded expiry, and are never represented as paid invoices. Use a dedicated production database or reconcile retained alpha data before rollout; do not silently delete users or grants. Preflight rejects retained nonproduction World proofs/identities and reports active preview grants for review.
3. Configure Privy, KMS, database and HTTPS. Configure the production World app and actions. Use the same public Privy app ID at build and runtime.
4. Configure the ENS parent and funded testnet wallets, then run `npm run ens:bootstrap` (use `--register-parent` only when intentionally registering the specified parent). Save its real output and set all generated addresses. Run `npm run ens:smoke`.
5. Set payment and split RPCs and the merchant recipient. Check live Base and 0G RPC chain IDs and confirm 0G trace support. Configure `PAYMENT_PROVIDER=0g-pay`; leave checkout disabled until the operator is ready to exercise the route.
6. Run `npm run db:migrate`. The journal includes the previously missing content and ENS/World migrations plus the new proof-request and split-obligation migrations. Both app and worker must run the same release.
7. Run `npm run integrations:check` and `npm run preflight -- --require-live-integrations`. These print configuration status without secrets. They do not manufacture live evidence. `--require-all-mainnet` deliberately fails because ENSv2 mainnet is unavailable.
8. Start/restart app and worker with the updated deployment configuration. Check `/api/health`, authenticated `/api/admin/integrations`, worker heartbeats and database persistence across a restart.
9. Run the live acceptance path below with operator-controlled accounts. Enable broad checkout only after a real receipt, correct entitlement and refund/support procedure have been verified.

## Live acceptance evidence

| Exercise                                                        | Evidence to capture                                                                                                   |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Existing mainnet ENS name link and permitted description update | Ethereum receipt; exact record readback; wrong-owner rejection                                                        |
| ENSv2 bootstrap + trip activation                               | Sepolia contract addresses, registration and record receipts, expiry and resolution                                   |
| World trip proof                                                | Production verifier success metadata and matching challenge/account; do not publish raw proofs or private identifiers |
| Link concierge, request seat, approve guest                     | Production World approval completion; single execution and actual table record receipt                                |
| Wrong human, tampered payload, duplicate proof                  | Rejection with unchanged business/on-chain state                                                                      |
| Denial and expiration                                           | Terminal approval audit state; zero protected side effects                                                            |
| Membership purchase                                             | Stored quote/order IDs, Base source hash, 0G settlement hash/trace, one entitlement and durable invoice               |
| Wrong recipient, asset, amount or order; early callback         | No entitlement                                                                                                        |
| Worker restart during payment and name issuance                 | Original submission resumes; no duplicate purchase or registration                                                    |
| Two-person USDC split                                           | Base/Ethereum transfer receipt; correct fixed share and single paid marker                                            |
| Interrupted mobile return and late settlement                   | Existing invoice recovery and reconciliation, no duplicate payment prompt                                             |

Update `docs/EVIDENCE.md` with real hashes and timestamps. Leave missing evidence explicitly unverified. Local fixtures prove rejection logic and state transitions; they do not establish provider acceptance or production finality.

## Official references checked September 26, 2026

- ENSv2 availability: https://ens.domains/ensv2
- ENS documentation: https://docs.ens.domains/
- World IDKit: https://docs.world.org/world-id/idkit/integrate
- World production approvals: https://docs.world.org/agents/human-in-the-loop/integrate
- World verifier contract: https://docs.world.org/api-reference/developer-portal/verify
- TokenFlight server API: https://embed.tokenflight.ai/reference/api-client
- TokenFlight backend verification: https://embed.tokenflight.ai/release/verification
- Circle native USDC addresses: https://developers.circle.com/stablecoins/usdc-contract-addresses
- 0G SDK behavior: pinned `@0gfoundation/0g-pay-sdk@0.2.1` source and its `@tokenflight/api` dependency in the lockfile.
