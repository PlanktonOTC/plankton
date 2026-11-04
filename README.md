# Plankton

Perpetuals on small-cap Robinhood Stock Tokens, on Robinhood Chain (4663), settled in USDG. Traders go long or short with isolated USDG margin against one LP pool, the Counter. Marks come from Chainlink equity feeds and Robinhood's public quotes, never from on-chain pools, and `closeAtMark` lets any trader exit with no backend at all.

## Layout

| Path | What it is |
| --- | --- |
| `contracts/` | Solidity (Foundry): `MarkOracle`, `Exchange` + `ExchangeLib`, `CounterVault`, `FeeRouter`, `PayoutDesk`, Backstop Fund and First-Loss tranche |
| `apps/mark` | Mark service: aggregates the sources and publishes signed marks |
| `apps/signer` | Signer service, one per key (quote or mark role) |
| `apps/api` | Public API: quotes, orders, `closeAtMark` calldata |
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

## Contracts

`bun run abi` regenerates `packages/chain/src/abis.ts` after `forge build`, so the backend can never drift from the contracts. Deployed addresses live in `deployments/4663.json`; `contracts/script/ConfigureMarkets.s.sol` registers the markets in `config/markets.json` (a new market is live in the owner's transaction; loosening the risk on a listed market waits 24 hours on-chain).

Not offered to US persons or residents of other restricted regions.
