# FairBatch Optional Keeper & Relayer (`keeper/`)

> **Optional infrastructure — adds liveness, not trust.**  
> FairBatch works completely without this service. Anyone can still click **Start next round** (`settleBatch()`), slash expired commitments (`slashUnrevealed()`), or submit their own EIP-712 signed intent (`submitSignedIntent()`). The keeper has **zero admin privileges**: it cannot change clearing prices, reorder batches, or touch user funds.

---

## Why TypeScript (`viem`) Instead of `backend/` (Rust)

We inspected `backend/` (`fairbatch-backend`, Rust) first: it is an off-chain parity verifier and MEV simulator that only forwards pre-signed raw transactions (`eth_sendRawTransaction`) — it does not contain an EIP-1559 transaction signer, nonce manager, or polling loop. Building `keeper/` as a small TypeScript service using `viem` lets it share the exact same ABI signatures and `config/deployment.json` + `config/networks.json` RPC fallbacks as the frontend with minimal code.

---

## Trust Model

- **Settlement keeper (`settleBatch`):** Polls `currentBatch()` and the latest block timestamp every ~2 seconds. When a non-empty batch becomes `Ready`, it waits `KEEPER_GRACE_SECONDS` (default **5s**) so any public caller can settle first, re-checks on-chain state, simulates `settleBatch()` via `eth_call`, and submits only if still unsettled. Public race conditions (`Batch already settled`) are handled quietly. Empty `Ready` batches are settled at most once every `KEEPER_EMPTY_ROUND_MINUTES` (default **10 min**) and only while balance exceeds `KEEPER_MIN_BALANCE_ETH`.
- **Slash keeper (`slashUnrevealed`):** Enabled by default (`KEEPER_SLASH=true`). After `KEEPER_SLASH_GRACE_SECONDS` (default **60s**) past `reveal_deadline`, slashes expired unrevealed commitments. The forfeited `0.0001 ETH` reveal bond is paid directly to the keeper wallet, helping offset its gas spend.
- **No arbitrary tx surface:** `GET /health` is strictly read-only. No HTTP endpoint can cause the keeper to sign or broadcast arbitrary transactions.
- **Dedicated low-balance wallet:** Always fund a dedicated keeper address with a small amount of Sepolia ETH (e.g., `0.05–0.15 ETH`) rather than a main wallet. If the balance drops below `KEEPER_MIN_BALANCE_ETH` (`0.005 ETH`), the keeper stops sending transactions, logs `low_balance_guard_triggered`, and marks `/health` as `degraded`.

---

## Configuration (`keeper/.env`)

Copy `keeper/.env.example` to `keeper/.env` (git-ignored):

| Variable | Default | Description |
| :--- | :--- | :--- |
| `KEEPER_PRIVATE_KEY` | *(required unless `--dry-run`)* | Dedicated low-balance Sepolia wallet private key (`0x` + 64 hex chars). |
| `KEEPER_RPC_URL` | `config/deployment.json` | Optional primary Sepolia RPC override (automatically falls back to `config/networks.json` fallbacks). |
| `KEEPER_POLL_MS` | `2000` | Polling interval in milliseconds. |
| `KEEPER_GRACE_SECONDS` | `5` | Seconds to wait after `revealDeadline` so the public can settle first. |
| `KEEPER_EMPTY_ROUND_MINUTES` | `10` | Minimum minutes between settling empty `Ready` rounds. |
| `KEEPER_SLASH` | `true` | Automatically slash expired unrevealed commitments (`true` / `false`). |
| `KEEPER_SLASH_GRACE_SECONDS` | `60` | Seconds after `revealDeadline` before slashing an unrevealed commitment. |
| `KEEPER_MIN_BALANCE_ETH` | `0.005` | Minimum ETH balance guard; pauses all tx sending below this threshold. |
| `KEEPER_MAX_GAS_PRICE_GWEI` | `50` | Maximum EIP-1559 `maxFeePerGas` cap. |
| `KEEPER_SETTLE_GAS_LIMIT` | `12000000` | Upper gas limit for `settleBatch()` (sized for Sepolia EIP-8037 state-creation pricing). |
| `KEEPER_SLASH_GAS_LIMIT` | `600000` | Upper gas limit for `slashUnrevealed()`. |
| `KEEPER_PORT` | `3002` | Port for `GET /health` (and optional `POST /relay/intent`). |
| `KEEPER_CORS_ORIGIN` | `http://localhost:5173` | Comma-separated allowed browser origins. |
| `KEEPER_DRY_RUN` | `false` | Log decisions without sending any transactions (`--dry-run` CLI flag also enables this). |

---

## Run Locally & Test

```sh
cd keeper
npm ci
npm test                 # Unit tests for grace timing, public races, empty rounds, low balance & slashing
npm run build            # TypeScript compile to dist/

# Offline/read-only dry-run (no private key required):
npm run dry-run

# Live keeper (requires KEEPER_PRIVATE_KEY in keeper/.env or environment):
npm run start
```

Connect the frontend to a running keeper (optional):

```sh
cd frontend
VITE_KEEPER_URL=http://localhost:3002 npm run dev
```

When `VITE_KEEPER_URL` responds healthy on `/health`, Simple mode shows *"Round closed — settling automatically in about 5s"*. If the keeper is absent, offline, or degraded, Simple mode seamlessly falls back to the manual **Start next round** button.

---

## Hosting Steps (Docker / Railway / Fly.io / Render)

1. **Create a dedicated Sepolia keeper wallet** (do NOT reuse a personal wallet):
   ```sh
   cast wallet new
   ```
2. **Fund the keeper address with ~0.10 Sepolia ETH** from a public Sepolia faucet (e.g. Google Cloud Web3 Faucet or `sepolia-faucet.pk910.de`).
3. **Build and run the Docker image from the repository root** (build context must be the repo root so `config/deployment.json` is included):
   ```sh
   docker build -f keeper/Dockerfile -t fairbatch-keeper .
   docker run -d --name fairbatch-keeper --restart unless-stopped \
     -p 3002:3002 \
     -e KEEPER_PRIVATE_KEY="0xYOUR_DEDICATED_SEPOLIA_KEY" \
     -e KEEPER_CORS_ORIGIN="https://your-frontend-domain.example" \
     fairbatch-keeper
   ```
4. **Cloud PaaS (Fly.io / Railway / Render):**
   - Point the service to the repo root with Dockerfile path `keeper/Dockerfile` and port `3002`.
   - Set secret environment variable `KEEPER_PRIVATE_KEY` in the platform's secret manager (never commit it).
   - Set `KEEPER_CORS_ORIGIN` to your deployed frontend origin and configure health checks on `GET /health`.
   - Optionally set `VITE_KEEPER_URL=https://your-keeper-host.example` when building the frontend.
