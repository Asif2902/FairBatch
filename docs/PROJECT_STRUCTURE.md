# FairBatch — Project Directory Map & Sepolia Deployment Guide

This guide documents every directory and configuration file in the FairBatch repository and shows the exact single line you edit to deploy FairBatch to **Ethereum Sepolia (`CHAIN_ID = 11155111`)**.

---

## 1. Complete Repository Layout

```text
FairBatch/
├── .env                                 # [GIT-IGNORED] Active Sepolia config (paste DEPLOYER_PRIVATE_KEY here!)
├── .env.example                         # Safe committed template for .env
├── fe.toml                              # Fe 26.5.0 ingot manifest (`fair_batch` v0.1.0)
├── README.md                            # Main project documentation, benchmarks & submission guide
│
├── src/                                 # Fe 26.5.0 Smart Contracts (Core Technical Contribution)
│   ├── types.fe                         # #[abi] structs, events, constants (MAX_ORDERS_PER_BATCH=64)
│   ├── math.fe                          # Zero-effect Wad (UFixed<18>), 18d/6d scaling & 512-bit mul_div
│   ├── clearing.fe                      # Zero-effect (`uses ()`) Hybrid CoW + FM-AMM batch solver
│   ├── intent.fe                        # Commit-reveal keccak_words + EIP-712 Domain & ERC-1271 verifier
│   ├── storage.fe                       # MarketConfig, PoolState & BatchMeta records
│   ├── lib.fe                           # FairBatch contract (granular uses, EIP-1153 Mutex, MulticallMsg)
│   ├── mock_erc20.fe                    # Configurable-decimal MockERC20 (18d fWETH / 6d fUSDC + blacklist)
│   └── tests.fe                         # 37 automated Fe unit, property, effect-mocked & EVM tests
│
├── out/                                 # [GIT-IGNORED] Compiled Fe 26.5.0 Sonatina EVM Artifacts
│   ├── FairBatch.bin                    # Creation bytecode (22,376 bytes)
│   ├── FairBatch.runtime.bin            # Static runtime bytecode (21,191 bytes; Cancun opcodes)
│   ├── FairBatch.abi.json               # Standard Ethereum JSON ABI
│   ├── MockERC20.bin                    # Test token creation bytecode
│   └── MockERC20.abi.json               # Test token JSON ABI
│
├── backend/                             # Rust Axum Solver, MEV Sandwich Simulator & RPC Bridge
│   ├── Cargo.toml                       # Crate manifest (`fairbatch-backend`)
│   └── src/
│       ├── main.rs                      # Loads root `.env` & binds HTTP server (`127.0.0.1:3001`)
│       ├── api.rs                       # All 15 `/api/*` REST endpoints
│       ├── clearing.rs                  # 256-bit WAD batch solver (atom-for-atom parity with src/clearing.fe)
│       ├── simulator.rs                 # Sequential Uniswap v2 + Optimal MEV Sandwich Bot simulator
│       ├── intent.rs                    # keccak256 commit-reveal + k256 secp256k1 EIP-712 engine
│       ├── chain.rs                     # `.env` parser, `deployments/sepolia.json` loader & RPC bridge
│       └── state.rs                     # Stateful batch lifecycle & 5 Demo Trader wallets
│
├── frontend/                            # Institutional React + TypeScript + TailwindCSS Terminal
│   ├── .env.example                     #Committed Vite env template
│   ├── .env.local                       # [GIT-IGNORED] Auto-synced with deployed Sepolia addresses
│   ├── package.json                     # Vite, React, TypeScript, TailwindCSS & Vitest scripts
│   └── src/
│       ├── App.tsx                      # Exchange terminal shell & live/fallback mode badge
│       ├── api.ts                       # Typed `/api/*` client + resilient browser fallback switch
│       ├── components/                  # PresetScenario, OrderTicket, PriceChart, MevComparison, ClaimsPanel...
│       ├── lib/                         # fallbackEngine.ts, keccak.ts, format.ts
│       └── __tests__/                   # 13 Vitest + Testing Library unit & E2E UI tests
│
├── config/                              # Network & Canonical Token Registry
│   └── networks.json                    # Sepolia (11155111), Hoodi (560048), Mainnet (1) & Anvil (31337)
│
├── deployments/                         # Public Deployment Manifests (Safe to Commit — Zero Secrets!)
│   ├── README.md                        # Manifest documentation
│   ├── sepolia.template.json            # Schema reference for Sepolia deployment output
│   └── sepolia.json                     # Auto-generated upon live Sepolia deployment
│
├── scripts/                             # PowerShell Verification, Deployment & Stack Automation
│   ├── check_setup.ps1                  # Verifies folders, toolchains, `out/` artifacts & `.env` readiness
│   ├── deploy_sepolia.ps1               # Sepolia deployment + reserve seeding (`-DryRun` & live modes)
│   ├── prepare_deployment.ps1           # Offline constructor & seedReserves calldata inspector
│   ├── verify_local_anvil.ps1           # Ephemeral local Cancun Anvil E2E bytecode & 5-seller verifier
│   └── start_stack.ps1                  # Launches `fairbatch-backend` + Vite frontend together
│
└── docs/                                # Formal Research & Engineering Documentation
    ├── PROJECT_STRUCTURE.md             # This file
    └── RESEARCH_AND_FEASIBILITY.md      # T1–T5 mathematical proofs, opcode audit & mainnet checklist
```

---

## 2. Step-by-Step Ethereum Sepolia Deployment Workflow

### Step 1 — Add Your Funded Sepolia Private Key to `.env`

Open `.env` in the repository root (created from **[`.env.example`](../.env.example)** and git-ignored so it will never be committed) and paste your funded Sepolia private key on the `DEPLOYER_PRIVATE_KEY=` line:

```ini
NETWORK=sepolia
CHAIN_ID=11155111
RPC_URL=https://ethereum-sepolia-rpc.publicnode.com

# Paste your funded Sepolia wallet private key here:
DEPLOYER_PRIVATE_KEY=0xYOUR_64_HEX_CHAR_SEPOLIA_PRIVATE_KEY
```

*(Optional)* If you prefer your own Alchemy, Infura, or QuickNode Sepolia endpoint, replace `RPC_URL=...` on the line right above it. Leave `DEPLOY_TEST_TOKENS=true` if you want the deployment script to automatically deploy 18-decimal `fWETH` + 6-decimal `fUSDC` test tokens and seed `100 fWETH` + `300,000 fUSDC` into the FairBatch FM-AMM pool in one run.

### Step 2 — Verify Readiness & Dry-Run (Zero Network Calls)

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/check_setup.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/deploy_sepolia.ps1 -DryRun
```

### Step 3 — Execute Live Sepolia Deployment

Once `DEPLOYER_PRIVATE_KEY` is saved in `.env`:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/deploy_sepolia.ps1
```

This script:
1. Verifies `eth_chainId == 11155111` and checks your Sepolia ETH balance (`>= 0.005 ETH`).
2. Signs canonical EIP-1559 (`0x02`) raw transactions in memory (cleanly bypassing Windows's 32KB CLI argument limit for `22.6 KB` `FairBatch.bin` creation payloads without ever printing your private key).
3. Deploys `fWETH` (`18` decimals), `fUSDC` (`6` decimals), and `FairBatch`, then calls `mintAndApprove` + `seedReserves(100e18, 300000e6)`.
4. Verifies `eth_getCode`, `domainSeparator()`, `getReserves()`, and `currentBatch()` live on Sepolia.
5. Writes [`deployments/sepolia.json`](../deployments/sepolia.json) (with Sepolia Etherscan links) and automatically updates `FAIRBATCH_ADDRESS`, `BASE_TOKEN_ADDRESS`, and `QUOTE_TOKEN_ADDRESS` in both `.env` and `frontend/.env.local`.

### Step 4 — Launch the Full Stack Connected to Sepolia

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start_stack.ps1
```

---

## 3. Live Ethereum Sepolia Deployment (`Chain ID 11155111`)

Recorded in [`deployments/sepolia.json`](../deployments/sepolia.json):

| Contract / Action | Address / Value | Transaction Hash | Block | Gas Used | Sepolia Etherscan |
| :--- | :--- | :--- | :---: | :---: | :--- |
| **`FairBatch` Exchange** | `0x60122518eccbeeb247cd42b0201f244432c7600d` | `0x017de9a5938f8c114db1515c17e9415a05375854bfe688a9c0f203f3f97c40d0` | `12156617` | `33,989,460` | [View Contract](https://sepolia.etherscan.io/address/0x60122518eccbeeb247cd42b0201f244432c7600d) |
| **`fWETH` (`18` decimals)** | `0xe72678fb21267fbb5c02c59496f04a86a7d8d56b` | `0xb236855f2e244088b50c362826ef2bb504a0eb3b826acc3302c9fe837172ca8e` | `12156615` | `2,192,556` | [View Token](https://sepolia.etherscan.io/address/0xe72678fb21267fbb5c02c59496f04a86a7d8d56b) |
| **`fUSDC` (`6` decimals)** | `0x0384fb6158fb2e5ea021af6f8fa3e81daeb075f0` | `0x67f7d5c3402f68db9a68dd708a602eb61e40cf55f2eee3e1a82e79f81195ed2f` | `12156616` | `2,192,556` | [View Token](https://sepolia.etherscan.io/address/0x0384fb6158fb2e5ea021af6f8fa3e81daeb075f0) |
| **`seedReserves(100e18, 300000e6)`** | `R_x = 100 fWETH`, `R_y = 300,000 fUSDC` | `0x402adb9c6fba6d31b2cfc701c47b3f0e2b3f57c1bf0ed9de35990212b50c2dfd` | `Mined` | `747,631` | [View Seed Tx](https://sepolia.etherscan.io/tx/0x402adb9c6fba6d31b2cfc701c47b3f0e2b3f57c1bf0ed9de35990212b50c2dfd) |

- **Deployer Account:** [`0x9AFe5CeF11fC10756faef213f7A30D9873B5d372`](https://sepolia.etherscan.io/address/0x9AFe5CeF11fC10756faef213f7A30D9873B5d372)
- **Verified On-Chain `domainSeparator()`:** `0xe718c08c5b766d15ba49f7fb773d29aae922828821cfe8a674a056a8c2b37dca` (`active_batch_id = 1`, `21,543` deployed runtime bytes)
