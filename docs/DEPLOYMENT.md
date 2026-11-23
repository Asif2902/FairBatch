# FairBatch Hosting Guide

The exchange UI is a static Vite SPA. It talks to **Ethereum Sepolia** from the browser (`config/deployment.json`). Host it on **Render** or **Railway**. You do not need a VPS for the app to work.

**Live (Render, Ethereum Sepolia):**

- UI: https://app.fairbatch.xyz
- Keeper / relayer: https://fairbatch.onrender.com/health

The optional keeper/relayer is a separate always-on process. Skip it unless you want automatic `settleBatch()`. Users can still click **Start next round**.

---

## Render (static site)

1. Push this repo to GitHub.
2. In the Render dashboard: **New → Blueprint** and select the repo, or **New → Static Site**.
3. Blueprint file: [`render.yaml`](../render.yaml).

| Setting | Value |
| :--- | :--- |
| Runtime | Static site |
| Build command | `cd frontend && npm ci && npm run build` |
| Publish directory | `frontend/dist` |
| Node version | `22` (`NODE_VERSION` or [`.node-version`](../.node-version)) |
| SPA rewrite | `/*` → `/index.html` |

One-click: [Deploy to Render](https://render.com/deploy?repo=https://github.com/jubayir-hub-69/FairBatch).

Build must run from the **repo root** (not `frontend/` as Root Directory). `frontend/src/onchain/config.ts` imports `config/deployment.json` from the parent tree.

---

## Railway

1. Push this repo to GitHub.
2. New Empty Project → **Deploy from GitHub repo**.
3. Config file: [`railway.json`](../railway.json). Root [`package.json`](../package.json) builds the Vite app and serves `frontend/dist`.

| Setting | Value |
| :--- | :--- |
| Builder | Railpack |
| Build command | `npm run build` |
| Start command | `npm start` (`serve frontend/dist -s`, binds `$PORT`) |
| Node version | `22` ([`.node-version`](../.node-version)) |

Do not set the service root directory to `frontend/` — the build needs `config/` at the repo root.

Generate a public URL: **Settings → Networking → Generate Domain**.

---

## Optional VPS (`deploy.sh`)

Use this path only if you want Caddy + the keeper on a Linux VM.

Deploy the FairBatch web app (Simple + Pro + `/docs`) and the optional permissionless settlement keeper & EIP-712 intent relayer onto a fresh **Ubuntu 22.04**, **Ubuntu 24.04**, or **Debian 12** server using a single idempotent script: [`deploy.sh`](../deploy.sh).

Because all Fe `26.5.0` smart contracts are already deployed on **Ethereum Sepolia (`Chain ID 11155111`)** and read from [`config/deployment.json`](../config/deployment.json), the server **does not need the Fe compiler**.

---

## 1. Server Requirements

| Resource | Minimum | Recommended | Notes |
| :--- | :--- | :--- | :--- |
| **OS** | Ubuntu 22.04 LTS / Debian 12 | Ubuntu 24.04 LTS | Checked via `/etc/os-release`. |
| **CPU / RAM** | 1 vCPU, 1 GB RAM | 2 vCPU, 2 GB RAM | If RAM `< 2 GB`, `deploy.sh` offers to create a 2 GB `/swapfile` (or pass `--with-swap`). |
| **Disk** | 2 GB free | 10 GB+ free | Releases live in `/opt/fairbatch/releases/<timestamp>` (last 3 kept). |
| **Open Ports** | `22/tcp`, `80/tcp`, `443/tcp` | Same | Must be open in both your cloud firewall/security group and `ufw`. |
| **Keeper Bind** | `127.0.0.1:3002` (loopback) | Same | Exposed strictly via same-origin Caddy reverse proxy at `/keeper/*` (no CORS needed). |

---

## 2. Create & Fund a Dedicated Keeper Wallet

Never reuse a personal wallet or a wallet that holds real Ethereum mainnet ETH. Create a fresh throwaway Sepolia wallet:

```sh
# Option A (Node.js — no extra tools required):
node -e "console.log('0x' + require('node:crypto').randomBytes(32).toString('hex'))"

# Option B (Foundry cast):
cast wallet new
```

Derive its public address (without placing the key in shell history/argv):

```sh
printf '%s\n' '0xYOUR_64_HEX_KEY' | node deploy/lib/derive_address.mjs
```

Fund that public address with **`~0.10–0.20` Sepolia ETH** from a free public Sepolia faucet (e.g. Google Cloud Web3 Faucet or `sepolia-faucet.pk910.de`). If the balance drops below `KEEPER_MIN_BALANCE_ETH` (`0.005 ETH`), the keeper automatically pauses transactions and reports `"status": "degraded"` on `/keeper/health` while the exchange remains fully usable manually.

---

## 3. Exact Deployment Commands

### A. Interactive First-Time Deploy (Recommended)

```sh
git clone https://github.com/jubayir-hub-69/FairBatch.git
cd FairBatch
chmod +x deploy.sh
./deploy.sh
```

What `deploy.sh` does step-by-step:
1. **Preflight:** Verifies OS, root/sudo, free disk (`>= 2 GB`), RAM (offers a 2 GB swapfile if `< 2 GB`), auto-detects the keeper stack (`TypeScript` vs `Rust`), and installs only missing packages (`git`, `curl`, `ca-certificates`, `build-essential`, `pkg-config`, `libssl-dev`, `dnsutils`, Node.js LTS matching `frontend/package.json` `engines` via signed NodeSource apt repo, and Caddy via official signed apt repo — no `curl | bash`).
2. **Env & Secret Validation:** Validates every `# REQUIRED` variable from [`deploy/env.example`](../deploy/env.example). If `/etc/fairbatch/fairbatch.env` is missing or incomplete, lists **all** problems at once and offers either a hidden prompt (`read -rs`) that writes `/etc/fairbatch/fairbatch.env` (`umask 077`, `chmod 600`, owned by `fairbatch:fairbatch`, never inside the repo) or exits with manual instructions. Rejects zero/dummy keys and public Anvil/Hardhat default keys, derives the public address via stdin, checks Sepolia ETH balance, warns if the wallet holds Ethereum mainnet ETH, verifies RPC `chainId == 11155111`, and verifies on-chain bytecode (`eth_getCode`) for every contract in `config/deployment.json`.
3. **Release Build:** Builds the frontend with relative `VITE_KEEPER_URL=/keeper` (so switching from IP to domain or changing domains never requires a rebuild) and builds the keeper into `/opt/fairbatch/releases/<YYYYMMDD-HHMMSS>`, then atomically switches `/opt/fairbatch/current`.
4. **Live IP Mode First:** Installs the hardened systemd unit ([`deploy/fairbatch-keeper.service.tmpl`](../deploy/fairbatch-keeper.service.tmpl)), renders Caddy in HTTP IP mode ([`deploy/Caddyfile.ip.tmpl`](../deploy/Caddyfile.ip.tmpl)), stages `ufw` rules (`22`, `80`, `443`; only enables if SSH 22 is verified and you confirm), and checks `200 OK` on `/`, `/docs`, and `/keeper/health`.
5. **Optional Domain + HTTPS:** Guides you through DNS records, verifies `dig` against `1.1.1.1` and `8.8.8.8`, switches Caddy to automatic Let's Encrypt HTTPS ([`deploy/Caddyfile.domain.tmpl`](../deploy/Caddyfile.domain.tmpl)), and polls `https://<domain>` for up to 2 minutes (falling back cleanly to IP mode if HTTPS fails).

### B. Non-Interactive / Automated Flags

Every prompt has a CLI flag:

```sh
# Dry run (validates env, RPC, contracts & prints planned steps; never mutates system or prints secrets)
./deploy.sh --dry-run --no-domain --yes

# Deploy in IP mode only, non-interactively (with automatic 2GB swap on small VPS)
./deploy.sh --no-domain --with-swap --yes

# Deploy directly with a custom domain + www redirect + test suite
./deploy.sh --domain swap.example.com --www-redirect --run-tests --yes
```

---

## 4. DNS Table & Cloudflare Instructions

Replace `203.0.113.42` with your server's public IPv4 printed by `deploy.sh`:

| Type | Host / Name | Value | Required? | Notes |
| :---: | :--- | :--- | :---: | :--- |
| **`A`** | `@` (or subdomain, e.g. `swap`) | `<SERVER_IPV4>` | **Yes** | Must match on both `1.1.1.1` and `8.8.8.8`. |
| **`A`** or **`CNAME`** | `www` | `<SERVER_IPV4>` (or `CNAME` -> `<domain>`) | Optional | Needed only if you enabled `www.<domain>` redirect. |
| **`AAAA`** | `@` (and `www`) | `<SERVER_IPV6>` *(or delete if none)* | **Caution** | **Remove any stale `AAAA` record** that does not point to this server — Let's Encrypt tries IPv6 first and will fail ACME certificate issuance if `AAAA` is stale. |

### Cloudflare Users (Important!)

1. **Initial setup:** Turn the Cloudflare proxy **OFF** (**"DNS only"** / grey cloud) so Caddy can complete Let's Encrypt HTTP-01 validation directly against your server. `deploy.sh` automatically detects Cloudflare proxy IPs (`104.16.0.0/13`, `172.64.0.0/13`, etc.) and pauses with guidance if the orange cloud is on too early.
2. **After HTTPS works:** If you want Cloudflare DDoS/CDN protection later, turn the proxy **ON** (orange cloud) and immediately set **SSL/TLS -> Overview -> Full (strict)**. **Never use "Flexible"**, because Caddy redirects HTTP -> HTTPS and Cloudflare Flexible talks HTTP to the origin, causing an infinite redirect loop.

---

## 5. Day-2 Operations: Status, Update & Rollback

Non-secret deployment state (`DEPLOY_MODE`, `DEPLOY_DOMAIN`, `DEPLOY_WWW_REDIRECT`, `DEPLOY_KEEPER_PORT`, `DEPLOY_LAST_RELEASE`) is stored in `/etc/fairbatch/deploy.conf`.

```sh
# Inspect active release, service status, live URLs, and keeper Sepolia ETH balance
./deploy.sh --status

# Zero-downtime update: git pull --ff-only -> build new release -> swap & restart -> health check
# If the health check fails, deploy.sh AUTOMATICALLY restores the previous release!
./deploy.sh --update --yes

# Instant rollback to the previous release (last 3 releases are retained)
./deploy.sh --rollback --yes
```

Inspect live logs on the server:

```sh
sudo journalctl -u fairbatch-keeper -f
sudo journalctl -u caddy -n 50 --no-pager
```

---

## 6. Security Notes

- **Secrets stay outside the repo:** `/etc/fairbatch/fairbatch.env` is created with `umask 077`, `chmod 600`, owned by `fairbatch:fairbatch`. `deploy.sh` never runs `set -x`, never echoes secret values, never passes `KEEPER_PRIVATE_KEY` on a command line (address derivation reads from stdin), and refuses to write secrets inside the git repository.
- **Hardened systemd unit:** Runs under non-login user `fairbatch` with `NoNewPrivileges=true`, `ProtectSystem=strict`, `ProtectHome=true`, `PrivateTmp=true`, `CapabilityBoundingSet=`, and loopback-only binding (`KEEPER_HOST=127.0.0.1`).
- **Same-origin `/keeper/*` proxy:** Caddy strips `/keeper` and proxies strictly to `127.0.0.1:3002`, avoiding CORS configuration and allowing seamless IP -> domain migration without rebuilding the frontend.
- **No restrictive CSP by default:** Basic security headers (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, plus `HSTS` in HTTPS mode) are enabled; a strict `Content-Security-Policy` is intentionally omitted unless tested against your target wallet extensions and custom Sepolia RPC URLs (which vary by user wallet).
- **Least-privilege keeper wallet:** Keep only small testnet ETH (`~0.10 Sepolia ETH`) in the keeper wallet; it has zero admin rights over FairBatch contracts.

---

## 7. Troubleshooting

| Symptom | Likely Cause | Fix |
| :--- | :--- | :--- |
| HTTPS poll times out after DNS matches | Cloud firewall / AWS Security Group / DigitalOcean Firewall blocking TCP `80` or `443` | Open inbound TCP `80` and `443` in your cloud provider dashboard and re-run `./deploy.sh --domain <domain>`. |
| Let's Encrypt fails with connection refused / 404 | Stale `AAAA` (IPv6) DNS record pointing to a different host | Delete the stale `AAAA` record at your DNS provider (`dig @1.1.1.1 <domain> AAAA` should be empty or match your server). |
| Infinite redirect loop (`ERR_TOO_MANY_REDIRECTS`) | Cloudflare proxy enabled with SSL/TLS mode = `Flexible` | Switch Cloudflare SSL/TLS to **Full (strict)**. |
| `/keeper/health` shows `"status": "degraded"` / `"lowBalance": true` | Keeper Sepolia ETH dropped below `0.005 ETH` | Send Sepolia ETH to the keeper public address shown by `./deploy.sh --status`. |
| Build killed with `SIGKILL` / `ENOMEM` | Server has `< 2 GB` RAM and no swap | Re-run with `./deploy.sh --with-swap`. |
