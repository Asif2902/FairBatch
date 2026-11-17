# FairBatch Deployment Manifests (`deployments/`)

This directory stores structured, git-trackable deployment manifests containing public contract addresses, transaction hashes, block numbers, gas usage, initialization parameters, and block-explorer links.

> **Security Rule:** Private keys and RPC API tokens are **never** written to `deployments/*.json`. All secrets reside solely in the git-ignored root `.env` file.

## Files

| File | Purpose |
| :--- | :--- |
| [`sepolia.template.json`](./sepolia.template.json) | Reference JSON schema showing every field populated during an Ethereum Sepolia (`11155111`) deployment. |
| `sepolia.json` | Generated automatically by [`../scripts/deploy_sepolia.ps1`](../scripts/deploy_sepolia.ps1) upon live Sepolia deployment, and auto-detected by `fairbatch-backend` (`backend/src/chain.rs`). |

## How `deployments/sepolia.json` Is Generated

1. Add `DEPLOYER_PRIVATE_KEY=0x...` in the root `.env` file.
2. Preview offline (zero network calls):
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/deploy_sepolia.ps1 -DryRun
   ```
3. Execute live Sepolia deployment once authorized:
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/deploy_sepolia.ps1
   ```
   `deploy_sepolia.ps1` deploys `fWETH` (`18` decimals) + `fUSDC` (`6` decimals) when `DEPLOY_TEST_TOKENS=true`, deploys `FairBatch`, seeds `100 fWETH` + `300,000 fUSDC` initial FM-AMM liquidity, verifies `domainSeparator()`, `getReserves()`, and `currentBatch()` on-chain, writes `deployments/sepolia.json`, and syncs `.env` + `frontend/.env.local`.
