# Plankton

Perpetuals on small-cap Robinhood Stock Tokens, on Robinhood Chain (4663), settled in USDG. Traders go long or short with isolated USDG margin against one LP pool, the Counter. Marks come from Chainlink equity feeds and Robinhood's public quotes, never from on-chain pools, and `closeAtMark` lets any trader exit with no backend at all.

**CA:** `0x9f0692785990bcb7f8c36d979a86fe5fcf31c7c3`

## Layout

| Path | What it is |
| --- | --- |
| `contracts/` | Solidity (Foundry): `MarkOracle`, `Exchange` + `ExchangeLib`, `CounterVault`, `FeeRouter`, `PayoutDesk`, Backstop Fund and First-Loss tranche |
| `apps/mark` | Mark service: aggregates the sources and publishes signed marks |
| `apps/signer` | Signer service, one per key (quote or mark role) |
| `apps/api` | Public API: quotes, orders, `closeAtMark` calldata, the price feed, the Tape's market context and the MCP server |
| `apps/keeper` | Executes trader-signed orders, liquidations and vault settlement |
| `apps/indexer` | Indexes contract events into Postgres |
| `packages/` | Shared code: `core` (pricing, risk, sessions), `chain` (ABIs, typed data, reads), `db`, `ingest`, `config` |
| `web/` | Website and trading terminal (React + Vite) |
| `config/` | Markets, market data and the exchange calendar |

## Setup

Needs [Bun](https://bun.sh) 1.4+, [Foundry](https://getfoundry.sh) and Postgres 16 for the services.

```sh
git clone <repo>
bun install
cp .env.example .env   # then fill it in
```

The contract libraries (forge-std, OpenZeppelin) are vendored in `contracts/lib`, so there is nothing else to fetch.

## Test

```sh
cd contracts && forge test     # contracts
bun run typecheck              # TypeScript
bun run test                   # packages and apps
bun run test:web               # website
```

## Run

```sh
bun run db:migrate
bun run dev:signer    # once per signing key
bun run dev:mark
bun run dev:api
bun run dev:keeper
bun run dev:indexer
bun run dev:web
```

## Public market data

Read-only routes that need no key and allow any origin:

| Route | What it returns |
| --- | --- |
| `GET /v1/feed`, `/v1/feed/:symbol` | The on-chain mark for each market, with its age and an ETag |
| `GET /v1/scanner` | Runner scanner: change, gap, extended-hours move, volume against the 30-day average, float turnover, 52-week range and signal tags |
| `GET /v1/halts` | Nasdaq trading halts over the last three days with reasons in words; `?listed=1` for our markets only |
| `GET /v1/filings`, `/v1/filings/:symbol` | SEC EDGAR filings for listed companies, tagged (offering, shelf, dilution, charter change, listing notice...); `?flagged=1` keeps medium and high importance |
| `GET /v1/catalysts` | Next earnings date, timing and estimate, the last quarter's surprise, and Stock Token corporate actions |

Each Tape source is cached in the API and refreshed in the background, so a slow upstream shows as an older `updatedAt` rather than an error. Filings need each market's `secCik` in `config/markets.json`.

`POST /mcp` is a read-only Model Context Protocol server (HTTP, JSON answers, no sessions). Its tools (`list_markets`, `get_prices`, `get_price_sources`, `get_scanner`, `get_halts`, `get_filings`, `get_catalysts`, `preview_trade`, `get_account`, `get_leaderboard`, `get_solvency`, `get_listing_rules`) read the routes above in-process under the caller's rate limit. It signs nothing and sends no transactions.

## Contracts

`bun run abi` regenerates `packages/chain/src/abis.ts` after `forge build`, so the backend can never drift from the contracts. Deployed addresses live in `deployments/4663.json`; `contracts/script/ConfigureMarkets.s.sol` registers the markets in `config/markets.json` (a new market is live in the owner's transaction; loosening the risk on a listed market waits 24 hours on-chain).

Not offered to US persons or residents of other restricted regions.
