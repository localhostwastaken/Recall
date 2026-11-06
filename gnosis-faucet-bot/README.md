# Gnosis xDAI faucet monitor

A standalone Node.js 22.13+ TypeScript monitor for Gnosis **mainnet** (chain 100). It checks the configured wallet balance at startup and hourly, prints a JSON manual-action notification, and checks receipts for hashes you record. It never sends transactions, stores private keys, connects a wallet, or interacts with verification challenges.

## Faucet investigation (6 November 2026)

The [Gnosis mainnet documentation](https://docs.gnosischain.com/about/networks/mainnet) identifies xDAI, chain ID 100, the specified RPC, and the [official faucet](https://faucet.gnosischain.com/). The [faucet directory](https://docs.gnosischain.com/tools/Faucets) distinguishes it from the Chiado testnet faucet. The official documentation reviewed does not specify a claim frequency, complete eligibility rules, or a documented automation-compatible claim or eligibility API. The live faucet could not be reliably inspected in this environment; search results for its interface conflated mainnet and Chiado. Therefore the mainnet amount, cooldown, and verification requirements are **unconfirmed**. Consult the official mainnet page for current rules and complete any human verification, email verification, wallet connection or signature yourself if prompted. An hourly monitor is not permission to claim hourly.

No automated eligibility or cooldown determination is possible from the documented information found. The program reports both as `unknown`; its hourly notification requests manual review, not a claim and not an assertion of eligibility. No undocumented endpoint is used. Reassess the official documentation before adding any automated claim integration.

## Setup

```powershell
cd gnosis-faucet-bot
npm ci
Copy-Item .env.example .env
npm run build
npm start
```

Edit `.env` to change the RPC or wallet. `DRY_RUN=true` is the default. It still reads the RPC and creates/opens the SQLite database and schema, but does not add hashes or update receipt statuses. Set `DRY_RUN=false` to persist user-supplied transaction hashes and receipt status updates; it does not enable claims. Never put a private key in this application. Protect the database and `.env` as appropriate.

Commands after building:

```powershell
npm start -- check
npm start -- history
npm start -- record 0xYOUR_64_HEX_DIGIT_TRANSACTION_HASH
```

The last command requires `DRY_RUN=false`. After a manual claim, record the transaction hash reported by the faucet, then run `check` or wait for the next scheduled check. Pending hashes are checked again on later runs. `history` displays locally recorded entries; it is not a complete on-chain or faucet history. Duplicate hashes are rejected by a case-insensitive SQLite primary key. Notifications are structured JSON on stdout (errors on stderr); connect your own log collector if you need remote alerts. No email or other external notification is sent.

A successful receipt plus a positive **direct** native transfer to the configured address is marked `confirmed_transfer`. This establishes neither faucet origin nor finality; internal transfers, provenance and reorganizations are not verified. Reverted receipts are `failed`; missing receipts remain `pending`; other successful transactions are `unverified`. A fresh wallet balance is read after receipt checks. An RPC failure prevents that check and is logged; transient RPC calls are retried up to three times. The RPC's chain ID is checked before balance and receipt reads. The scheduler skips overlapping runs within one process, and waits for an active run during SIGINT/SIGTERM shutdown. Run only one scheduler process per database: there is no cross-process scheduler lock. This app does not submit claims, so duplicate-claim prevention consists of never issuing them and deduplicating recorded hashes.

Run `npm test` for local tests. `node:sqlite` is experimental in Node 22. RPC credentials in URLs are not intentionally logged, but avoid embedding secrets in configuration error messages or shared logs.
