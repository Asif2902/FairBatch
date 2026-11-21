#!/usr/bin/env bash
# ==============================================================================
# FairBatch Single-Script Server Deployment (Ubuntu 22.04/24.04 & Debian 12)
#
# Deploys the static React/Vite frontend (relative /keeper proxy, SPA /docs)
# and the optional permissionless keeper + EIP-712 intent relayer under systemd
# + Caddy with automatic Let's Encrypt HTTPS for an optional custom domain.
#
# Contracts are already deployed on Ethereum Sepolia (config/deployment.json),
# so the Fe compiler is NOT required on the server.
#
# Security invariants:
#   - NEVER runs with `set -x`
#   - NEVER prints secret values or passes secrets via command-line arguments
#   - NEVER writes secrets inside the repository directory
# ==============================================================================
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_DIR="$SCRIPT_DIR"

# System paths (overridable via flags or env for isolated tests)
OS_RELEASE_FILE="${FAIRBATCH_OS_RELEASE:-/etc/os-release}"
BASE_DIR="${FAIRBATCH_BASE_DIR:-/opt/fairbatch}"
ENV_FILE="${FAIRBATCH_ENV_FILE:-/etc/fairbatch/fairbatch.env}"
CONF_FILE="${FAIRBATCH_CONF_FILE:-/etc/fairbatch/deploy.conf}"
SYSTEMD_DIR="${FAIRBATCH_SYSTEMD_DIR:-/etc/systemd/system}"
CADDYFILE_PATH="${FAIRBATCH_CADDYFILE:-/etc/caddy/Caddyfile}"
STATE_DIR="${FAIRBATCH_STATE_DIR:-/var/lib/fairbatch}"
SERVICE_USER="${FAIRBATCH_SERVICE_USER:-fairbatch}"
SERVICE_GROUP="${FAIRBATCH_SERVICE_GROUP:-fairbatch}"
MOCK_MODE="${FAIRBATCH_MOCK_MODE:-0}"

# CLI flags (every interactive prompt has a non-interactive flag)
FLAG_DOMAIN=""
FLAG_NO_DOMAIN=0
FLAG_WWW_REDIRECT="" # "yes" | "no" | ""
FLAG_YES=0
FLAG_UPDATE=0
FLAG_ROLLBACK=0
FLAG_STATUS=0
FLAG_DRY_RUN=0
FLAG_WITH_SWAP=0
FLAG_RUN_TESTS=0
FLAG_ENABLE_UFW=0
DNS_RETRY_WAIT_SECS="${FAIRBATCH_DNS_RETRY_WAIT_SECS:-30}"
DNS_MAX_AUTO_RETRIES="${FAIRBATCH_DNS_MAX_AUTO_RETRIES:-10}"
HTTPS_POLL_TIMEOUT_SECS="${FAIRBATCH_HTTPS_POLL_TIMEOUT_SECS:-120}"
HTTPS_POLL_INTERVAL_SECS="${FAIRBATCH_HTTPS_POLL_INTERVAL_SECS:-5}"

# Runtime state
declare -A ENV_VALUES=()
declare -a ENV_ERRORS=()
KEEPER_TYPE=""
NODE_TARGET_MAJOR="22"
KEEPER_PUBLIC_ADDRESS=""
KEEPER_SEPOLIA_ETH="0"
KEEPER_MAINNET_ETH="0"
SERVER_IPV4=""
SERVER_IPV6=""
ACTIVE_RELEASE_ID=""
DEPLOY_MODE="ip"
DEPLOY_DOMAIN=""
DEPLOY_WWW_REDIRECT="no"
DEPLOY_KEEPER_PORT="3002"

# Known public Anvil / Hardhat / Foundry default private keys (MUST be rejected)
readonly -a FORBIDDEN_PUBLIC_KEYS=(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a"
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba"
  "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e"
  "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356"
  "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97"
  "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6"
)

# Official Cloudflare IPv4 proxy CIDRs (https://www.cloudflare.com/ips-v4)
readonly -a CLOUDFLARE_IPV4_CIDRS=(
  "173.245.48.0/20"
  "103.21.244.0/22"
  "103.22.200.0/22"
  "103.31.4.0/22"
  "141.101.64.0/18"
  "108.162.192.0/18"
  "190.93.240.0/20"
  "188.114.96.0/20"
  "197.234.240.0/22"
  "198.41.128.0/17"
  "162.158.0.0/15"
  "104.16.0.0/13"
  "104.24.0.0/14"
  "172.64.0.0/13"
  "131.0.72.0/22"
)

# ------------------------------------------------------------------------------
# Logging & error helpers (NEVER print secrets)
# ------------------------------------------------------------------------------
log_info()  { printf '[INFO]  %s\n' "$*"; }
log_ok()    { printf '[OK]    %s\n' "$*"; }
log_warn()  { printf '[WARN]  %s\n' "$*" >&2; }
log_err()   { printf '[ERROR] %s\n' "$*" >&2; }
log_step()  { printf '\n=== %s ===\n' "$*"; }
log_dry()   { printf '[DRY-RUN] Would: %s\n' "$*"; }

on_error() {
  local exit_code="$?"
  local line_no="${1:-unknown}"
  log_err "deploy.sh failed at line ${line_no} (exit ${exit_code})."
  exit "$exit_code"
}
trap 'on_error "$LINENO"' ERR

usage() {
  cat <<'EOF'
Usage: ./deploy.sh [OPTIONS]

One-script deployment for FairBatch (frontend + optional keeper/relayer) on
Ubuntu 22.04/24.04 or Debian 12. Contracts are already deployed on Sepolia.

Options:
  --domain <name>     Attach HTTPS domain non-interactively (e.g. swap.example.com)
  --no-domain         Stay in IP/HTTP mode without prompting for a domain
  --www-redirect      Redirect www.<domain> -> <domain> (with --domain)
  --no-www-redirect   Do not configure a www redirect
  --yes, -y           Run non-interactively (accept safe defaults)
  --with-swap         Create a 2GB /swapfile automatically if RAM < 2GB
  --run-tests         Run frontend and keeper tests during the release build
  --enable-ufw        Allow 22/80/443 and enable ufw (only if SSH 22 is allowed)
  --update            Git pull, build new release, health-check, swap & restart
                      (keeps previous release if the health check fails)
  --rollback          Switch back to the previous release and restart services
  --status            Print live URLs, release ID, service status & keeper balance
  --dry-run           Validate env/RPC/contracts and show planned actions only
  --env-file <path>   Override env file path (default: /etc/fairbatch/fairbatch.env)
  --conf-file <path>  Override deploy.conf path (default: /etc/fairbatch/deploy.conf)
  --base-dir <path>   Override install root (default: /opt/fairbatch)
  --help, -h          Show this help message
EOF
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --domain)
        [[ $# -ge 2 ]] || { log_err "--domain requires a hostname argument."; exit 2; }
        FLAG_DOMAIN="$2"
        shift 2
        ;;
      --no-domain)
        FLAG_NO_DOMAIN=1
        shift
        ;;
      --www-redirect)
        FLAG_WWW_REDIRECT="yes"
        shift
        ;;
      --no-www-redirect)
        FLAG_WWW_REDIRECT="no"
        shift
        ;;
      --yes|-y)
        FLAG_YES=1
        shift
        ;;
      --update)
        FLAG_UPDATE=1
        shift
        ;;
      --rollback)
        FLAG_ROLLBACK=1
        shift
        ;;
      --status)
        FLAG_STATUS=1
        shift
        ;;
      --dry-run)
        FLAG_DRY_RUN=1
        shift
        ;;
      --with-swap)
        FLAG_WITH_SWAP=1
        shift
        ;;
      --run-tests)
        FLAG_RUN_TESTS=1
        shift
        ;;
      --enable-ufw)
        FLAG_ENABLE_UFW=1
        shift
        ;;
      --env-file)
        [[ $# -ge 2 ]] || { log_err "--env-file requires a path."; exit 2; }
        ENV_FILE="$2"
        shift 2
        ;;
      --conf-file)
        [[ $# -ge 2 ]] || { log_err "--conf-file requires a path."; exit 2; }
        CONF_FILE="$2"
        shift 2
        ;;
      --base-dir)
        [[ $# -ge 2 ]] || { log_err "--base-dir requires a path."; exit 2; }
        BASE_DIR="$2"
        shift 2
        ;;
      --help|-h)
        usage
        exit 0
        ;;
      *)
        log_err "Unknown option: $1"
        usage
        exit 2
        ;;
    esac
  done

  if [[ -n "$FLAG_DOMAIN" && "$FLAG_NO_DOMAIN" -eq 1 ]]; then
    log_err "Cannot combine --domain and --no-domain."
    exit 2
  fi
}

# Privilege runner (uses sudo when non-root; bypassed in MOCK_MODE)
run_priv() {
  if [[ "$MOCK_MODE" == "1" || "${EUID:-$(id -u)}" -eq 0 ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

prompt_yes_no() {
  local question="$1"
  local default_ans="${2:-N}" # Y or N
  local reply=""

  if [[ "$FLAG_YES" -eq 1 || ! -t 0 ]]; then
    [[ "$default_ans" == "Y" ]]
    return $?
  fi

  local hint="[y/N]"
  [[ "$default_ans" == "Y" ]] && hint="[Y/n]"
  printf '%s %s ' "$question" "$hint"
  IFS= read -r reply || reply=""
  reply="${reply:-$default_ans}"
  [[ "${reply,,}" == "y" || "${reply,,}" == "yes" ]]
}

# ==============================================================================
# Pure / Unit-Testable Functions
# ==============================================================================

detect_keeper_type() {
  local repo="${1:-$REPO_DIR}"
  if [[ -f "${repo}/keeper/Cargo.toml" ]]; then
    printf 'rust\n'
  elif [[ -f "${repo}/keeper/package.json" ]]; then
    printf 'typescript\n'
  else
    return 1
  fi
}

parse_required_node_major() {
  local pkg_json="${1:-${REPO_DIR}/frontend/package.json}"
  if [[ ! -f "$pkg_json" ]]; then
    printf '22\n'
    return 0
  fi
  local engines_line=""
  engines_line="$(grep -E '"node"[[:space:]]*:' "$pkg_json" | head -n 1 || true)"
  if [[ -z "$engines_line" ]]; then
    printf '22\n'
    return 0
  fi
  # Choose highest LTS matching the declared engines range (prefer 22 LTS if allowed)
  if [[ "$engines_line" == *"<23"* || "$engines_line" == *"22"* ]]; then
    printf '22\n'
  elif [[ "$engines_line" == *"20"* ]]; then
    printf '20\n'
  else
    printf '22\n'
  fi
}

normalize_domain() {
  local raw="${1:-}"
  local d="$raw"
  # Trim whitespace
  d="${d#"${d%%[![:space:]]*}"}"
  d="${d%"${d##*[![:space:]]}"}"
  # Lowercase
  d="${d,,}"
  # Strip scheme (http://, https://)
  d="${d#http://}"
  d="${d#https://}"
  # Strip path/query/fragment
  d="${d%%/*}"
  d="${d%%\?*}"
  d="${d%%#*}"
  # Strip optional port
  if [[ "$d" != *:*:* ]]; then
    d="${d%%:*}"
  fi
  # Strip trailing dot(s)
  while [[ "$d" == *. ]]; do
    d="${d%.}"
  done
  printf '%s\n' "$d"
}

is_ipv4_address() {
  local ip="${1:-}"
  if [[ ! "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
    return 1
  fi
  local IFS='.'
  local -a octets=()
  read -r -a octets <<< "$ip"
  local o
  for o in "${octets[@]}"; do
    if (( 10#$o > 255 )); then
      return 1
    fi
  done
  return 0
}

is_ipv6_address() {
  local ip="${1:-}"
  ip="${ip#[}"
  ip="${ip%]}"
  [[ "$ip" == *:* && "$ip" =~ ^[0-9a-fA-F:]+$ ]]
}

validate_domain() {
  local domain="${1:-}"
  # Reject empty, > 253 chars, IPv4, IPv6, missing dot, spaces, underscores
  if [[ -z "$domain" || "${#domain}" -gt 253 ]]; then
    return 1
  fi
  if is_ipv4_address "$domain" || is_ipv6_address "$domain"; then
    return 1
  fi
  if [[ "$domain" != *.* ]]; then
    return 1
  fi
  if [[ "$domain" == .* || "$domain" == *. || "$domain" == *..* ]]; then
    return 1
  fi

  local IFS='.'
  local -a labels=()
  read -r -a labels <<< "$domain"
  if [[ "${#labels[@]}" -lt 2 ]]; then
    return 1
  fi

  local label
  for label in "${labels[@]}"; do
    if [[ -z "$label" || "${#label}" -gt 63 ]]; then
      return 1
    fi
    if [[ ! "$label" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]]; then
      return 1
    fi
  done

  # TLD must be alphabetic (or xn-- punycode) and >= 2 chars
  local tld="${labels[$(( ${#labels[@]} - 1 ))]}"
  if [[ ! "$tld" =~ ^([a-z]{2,63}|xn--[a-z0-9-]{2,59})$ ]]; then
    return 1
  fi
  return 0
}

extract_required_env_keys() {
  local template="${1:-${REPO_DIR}/deploy/env.example}"
  [[ -f "$template" ]] || return 1
  local line key
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    if [[ "$line" == *"# REQUIRED"* && "$line" == *"="* ]]; then
      key="${line%%=*}"
      key="${key#"${key%%[![:space:]]*}"}"
      key="${key%"${key##*[![:space:]]}"}"
      if [[ -n "$key" ]]; then
        printf '%s\n' "$key"
      fi
    fi
  done < "$template"
}

extract_default_for_key() {
  local template="$1"
  local target_key="$2"
  local line key val
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" != *"="* ]] && continue
    key="${line%%=*}"
    key="${key#"${key%%[![:space:]]*}"}"
    key="${key%"${key##*[![:space:]]}"}"
    if [[ "$key" == "$target_key" ]]; then
      val="${line#*=}"
      # Strip inline comment
      val="${val%%#*}"
      val="${val#"${val%%[![:space:]]*}"}"
      val="${val%"${val##*[![:space:]]}"}"
      printf '%s\n' "$val"
      return 0
    fi
  done < "$template"
  printf '\n'
}

parse_env_file_safe() {
  local file="$1"
  ENV_VALUES=()
  [[ -f "$file" ]] || return 1
  local line key val
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    # Skip blanks & comments
    [[ "$line" =~ ^[[:space:]]*$ ]] && continue
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" != *"="* ]] && continue
    key="${line%%=*}"
    val="${line#*=}"
    key="${key#"${key%%[![:space:]]*}"}"
    key="${key%"${key##*[![:space:]]}"}"
    val="${val#"${val%%[![:space:]]*}"}"
    val="${val%"${val##*[![:space:]]}"}"
    # Strip matching single or double quotes without eval
    if [[ "$val" =~ ^\".*\"$ ]]; then
      val="${val:1:${#val}-2}"
    elif [[ "$val" =~ ^\'.*\'$ ]]; then
      val="${val:1:${#val}-2}"
    else
      # Strip unquoted inline comment if preceded by whitespace
      val="${val%%[[:space:]]#*}"
      val="${val%"${val##*[![:space:]]}"}"
    fi
    if [[ "$key" =~ ^[A-Z0-9_]+$ ]]; then
      ENV_VALUES["$key"]="$val"
    fi
  done < "$file"
  return 0
}

is_forbidden_private_key() {
  local raw="${1:-}"
  local lower="${raw,,}"
  # Must match 0x + 64 hex first
  if [[ ! "$lower" =~ ^0x[0-9a-f]{64}$ ]]; then
    return 0 # invalid / forbidden
  fi
  local hex="${lower#0x}"

  # Reject all-identical hex characters (0000..., 1111..., aaaa..., ffff...)
  local first="${hex:0:1}"
  local repeated
  repeated="$(printf '%064d' 0 | tr '0' "$first")"
  if [[ "$hex" == "$repeated" ]]; then
    return 0
  fi

  # Reject tiny / trivial dummy keys (e.g. 0x000...0001..000f, deadbeef repeats)
  if [[ "$hex" =~ ^0{60}[0-9a-f]{4}$ ]]; then
    return 0
  fi
  if [[ "$hex" == "deadbeef"* || "$hex" == *"deadbeefdeadbeef" ]]; then
    return 0
  fi
  if [[ "$hex" == "0123456789abcdef"* ]]; then
    return 0
  fi

  # Reject well-known public Anvil / Hardhat default keys
  local known
  for known in "${FORBIDDEN_PUBLIC_KEYS[@]}"; do
    if [[ "$lower" == "$known" ]]; then
      return 0
    fi
  done

  return 1 # NOT forbidden -> acceptable format
}

validate_env_map() {
  local template="${1:-${REPO_DIR}/deploy/env.example}"
  ENV_ERRORS=()

  local -a req_keys=()
  local k
  while IFS= read -r k; do
    [[ -n "$k" ]] && req_keys+=("$k")
  done < <(extract_required_env_keys "$template")

  for k in "${req_keys[@]}"; do
    local v="${ENV_VALUES[$k]:-}"
    if [[ -z "$v" ]]; then
      ENV_ERRORS+=("${k}: missing or empty")
      continue
    fi

    case "$k" in
      KEEPER_PRIVATE_KEY)
        if [[ ! "$v" =~ ^0x[0-9a-fA-F]{64}$ ]]; then
          ENV_ERRORS+=("KEEPER_PRIVATE_KEY: must be 0x followed by 64 hex characters")
        elif is_forbidden_private_key "$v"; then
          ENV_ERRORS+=("KEEPER_PRIVATE_KEY: dummy, trivial, or public Anvil/Hardhat default key rejected; generate a fresh dedicated Sepolia wallet")
        fi
        ;;
      KEEPER_RPC_URL)
        if [[ ! "$v" =~ ^https?://[^[:space:]]+$ ]]; then
          ENV_ERRORS+=("KEEPER_RPC_URL: must be a valid http:// or https:// URL")
        fi
        ;;
      KEEPER_HOST)
        if [[ "$v" != "127.0.0.1" && "$v" != "::1" ]]; then
          ENV_ERRORS+=("KEEPER_HOST: must be 127.0.0.1 (loopback-only behind Caddy)")
        fi
        ;;
      KEEPER_PORT)
        if [[ ! "$v" =~ ^[0-9]+$ ]] || (( v < 1024 || v > 65535 )); then
          ENV_ERRORS+=("KEEPER_PORT: must be an integer between 1024 and 65535")
        fi
        ;;
      KEEPER_GRACE_SECONDS|KEEPER_EMPTY_ROUND_MINUTES|KEEPER_SLASH_GRACE_SECONDS|KEEPER_RELAY_GRACE_SECONDS)
        if [[ ! "$v" =~ ^[0-9]+$ ]]; then
          ENV_ERRORS+=("${k}: must be a non-negative integer")
        fi
        ;;
      KEEPER_SLASH|KEEPER_RELAY_ENABLED)
        if [[ "${v,,}" != "true" && "${v,,}" != "false" ]]; then
          ENV_ERRORS+=("${k}: must be 'true' or 'false'")
        fi
        ;;
      KEEPER_MIN_BALANCE_ETH|KEEPER_MAX_GAS_PRICE_GWEI)
        if [[ ! "$v" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then
          ENV_ERRORS+=("${k}: must be a non-negative decimal number")
        fi
        ;;
      KEEPER_SETTLE_GAS_LIMIT)
        if [[ ! "$v" =~ ^[0-9]+$ ]] || (( v < 500000 )); then
          ENV_ERRORS+=("KEEPER_SETTLE_GAS_LIMIT: must be an integer >= 500000")
        fi
        ;;
      KEEPER_SLASH_GAS_LIMIT)
        if [[ ! "$v" =~ ^[0-9]+$ ]] || (( v < 100000 )); then
          ENV_ERRORS+=("KEEPER_SLASH_GAS_LIMIT: must be an integer >= 100000")
        fi
        ;;
      KEEPER_RELAY_GAS_LIMIT)
        if [[ ! "$v" =~ ^[0-9]+$ ]] || (( v < 200000 )); then
          ENV_ERRORS+=("KEEPER_RELAY_GAS_LIMIT: must be an integer >= 200000")
        fi
        ;;
    esac
  done

  [[ "${#ENV_ERRORS[@]}" -eq 0 ]]
}

derive_public_address_from_env() {
  local key="${ENV_VALUES[KEEPER_PRIVATE_KEY]:-}"
  [[ -n "$key" ]] || return 1
  local helper="${REPO_DIR}/deploy/lib/derive_address.mjs"
  [[ -f "$helper" ]] || return 1
  # Pass private key strictly on stdin (never via argv/ps)
  printf '%s\n' "$key" | node "$helper"
}

ipv4_to_int() {
  local ip="$1"
  local IFS='.'
  local -a o=()
  read -r -a o <<< "$ip"
  printf '%u\n' $(( (10#${o[0]} << 24) | (10#${o[1]} << 16) | (10#${o[2]} << 8) | 10#${o[3]} ))
}

is_cloudflare_ipv4() {
  local ip="${1:-}"
  is_ipv4_address "$ip" || return 1
  local ip_int
  ip_int="$(ipv4_to_int "$ip")"

  local cidr net bits net_int mask
  for cidr in "${CLOUDFLARE_IPV4_CIDRS[@]}"; do
    net="${cidr%/*}"
    bits="${cidr#*/}"
    net_int="$(ipv4_to_int "$net")"
    mask=$(( (0xffffffff << (32 - bits)) & 0xffffffff ))
    if (( (ip_int & mask) == (net_int & mask) )); then
      return 0
    fi
  done
  return 1
}

# Pure DNS comparison function.
# Args: domain expected_v4 expected_v6 a_1111 a_8888 aaaa_1111 aaaa_8888
# Return codes:
#   0 = DNS matches server cleanly
#   1 = Missing or mismatched A record
#   2 = Cloudflare orange-cloud proxy IP detected
#   3 = Mismatched AAAA record (breaks Let's Encrypt ACME HTTP-01)
evaluate_dns_records() {
  local domain="$1"
  local expected_v4="$2"
  local expected_v6="${3:-}"
  local a_1111="${4:-}"
  local a_8888="${5:-}"
  local aaaa_1111="${6:-}"
  local aaaa_8888="${7:-}"

  local all_a all_aaaa ip
  all_a="$(printf '%s\n%s\n' "$a_1111" "$a_8888" | awk 'NF && !seen[$0]++')"
  all_aaaa="$(printf '%s\n%s\n' "$aaaa_1111" "$aaaa_8888" | awk 'NF && !seen[$0]++')"

  # Check for Cloudflare proxy IPs first so user gets exact guidance
  if [[ -n "$all_a" ]]; then
    while IFS= read -r ip; do
      [[ -z "$ip" ]] && continue
      if is_cloudflare_ipv4 "$ip"; then
        printf 'CLOUDFLARE_PROXY: %s resolves to Cloudflare proxy IP %s (1.1.1.1=[%s], 8.8.8.8=[%s]). Switch Cloudflare proxy OFF ("DNS only" / grey cloud) until HTTPS is issued, then you may enable proxy with SSL/TLS = Full (strict).\n' \
          "$domain" "$ip" "${a_1111//$'\n'/, }" "${a_8888//$'\n'/, }"
        return 2
      fi
    done <<< "$all_a"
  fi

  # Verify A record matches on BOTH 1.1.1.1 and 8.8.8.8
  local match_1=0 match_8=0
  if [[ -n "$a_1111" ]]; then
    while IFS= read -r ip; do
      [[ "$ip" == "$expected_v4" ]] && match_1=1
    done <<< "$a_1111"
  fi
  if [[ -n "$a_8888" ]]; then
    while IFS= read -r ip; do
      [[ "$ip" == "$expected_v4" ]] && match_8=1
    done <<< "$a_8888"
  fi

  if [[ "$match_1" -ne 1 || "$match_8" -ne 1 ]]; then
    printf 'A_MISMATCH: %s expected A=%s, but found 1.1.1.1=[%s] and 8.8.8.8=[%s].\n' \
      "$domain" "$expected_v4" "${a_1111//$'\n'/, }" "${a_8888//$'\n'/, }"
    return 1
  fi

  # Check AAAA records: any AAAA not matching expected_v6 breaks ACME issuance
  if [[ -n "$all_aaaa" ]]; then
    while IFS= read -r ip; do
      [[ -z "$ip" ]] && continue
      if [[ -z "$expected_v6" || "${ip,,}" != "${expected_v6,,}" ]]; then
        printf 'AAAA_MISMATCH: %s has AAAA=%s which does not match this server IPv6 (%s). Remove the stale AAAA record (Let'\''s Encrypt checks IPv6 first and will fail TLS issuance).\n' \
          "$domain" "$ip" "${expected_v6:-none}"
        return 3
      fi
    done <<< "$all_aaaa"
  fi

  printf 'DNS_OK: %s -> A=%s verified on 1.1.1.1 and 8.8.8.8.\n' "$domain" "$expected_v4"
  return 0
}

render_template_file() {
  local template_path="$1"
  local out_path="$2"
  shift 2
  local content
  content="$(cat "$template_path")"
  while [[ $# -ge 2 ]]; do
    local placeholder="$1"
    local replacement="$2"
    content="${content//"$placeholder"/$replacement}"
    shift 2
  done
  printf '%s\n' "$content" > "$out_path"
}

render_caddyfile_ip() {
  local out_path="$1"
  local frontend_root="$2"
  local keeper_port="$3"
  render_template_file \
    "${REPO_DIR}/deploy/Caddyfile.ip.tmpl" \
    "$out_path" \
    "__FRONTEND_ROOT__" "$frontend_root" \
    "__KEEPER_PORT__" "$keeper_port"
}

render_caddyfile_domain() {
  local out_path="$1"
  local domain="$2"
  local www_redirect="$3"
  local frontend_root="$4"
  local keeper_port="$5"

  local www_block=""
  if [[ "$www_redirect" == "yes" ]]; then
    www_block=$'\nwww.'"${domain}"$' {\n\tredir https://'"${domain}"$'{uri} 308\n}\n'
  fi

  render_template_file \
    "${REPO_DIR}/deploy/Caddyfile.domain.tmpl" \
    "$out_path" \
    "__WWW_BLOCK__" "$www_block" \
    "__DOMAIN__" "$domain" \
    "__FRONTEND_ROOT__" "$frontend_root" \
    "__KEEPER_PORT__" "$keeper_port"
}

render_systemd_unit() {
  local out_path="$1"
  local keeper_exec="$2"
  render_template_file \
    "${REPO_DIR}/deploy/fairbatch-keeper.service.tmpl" \
    "$out_path" \
    "__SERVICE_USER__" "$SERVICE_USER" \
    "__SERVICE_GROUP__" "$SERVICE_GROUP" \
    "__CURRENT_LINK__" "${BASE_DIR}/current" \
    "__ENV_FILE__" "$ENV_FILE" \
    "__KEEPER_EXEC__" "$keeper_exec" \
    "__STATE_DIR__" "$STATE_DIR"
}

prune_old_releases() {
  local releases_dir="$1"
  local current_link="$2"
  local keep_count="${3:-3}"

  [[ -d "$releases_dir" ]] || return 0
  local active_target=""
  if [[ -L "$current_link" ]]; then
    active_target="$(readlink -f "$current_link" 2>/dev/null || true)"
  fi

  local -a releases=()
  local entry
  while IFS= read -r entry; do
    [[ -n "$entry" ]] && releases+=("$entry")
  done < <(find "$releases_dir" -mindepth 1 -maxdepth 1 -type d | sort -r)

  local idx=0
  for entry in "${releases[@]}"; do
    idx=$((idx + 1))
    if (( idx <= keep_count )); then
      continue
    fi
    local resolved=""
    resolved="$(readlink -f "$entry" 2>/dev/null || printf '%s' "$entry")"
    if [[ -n "$active_target" && "$resolved" == "$active_target" ]]; then
      continue
    fi
    rm -rf -- "$entry"
  done
}

# ==============================================================================
# Step 1: Preflight (OS, privilege, disk, RAM/swap, signed-repo dependencies)
# ==============================================================================
check_os_and_privileges() {
  log_step "1. Preflight Checks"

  if [[ ! -f "$OS_RELEASE_FILE" ]]; then
    log_err "Cannot find ${OS_RELEASE_FILE}. Expected Ubuntu 22.04/24.04 or Debian 12."
    exit 1
  fi

  local os_id="" os_ver="" os_pretty=""
  while IFS= read -r line; do
    line="${line%$'\r'}"
    case "$line" in
      ID=*) os_id="${line#ID=}"; os_id="${os_id//\"/}" ;;
      VERSION_ID=*) os_ver="${line#VERSION_ID=}"; os_ver="${os_ver//\"/}" ;;
      PRETTY_NAME=*) os_pretty="${line#PRETTY_NAME=}"; os_pretty="${os_pretty//\"/}" ;;
    esac
  done < "$OS_RELEASE_FILE"

  case "${os_id}:${os_ver}" in
    ubuntu:22.04|ubuntu:24.04|debian:12)
      log_ok "OS supported: ${os_pretty:-${os_id} ${os_ver}}"
      ;;
    *)
      log_err "Unsupported OS: ${os_pretty:-${os_id} ${os_ver}}. Supported: Ubuntu 22.04, Ubuntu 24.04, Debian 12."
      exit 1
      ;;
  esac

  if [[ "$MOCK_MODE" != "1" && "$FLAG_DRY_RUN" -eq 0 ]]; then
    if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
      if ! command -v sudo >/dev/null 2>&1; then
        log_err "Run as root or install sudo."
        exit 1
      fi
      if ! sudo -n true 2>/dev/null; then
        log_info "Requesting sudo access..."
        sudo -v
      fi
    fi
    log_ok "Root/sudo privilege verified."
  elif [[ "$FLAG_DRY_RUN" -eq 1 ]]; then
    log_info "Dry-run mode: skipping sudo elevation check."
  fi

  # Detect keeper implementation (TypeScript vs Rust)
  if ! KEEPER_TYPE="$(detect_keeper_type "$REPO_DIR")"; then
    log_err "Could not detect keeper in ${REPO_DIR}/keeper (expected package.json or Cargo.toml)."
    exit 1
  fi
  NODE_TARGET_MAJOR="$(parse_required_node_major "${REPO_DIR}/frontend/package.json")"
  log_ok "Detected keeper stack: ${KEEPER_TYPE} (Fe compiler NOT required on server)."
  log_ok "Target Node.js LTS major (from frontend/package.json engines): ${NODE_TARGET_MAJOR}.x"

  # Check free disk space (>= 2048 MB)
  local check_path="$BASE_DIR"
  while [[ ! -d "$check_path" && "$check_path" != "/" ]]; do
    check_path="$(dirname "$check_path")"
  done
  local free_kb free_mb
  free_kb="$(df -Pk "$check_path" | awk 'NR==2 {print $4}')"
  free_mb=$(( free_kb / 1024 ))
  log_info "Free disk space on ${check_path}: ${free_mb} MB"
  if (( free_mb < 2048 )); then
    log_err "At least 2048 MB free disk space is required (found ${free_mb} MB)."
    exit 1
  fi

  # Check RAM & offer 2GB swapfile if RAM < 2048 MB
  local ram_mb=0 swap_mb=0
  if [[ -r /proc/meminfo ]]; then
    local ram_kb swap_kb
    ram_kb="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)"
    swap_kb="$(awk '/^SwapTotal:/ {print $2}' /proc/meminfo)"
    ram_mb=$(( ram_kb / 1024 ))
    swap_mb=$(( swap_kb / 1024 ))
  elif command -v free >/dev/null 2>&1; then
    ram_mb="$(free -m | awk '/^Mem:/ {print $2}')"
    swap_mb="$(free -m | awk '/^Swap:/ {print $2}')"
  fi
  log_info "Detected memory: RAM=${ram_mb} MB, Swap=${swap_mb} MB"

  if (( ram_mb > 0 && ram_mb < 2048 && swap_mb < 1536 )); then
    log_warn "Server RAM (${ram_mb} MB) is under 2 GB; frontend/keeper builds may run out of memory without swap."
    local create_swap=0
    if [[ "$FLAG_WITH_SWAP" -eq 1 ]]; then
      create_swap=1
    elif prompt_yes_no "Create a 2GB /swapfile now?" "Y"; then
      create_swap=1
    fi
    if [[ "$create_swap" -eq 1 ]]; then
      if [[ "$FLAG_DRY_RUN" -eq 1 ]]; then
        log_dry "Create 2GB /swapfile (chmod 600, mkswap, swapon, add to /etc/fstab)"
      elif [[ "$MOCK_MODE" == "1" ]]; then
        log_ok "[MOCK] Would create 2GB /swapfile"
      else
        if [[ ! -f /swapfile ]]; then
          run_priv fallocate -l 2G /swapfile || run_priv dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
          run_priv chmod 600 /swapfile
          run_priv mkswap /swapfile
          run_priv swapon /swapfile
          if ! grep -q '^/swapfile ' /etc/fstab 2>/dev/null; then
            printf '/swapfile none swap sw 0 0\n' | run_priv tee -a /etc/fstab >/dev/null
          fi
          log_ok "2GB /swapfile created and enabled."
        else
          log_info "/swapfile already exists; enabling if inactive."
          run_priv swapon /swapfile 2>/dev/null || true
        fi
      fi
    fi
  fi
}

install_missing_dependencies() {
  log_step "1b. Checking & Installing Required Tools"

  local -a apt_needed=()
  command -v git >/dev/null 2>&1 || apt_needed+=("git")
  command -v curl >/dev/null 2>&1 || apt_needed+=("curl")
  [[ -f /etc/ssl/certs/ca-certificates.crt ]] || apt_needed+=("ca-certificates")
  command -v gcc >/dev/null 2>&1 || apt_needed+=("build-essential")
  command -v pkg-config >/dev/null 2>&1 || apt_needed+=("pkg-config")
  command -v dig >/dev/null 2>&1 || apt_needed+=("dnsutils")
  command -v gpg >/dev/null 2>&1 || apt_needed+=("gnupg")
  if [[ "$MOCK_MODE" != "1" ]] && command -v dpkg >/dev/null 2>&1; then
    dpkg -s libssl-dev >/dev/null 2>&1 || apt_needed+=("libssl-dev")
    dpkg -s apt-transport-https >/dev/null 2>&1 || apt_needed+=("apt-transport-https")
    dpkg -s debian-keyring >/dev/null 2>&1 || apt_needed+=("debian-keyring")
    dpkg -s debian-archive-keyring >/dev/null 2>&1 || apt_needed+=("debian-archive-keyring")
  fi

  if [[ "${#apt_needed[@]}" -gt 0 ]]; then
    if [[ "$FLAG_DRY_RUN" -eq 1 ]]; then
      log_dry "apt-get update && apt-get install -y ${apt_needed[*]}"
    elif [[ "$MOCK_MODE" == "1" ]]; then
      log_ok "[MOCK] Installed missing apt packages: ${apt_needed[*]}"
    else
      log_info "Installing missing base packages: ${apt_needed[*]}"
      run_priv env DEBIAN_FRONTEND=noninteractive apt-get update -qq
      run_priv env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${apt_needed[@]}"
    fi
  fi

  # Node.js LTS via signed NodeSource apt repo (no curl | bash)
  local need_node=0
  if ! command -v node >/dev/null 2>&1; then
    need_node=1
  else
    local current_node_major
    current_node_major="$(node -v | sed -E 's/^v([0-9]+).*/\1/')"
    if (( current_node_major < 20 || current_node_major >= 23 )); then
      need_node=1
    fi
  fi

  if [[ "$need_node" -eq 1 ]]; then
    if [[ "$FLAG_DRY_RUN" -eq 1 ]]; then
      log_dry "Add signed NodeSource GPG key (/etc/apt/keyrings/nodesource.gpg) and install nodejs ${NODE_TARGET_MAJOR}.x"
    elif [[ "$MOCK_MODE" == "1" ]]; then
      log_ok "[MOCK] Installed Node.js ${NODE_TARGET_MAJOR}.x via signed NodeSource apt repo"
    else
      log_info "Installing Node.js ${NODE_TARGET_MAJOR}.x LTS from signed NodeSource apt repository..."
      run_priv install -d -m 0755 /etc/apt/keyrings
      curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
        | run_priv gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
      printf 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_%s.x nodistro main\n' \
        "$NODE_TARGET_MAJOR" \
        | run_priv tee /etc/apt/sources.list.d/nodesource.list >/dev/null
      run_priv env DEBIAN_FRONTEND=noninteractive apt-get update -qq
      run_priv env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs
    fi
  fi

  # Rust via rustup ONLY if keeper is Rust
  if [[ "$KEEPER_TYPE" == "rust" ]] && ! command -v cargo >/dev/null 2>&1; then
    if [[ "$FLAG_DRY_RUN" -eq 1 ]]; then
      log_dry "Download rustup-init binary to temp file and install stable Rust toolchain (keeper is Rust)"
    elif [[ "$MOCK_MODE" == "1" ]]; then
      log_ok "[MOCK] Installed Rust toolchain via rustup-init"
    else
      log_info "Keeper is Rust: downloading rustup-init to a verified temp file..."
      local rustup_tmp
      rustup_tmp="$(mktemp)"
      curl -fsSL https://sh.rustup.rs -o "$rustup_tmp"
      chmod 0700 "$rustup_tmp"
      sh "$rustup_tmp" -y --default-toolchain stable --profile minimal
      rm -f "$rustup_tmp"
      # shellcheck disable=SC1091
      source "${HOME}/.cargo/env"
    fi
  elif [[ "$KEEPER_TYPE" == "typescript" ]]; then
    log_info "Keeper is TypeScript; skipping Rust/rustup installation."
  fi

  # Caddy from official signed Cloudsmith apt repo (no curl | bash)
  if ! command -v caddy >/dev/null 2>&1; then
    if [[ "$FLAG_DRY_RUN" -eq 1 ]]; then
      log_dry "Add signed Caddy GPG key (/usr/share/keyrings/caddy-stable-archive-keyring.gpg) and install caddy"
    elif [[ "$MOCK_MODE" == "1" ]]; then
      log_ok "[MOCK] Installed Caddy from official signed apt repo"
    else
      log_info "Installing Caddy from official signed apt repository..."
      curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
        | run_priv gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
      curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
        | run_priv tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
      run_priv chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
      run_priv env DEBIAN_FRONTEND=noninteractive apt-get update -qq
      run_priv env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq caddy
    fi
  fi

  # Print installed tool versions
  log_ok "Tool versions:"
  command -v git >/dev/null 2>&1   && printf '  - git:   %s\n' "$(git --version)"
  command -v curl >/dev/null 2>&1  && printf '  - curl:  %s\n' "$(curl --version | head -n 1)"
  command -v dig >/dev/null 2>&1   && printf '  - dig:   %s\n' "$(dig -v 2>&1 | head -n 1)"
  command -v node >/dev/null 2>&1  && printf '  - node:  %s\n' "$(node -v)"
  command -v npm >/dev/null 2>&1   && printf '  - npm:   %s\n' "$(npm -v)"
  command -v caddy >/dev/null 2>&1 && printf '  - caddy: %s\n' "$(caddy version | head -n 1)"
  if [[ "$KEEPER_TYPE" == "rust" ]] && command -v cargo >/dev/null 2>&1; then
    printf '  - cargo: %s\n' "$(cargo --version)"
  fi
}

# ==============================================================================
# Step 2: Environment, Secret & On-Chain Preflight Checks
# ==============================================================================
write_env_file_secure() {
  local target_file="$1"
  local template="${REPO_DIR}/deploy/env.example"
  local target_dir
  target_dir="$(dirname "$target_file")"

  # Guard: NEVER write secrets inside the git repository
  local abs_repo abs_target
  abs_repo="$(cd -- "$REPO_DIR" && pwd -P)"
  abs_target="$(mkdir -p "$target_dir" 2>/dev/null || true; cd -- "$target_dir" 2>/dev/null && pwd -P || printf '%s' "$target_dir")"
  if [[ "$abs_target" == "$abs_repo" || "$abs_target" == "$abs_repo/"* ]]; then
    log_err "Refusing to write secret env file inside repository path (${target_file})."
    exit 1
  fi

  if [[ "$FLAG_DRY_RUN" -eq 1 ]]; then
    log_dry "Write validated environment to ${target_file} (umask 077, chmod 600, owner ${SERVICE_USER}:${SERVICE_GROUP})"
    return 0
  fi

  local tmp_file
  tmp_file="$(umask 077 && mktemp)"
  {
    printf '# FairBatch server environment (managed by deploy.sh, mode 0600)\n'
    local line key
    while IFS= read -r line || [[ -n "$line" ]]; do
      line="${line%$'\r'}"
      [[ "$line" =~ ^[[:space:]]*# ]] && continue
      [[ "$line" != *"="* ]] && continue
      key="${line%%=*}"
      key="${key#"${key%%[![:space:]]*}"}"
      key="${key%"${key##*[![:space:]]}"}"
      [[ "$key" =~ ^[A-Z0-9_]+$ ]] || continue
      if [[ -n "${ENV_VALUES[$key]+x}" ]]; then
        printf '%s=%s\n' "$key" "${ENV_VALUES[$key]}"
      fi
    done < "$template"
  } > "$tmp_file"

  if [[ "$MOCK_MODE" == "1" ]]; then
    mkdir -p "$target_dir"
    (umask 077 && cp "$tmp_file" "$target_file")
    chmod 600 "$target_file" 2>/dev/null || true
  else
    run_priv install -d -m 0750 "$target_dir"
    run_priv install -m 0600 -o "$SERVICE_USER" -g "$SERVICE_GROUP" "$tmp_file" "$target_file"
  fi
  rm -f "$tmp_file"
  log_ok "Saved secrets securely to ${target_file} (0600, never inside repo)."
}

print_env_setup_instructions() {
  cat >&2 <<EOF

To fix environment configuration manually (never store secrets inside the git repo):
  1. Generate a fresh, dedicated low-balance Sepolia wallet:
       node -e "console.log('0x'+require('crypto').randomBytes(32).toString('hex'))"
  2. Create ${ENV_FILE} with mode 0600:
       sudo install -d -m 0750 "$(dirname "$ENV_FILE")"
       sudo cp "${REPO_DIR}/deploy/env.example" "${ENV_FILE}"
       sudo chmod 600 "${ENV_FILE}"
       sudo nano "${ENV_FILE}"   # Set KEEPER_PRIVATE_KEY and review required settings
  3. Re-run: ./deploy.sh
EOF
}

prompt_missing_env_interactive() {
  local template="${REPO_DIR}/deploy/env.example"
  local -a req_keys=()
  local k
  while IFS= read -r k; do
    [[ -n "$k" ]] && req_keys+=("$k")
  done < <(extract_required_env_keys "$template")

  # Seed defaults from deploy/env.example for any unset non-secret variables
  local line key def_val
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" != *"="* ]] && continue
    key="${line%%=*}"
    key="${key#"${key%%[![:space:]]*}"}"
    key="${key%"${key##*[![:space:]]}"}"
    [[ "$key" =~ ^[A-Z0-9_]+$ ]] || continue
    if [[ -z "${ENV_VALUES[$key]:-}" && "$key" != "KEEPER_PRIVATE_KEY" ]]; then
      def_val="${line#*=}"
      def_val="${def_val%%#*}"
      def_val="${def_val#"${def_val%%[![:space:]]*}"}"
      def_val="${def_val%"${def_val##*[![:space:]]}"}"
      [[ -n "$def_val" ]] && ENV_VALUES["$key"]="$def_val"
    fi
  done < "$template"

  for k in "${req_keys[@]}"; do
    local current="${ENV_VALUES[$k]:-}"
    local needs_input=0
    if [[ -z "$current" ]]; then
      needs_input=1
    elif [[ "$k" == "KEEPER_PRIVATE_KEY" ]] && is_forbidden_private_key "$current"; then
      needs_input=1
    fi

    if [[ "$needs_input" -eq 1 ]]; then
      if [[ "$k" == "KEEPER_PRIVATE_KEY" ]]; then
        local secret_in=""
        printf 'Enter %s (hidden input, 0x + 64 hex, dedicated Sepolia wallet): ' "$k"
        IFS= read -rs secret_in
        printf '\n'
        ENV_VALUES["$k"]="$secret_in"
        secret_in=""
      else
        local def="" user_in=""
        def="$(extract_default_for_key "$template" "$k")"
        printf 'Enter %s [%s]: ' "$k" "$def"
        IFS= read -r user_in
        ENV_VALUES["$k"]="${user_in:-$def}"
      fi
    fi
  done

  if ! validate_env_map "$template"; then
    log_err "Environment still has validation errors:"
    local err
    for err in "${ENV_ERRORS[@]}"; do
      printf '  - %s\n' "$err" >&2
    done
    print_env_setup_instructions
    exit 1
  fi

  ensure_service_user
  write_env_file_secure "$ENV_FILE"
}

rpc_json_call() {
  local rpc_url="$1"
  local method="$2"
  local params_json="$3"
  local payload
  payload="$(printf '{"jsonrpc":"2.0","id":1,"method":"%s","params":%s}' "$method" "$params_json")"
  curl -fsSL --max-time 15 \
    -H 'Content-Type: application/json' \
    -d "$payload" \
    "$rpc_url"
}

json_extract_rpc_result() {
  node -e '
    const fs = require("node:fs");
    const raw = fs.readFileSync(0, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed.error) { process.stderr.write(parsed.error.message || "RPC error"); process.exit(2); }
    if (parsed.result === undefined || parsed.result === null) { process.exit(3); }
    process.stdout.write(String(parsed.result));
  '
}

wei_hex_to_eth() {
  local hex_wei="$1"
  node -e '
    const wei = BigInt(process.argv[1]);
    const whole = wei / 1000000000000000000n;
    const frac = (wei % 1000000000000000000n).toString().padStart(18, "0").slice(0, 6);
    process.stdout.write(String(whole) + "." + frac);
  ' "$hex_wei"
}

compare_eth_lt() {
  local eth_a="$1"
  local eth_b="$2"
  node -e '
    const a = Number(process.argv[1]);
    const b = Number(process.argv[2]);
    process.exit(a < b ? 0 : 1);
  ' "$eth_a" "$eth_b"
}

verify_env_and_chain() {
  log_step "2. Environment, Secret & On-Chain Checks"
  local template="${REPO_DIR}/deploy/env.example"

  if [[ ! -f "$template" ]]; then
    log_err "Missing template: ${template}"
    exit 1
  fi

  if [[ -f "$ENV_FILE" ]]; then
    if [[ "$MOCK_MODE" != "1" && "${EUID:-$(id -u)}" -ne 0 && ! -r "$ENV_FILE" ]]; then
      # Copy temporarily via sudo to validate without echoing values
      local tmp_read
      tmp_read="$(umask 077 && mktemp)"
      run_priv cat "$ENV_FILE" > "$tmp_read"
      parse_env_file_safe "$tmp_read"
      rm -f "$tmp_read"
    else
      parse_env_file_safe "$ENV_FILE"
    fi
    log_ok "Loaded environment keys from ${ENV_FILE} (values redacted)."
  else
    log_warn "Environment file not found at ${ENV_FILE}."
    ENV_VALUES=()
  fi

  if ! validate_env_map "$template"; then
    log_err "Environment validation failed (${#ENV_ERRORS[@]} problem(s) found):"
    local err
    for err in "${ENV_ERRORS[@]}"; do
      printf '  - %s\n' "$err" >&2
    done

    if [[ "$FLAG_DRY_RUN" -eq 1 || "$FLAG_YES" -eq 1 || ! -t 0 ]]; then
      print_env_setup_instructions
      exit 1
    fi

    printf '\nChoose how to proceed:\n'
    printf '  1) Enter missing/invalid values now via hidden prompt (writes to %s, chmod 600)\n' "$ENV_FILE"
    printf '  2) Exit and see manual setup instructions\n'
    local choice=""
    printf 'Selection [1/2]: '
    IFS= read -r choice || choice="2"
    if [[ "$choice" == "1" ]]; then
      prompt_missing_env_interactive
    else
      print_env_setup_instructions
      exit 1
    fi
  else
    log_ok "All required variables from deploy/env.example passed format and secret-safety checks."
  fi

  DEPLOY_KEEPER_PORT="${ENV_VALUES[KEEPER_PORT]:-3002}"

  # Derive PUBLIC address without passing private key on argv
  if ! KEEPER_PUBLIC_ADDRESS="$(derive_public_address_from_env)"; then
    log_err "Failed to derive public address from KEEPER_PRIVATE_KEY."
    exit 1
  fi
  log_ok "Keeper public address (derived safely via stdin): ${KEEPER_PUBLIC_ADDRESS}"

  # Check RPC reachability & chainId == 11155111 (0xaa36a7)
  local rpc_url="${ENV_VALUES[KEEPER_RPC_URL]}"
  local chain_resp chain_hex
  if ! chain_resp="$(rpc_json_call "$rpc_url" "eth_chainId" "[]")"; then
    log_err "Sepolia RPC unreachable at ${rpc_url}"
    exit 1
  fi
  chain_hex="$(printf '%s' "$chain_resp" | json_extract_rpc_result)"
  if [[ "${chain_hex,,}" != "0xaa36a7" ]]; then
    log_err "RPC chainId mismatch: expected 0xaa36a7 (11155111 Sepolia), got ${chain_hex}"
    exit 1
  fi
  log_ok "Sepolia RPC reachable (${rpc_url}) — chainId=11155111 (0xaa36a7)."

  # Check Sepolia ETH balance of keeper wallet
  local bal_resp bal_hex
  if bal_resp="$(rpc_json_call "$rpc_url" "eth_getBalance" "[\"${KEEPER_PUBLIC_ADDRESS}\",\"latest\"]")"; then
    bal_hex="$(printf '%s' "$bal_resp" | json_extract_rpc_result)"
    KEEPER_SEPOLIA_ETH="$(wei_hex_to_eth "$bal_hex")"
    log_info "Keeper Sepolia ETH balance: ${KEEPER_SEPOLIA_ETH} ETH (minimum threshold: ${ENV_VALUES[KEEPER_MIN_BALANCE_ETH]} ETH)"
    if compare_eth_lt "$KEEPER_SEPOLIA_ETH" "${ENV_VALUES[KEEPER_MIN_BALANCE_ETH]}"; then
      log_warn "Keeper Sepolia balance (${KEEPER_SEPOLIA_ETH} ETH) is below KEEPER_MIN_BALANCE_ETH (${ENV_VALUES[KEEPER_MIN_BALANCE_ETH]} ETH)."
      log_warn "The keeper will start in degraded/paused mode until you fund ${KEEPER_PUBLIC_ADDRESS} with Sepolia ETH."
    fi
  else
    log_warn "Could not query Sepolia ETH balance for ${KEEPER_PUBLIC_ADDRESS}."
  fi

  # Check Ethereum mainnet ETH balance (warn if > 0 — likely a real personal wallet!)
  local mainnet_rpc="${ENV_VALUES[KEEPER_MAINNET_RPC_URL]:-https://ethereum-rpc.publicnode.com}"
  local m_resp m_hex
  if m_resp="$(rpc_json_call "$mainnet_rpc" "eth_getBalance" "[\"${KEEPER_PUBLIC_ADDRESS}\",\"latest\"]" 2>/dev/null)"; then
    m_hex="$(printf '%s' "$m_resp" | json_extract_rpc_result 2>/dev/null || printf '0x0')"
    KEEPER_MAINNET_ETH="$(wei_hex_to_eth "$m_hex")"
    if [[ "${m_hex,,}" != "0x0" && "${m_hex,,}" != "0x" ]]; then
      log_warn "SECURITY WARNING: ${KEEPER_PUBLIC_ADDRESS} holds ${KEEPER_MAINNET_ETH} ETH on Ethereum MAINNET!"
      log_warn "This looks like a real wallet. You should use a fresh throwaway wallet strictly for the Sepolia keeper."
      if [[ "$FLAG_DRY_RUN" -eq 0 && "$FLAG_YES" -eq 0 && -t 0 ]]; then
        if ! prompt_yes_no "Continue anyway with a wallet that holds mainnet ETH?" "N"; then
          log_err "Aborted so you can switch to a dedicated throwaway wallet."
          exit 1
        fi
      fi
    else
      log_ok "Ethereum mainnet balance check: 0 ETH (good — throwaway testnet wallet)."
    fi
  else
    log_warn "Could not reach Ethereum mainnet RPC (${mainnet_rpc}) for mainnet-balance safety check."
  fi

  # Check config/deployment.json exists and every listed contract has on-chain code
  local dep_json="${REPO_DIR}/config/deployment.json"
  if [[ ! -f "$dep_json" ]]; then
    log_err "Missing ${dep_json}."
    exit 1
  fi
  local -a contract_entries=()
  local entry
  while IFS= read -r entry; do
    [[ -n "$entry" ]] && contract_entries+=("$entry")
  done < <(node -e '
    const fs = require("node:fs");
    const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (!d.contracts || typeof d.contracts !== "object") process.exit(1);
    for (const [name, addr] of Object.entries(d.contracts)) {
      console.log(name + "=" + addr);
    }
  ' "$dep_json")

  if [[ "${#contract_entries[@]}" -eq 0 ]]; then
    log_err "No contracts found in ${dep_json}."
    exit 1
  fi

  local c_name c_addr code_resp code_hex
  for entry in "${contract_entries[@]}"; do
    c_name="${entry%%=*}"
    c_addr="${entry#*=}"
    if ! code_resp="$(rpc_json_call "$rpc_url" "eth_getCode" "[\"${c_addr}\",\"latest\"]")"; then
      log_err "Failed to call eth_getCode for ${c_name} (${c_addr})."
      exit 1
    fi
    code_hex="$(printf '%s' "$code_resp" | json_extract_rpc_result)"
    if [[ -z "$code_hex" || "$code_hex" == "0x" || "$code_hex" == "0x0" ]]; then
      log_err "Contract ${c_name} (${c_addr}) has NO deployed bytecode on Sepolia!"
      exit 1
    fi
    log_ok "Contract verified on-chain: ${c_name} (${c_addr}, $(( (${#code_hex} - 2) / 2 )) bytes)"
  done
}

# ==============================================================================
# Step 3: Release Build & Atomic Symlink
# ==============================================================================
ensure_service_user() {
  if [[ "$FLAG_DRY_RUN" -eq 1 ]]; then
    log_dry "Ensure dedicated non-login system user '${SERVICE_USER}' and directories (${BASE_DIR}, ${STATE_DIR})"
    return 0
  fi
  if [[ "$MOCK_MODE" == "1" ]]; then
    mkdir -p "${BASE_DIR}/releases" "$STATE_DIR" "$(dirname "$CONF_FILE")"
    return 0
  fi
  if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
    run_priv useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
    log_ok "Created dedicated system user: ${SERVICE_USER}"
  fi
  run_priv install -d -m 0755 "${BASE_DIR}" "${BASE_DIR}/releases"
  run_priv install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_GROUP" "$STATE_DIR"
  run_priv install -d -m 0750 "$(dirname "$CONF_FILE")"
}

resolve_keeper_exec() {
  if [[ "$KEEPER_TYPE" == "rust" ]]; then
    printf '%s/current/keeper/target/release/fairbatch-keeper\n' "$BASE_DIR"
  else
    local node_bin
    node_bin="$(command -v node || printf '/usr/bin/node')"
    printf '%s %s/current/keeper/dist/index.js\n' "$node_bin" "$BASE_DIR"
  fi
}

build_release() {
  log_step "3. Building Release (Frontend + ${KEEPER_TYPE} Keeper)"
  local release_id
  release_id="$(date -u +%Y%m%d-%H%M%S)"
  local release_dir="${BASE_DIR}/releases/${release_id}"
  # Ensure unique directory if two builds happen in the same second (e.g. tests)
  if [[ -d "$release_dir" ]]; then
    release_id="${release_id}-$$"
    release_dir="${BASE_DIR}/releases/${release_id}"
  fi

  if [[ "$FLAG_DRY_RUN" -eq 1 ]]; then
    local fe_test_step="" keeper_test_step=""
    if [[ "$FLAG_RUN_TESTS" -eq 1 ]]; then
      fe_test_step="npm test && "
      if [[ "$KEEPER_TYPE" == "rust" ]]; then
        keeper_test_step="cargo test && "
      else
        keeper_test_step="npm test && "
      fi
    fi
    log_dry "Copy config/, frontend/, keeper/ into ${release_dir} (excluding .env, node_modules, dist, target)"
    log_dry "Build frontend: npm ci && ${fe_test_step}VITE_KEEPER_URL=/keeper npm run build"
    if [[ "$KEEPER_TYPE" == "rust" ]]; then
      log_dry "Build Rust keeper: ${keeper_test_step}cargo build --release"
    else
      log_dry "Build TypeScript keeper: npm ci && ${keeper_test_step}npm run build && npm prune --omit=dev"
    fi
    log_dry "Switch symlink ${BASE_DIR}/current -> ${release_dir} and keep last 3 releases"
    ACTIVE_RELEASE_ID="$release_id"
    return 0
  fi

  ensure_service_user

  local stage_dir
  stage_dir="$(mktemp -d)"
  mkdir -p "${stage_dir}/config" "${stage_dir}/frontend" "${stage_dir}/keeper"

  if [[ "$MOCK_MODE" == "1" && "${FAIRBATCH_MOCK_FAST_BUILD:-0}" == "1" && -d "${BASE_DIR}/current/frontend/dist" ]]; then
    cp -a "${BASE_DIR}/current/." "${stage_dir}/"
    mv "$stage_dir" "$release_dir"
    ACTIVE_RELEASE_ID="$release_id"
    log_ok "[MOCK] Fast-built release from previous dist: ${release_dir}"
    return 0
  fi

  cp -a "${REPO_DIR}/config/." "${stage_dir}/config/"
  # Copy frontend & keeper excluding build artifacts and any local .env files
  tar -C "${REPO_DIR}/frontend" \
    --exclude='node_modules' --exclude='dist' --exclude='.env*' --exclude='tsconfig.tsbuildinfo' \
    -cf - . | tar -C "${stage_dir}/frontend" -xf -
  tar -C "${REPO_DIR}/keeper" \
    --exclude='node_modules' --exclude='dist' --exclude='target' --exclude='.env*' \
    -cf - . | tar -C "${stage_dir}/keeper" -xf -

  # Build frontend with relative /keeper proxy path (domain changes never need a rebuild)
  log_info "Building frontend (VITE_KEEPER_URL=/keeper)..."
  (
    cd "${stage_dir}/frontend"
    npm ci --no-audit --no-fund
    if [[ "$FLAG_RUN_TESTS" -eq 1 ]]; then
      npm test
    fi
    VITE_KEEPER_URL=/keeper npm run build
  )
  log_ok "Frontend production build complete (${stage_dir}/frontend/dist)."

  # Build keeper according to detected stack
  log_info "Building ${KEEPER_TYPE} keeper..."
  if [[ "$KEEPER_TYPE" == "rust" ]]; then
    (
      cd "${stage_dir}/keeper"
      if [[ "$FLAG_RUN_TESTS" -eq 1 ]]; then
        cargo test
      fi
      cargo build --release
    )
  else
    (
      cd "${stage_dir}/keeper"
      npm ci --no-audit --no-fund
      if [[ "$FLAG_RUN_TESTS" -eq 1 ]]; then
        npm test
      fi
      npm run build
      npm prune --omit=dev --no-audit --no-fund
    )
  fi
  log_ok "Keeper build complete."

  # Move finished release into /opt/fairbatch/releases/<timestamp>
  if [[ "$MOCK_MODE" == "1" ]]; then
    mv "$stage_dir" "$release_dir"
  else
    run_priv mv "$stage_dir" "$release_dir"
    run_priv chown -R root:root "$release_dir"
    run_priv chmod -R a+rX "$release_dir"
  fi

  ACTIVE_RELEASE_ID="$release_id"
  log_ok "Prepared release: ${release_dir}"
}

resolve_active_release_id() {
  local current_link="${BASE_DIR}/current"
  if [[ -L "$current_link" ]]; then
    basename "$(readlink -f "$current_link" 2>/dev/null || readlink "$current_link")"
    return 0
  fi
  if [[ -f "${BASE_DIR}/.current_release" ]]; then
    cat "${BASE_DIR}/.current_release"
    return 0
  fi
  printf 'none\n'
}

activate_release_symlink() {
  local release_id="$1"
  local release_dir="${BASE_DIR}/releases/${release_id}"
  if [[ "$FLAG_DRY_RUN" -eq 1 ]]; then
    log_dry "ln -sfn ${release_dir} ${BASE_DIR}/current"
    return 0
  fi
  if [[ "$MOCK_MODE" == "1" ]]; then
    # On Windows Git Bash without native symlinks, ln -sfn copies into an existing dir
    [[ -d "${BASE_DIR}/current" && ! -L "${BASE_DIR}/current" ]] && rm -rf "${BASE_DIR}/current"
    ln -sfn "$release_dir" "${BASE_DIR}/current"
    printf '%s\n' "$release_id" > "${BASE_DIR}/.current_release"
  else
    run_priv ln -sfn "$release_dir" "${BASE_DIR}/current"
  fi
  log_ok "Switched ${BASE_DIR}/current -> ${release_dir}"
}

# ==============================================================================
# Step 4: Run (Systemd, Caddy, UFW, IP Mode Health Checks)
# ==============================================================================
install_and_start_services() {
  local mode="${1:-ip}" # ip | domain
  local domain="${2:-}"
  local www_redirect="${3:-no}"

  log_step "4. Configuring systemd, Caddy (${mode} mode) & Firewall"

  local keeper_exec
  keeper_exec="$(resolve_keeper_exec)"
  local unit_path="${SYSTEMD_DIR}/fairbatch-keeper.service"
  local frontend_root="${BASE_DIR}/current/frontend/dist"

  if [[ "$FLAG_DRY_RUN" -eq 1 ]]; then
    log_dry "Render hardened systemd unit to ${unit_path} (User=${SERVICE_USER}, ExecStart=${keeper_exec})"
    log_dry "systemctl daemon-reload && systemctl enable --now fairbatch-keeper"
    log_dry "Render Caddyfile (${mode} mode, /keeper/* -> 127.0.0.1:${DEPLOY_KEEPER_PORT}, SPA /docs) to ${CADDYFILE_PATH}"
    log_dry "caddy validate --config ${CADDYFILE_PATH} && systemctl enable --now caddy && systemctl reload caddy"
    configure_ufw
    return 0
  fi

  local tmp_unit tmp_caddy
  tmp_unit="$(mktemp)"
  tmp_caddy="$(mktemp)"
  render_systemd_unit "$tmp_unit" "$keeper_exec"

  if [[ "$mode" == "domain" && -n "$domain" ]]; then
    render_caddyfile_domain "$tmp_caddy" "$domain" "$www_redirect" "$frontend_root" "$DEPLOY_KEEPER_PORT"
  else
    render_caddyfile_ip "$tmp_caddy" "$frontend_root" "$DEPLOY_KEEPER_PORT"
  fi

  if [[ "$MOCK_MODE" == "1" ]]; then
    mkdir -p "$SYSTEMD_DIR" "$(dirname "$CADDYFILE_PATH")"
    cp "$tmp_unit" "$unit_path"
    cp "$tmp_caddy" "$CADDYFILE_PATH"
    if command -v caddy >/dev/null 2>&1; then
      caddy validate --config "$CADDYFILE_PATH"
    fi
    if command -v systemctl >/dev/null 2>&1; then
      systemctl daemon-reload
      systemctl restart fairbatch-keeper
      systemctl reload caddy
    fi
    log_ok "[MOCK] Installed unit (${unit_path}) and Caddyfile (${CADDYFILE_PATH})."
  else
    run_priv install -m 0644 "$tmp_unit" "$unit_path"
    run_priv install -d -m 0755 "$(dirname "$CADDYFILE_PATH")"
    run_priv install -m 0644 "$tmp_caddy" "$CADDYFILE_PATH"
    run_priv caddy validate --config "$CADDYFILE_PATH" --adapter caddyfile
    run_priv systemctl daemon-reload
    run_priv systemctl enable fairbatch-keeper
    run_priv systemctl restart fairbatch-keeper
    run_priv systemctl enable caddy
    run_priv systemctl reload-or-restart caddy
  fi
  rm -f "$tmp_unit" "$tmp_caddy"

  configure_ufw
}

configure_ufw() {
  if ! command -v ufw >/dev/null 2>&1; then
    log_info "ufw not installed; ensure ports 22, 80, and 443 are open in your cloud firewall / security group."
    return 0
  fi

  if [[ "$FLAG_DRY_RUN" -eq 1 ]]; then
    log_dry "ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp (only enable if SSH 22 verified and confirmed)"
    return 0
  fi

  run_priv ufw allow 22/tcp >/dev/null 2>&1 || true
  run_priv ufw allow 80/tcp >/dev/null 2>&1 || true
  run_priv ufw allow 443/tcp >/dev/null 2>&1 || true
  log_ok "UFW rules added for 22/tcp (SSH), 80/tcp (HTTP), and 443/tcp (HTTPS)."

  local ufw_status
  ufw_status="$(run_priv ufw status 2>/dev/null || true)"
  if [[ "$ufw_status" == *"Status: active"* ]]; then
    log_ok "UFW is already active."
    return 0
  fi

  # Verify SSH (22/tcp or OpenSSH) is explicitly listed before ever enabling ufw
  local added_rules
  added_rules="$(run_priv ufw show added 2>/dev/null || true)"
  if [[ "$added_rules" != *"22/tcp"* && "$added_rules" != *"OpenSSH"* ]]; then
    log_warn "Refusing to enable UFW because SSH (22/tcp) could not be confirmed in UFW rules."
    return 0
  fi

  local should_enable=0
  if [[ "$FLAG_ENABLE_UFW" -eq 1 && "$FLAG_YES" -eq 1 ]]; then
    should_enable=1
  elif [[ "$FLAG_YES" -eq 0 && -t 0 ]]; then
    if prompt_yes_no "SSH port 22 is allowed. Enable UFW firewall now?" "N"; then
      should_enable=1
    fi
  fi

  if [[ "$should_enable" -eq 1 ]]; then
    run_priv ufw --force enable
    log_ok "UFW enabled with SSH (22), HTTP (80), and HTTPS (443) allowed."
  else
    log_info "UFW left inactive (rules staged). Run 'sudo ufw enable' whenever ready."
  fi
}

wait_for_local_health() {
  local timeout_secs="${1:-25}"
  if [[ "$FLAG_DRY_RUN" -eq 1 ]]; then
    log_dry "Poll http://127.0.0.1:${DEPLOY_KEEPER_PORT}/health and http://127.0.0.1/{,docs,keeper/health}"
    return 0
  fi

  if [[ "$MOCK_MODE" == "1" ]]; then
    if [[ "${FAIRBATCH_MOCK_HEALTH_FAIL:-0}" == "1" ]]; then
      log_err "[MOCK] Simulated health-check failure."
      return 1
    fi
    log_ok "[MOCK] Local health checks passed (/, /docs, /keeper/health -> 200)."
    return 0
  fi

  local elapsed=0
  while (( elapsed < timeout_secs )); do
    local k_code root_code docs_code proxy_code
    k_code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${DEPLOY_KEEPER_PORT}/health" || printf '000')"
    root_code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1/" || printf '000')"
    docs_code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1/docs" || printf '000')"
    proxy_code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1/keeper/health" || printf '000')"
    if [[ "$k_code" == "200" && "$root_code" == "200" && "$docs_code" == "200" && "$proxy_code" == "200" ]]; then
      log_ok "Health checks passed: keeper=${k_code}, /=${root_code}, /docs=${docs_code}, /keeper/health=${proxy_code}"
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done

  log_err "Local health checks failed after ${timeout_secs}s."
  return 1
}

# ==============================================================================
# Step 5: Domain & DNS Verification Flow (a–e)
# ==============================================================================
detect_public_ips() {
  if [[ -n "${FAIRBATCH_MOCK_IPV4:-}" ]]; then
    SERVER_IPV4="$FAIRBATCH_MOCK_IPV4"
    SERVER_IPV6="${FAIRBATCH_MOCK_IPV6:-}"
    return 0
  fi

  local svc ip
  for svc in "https://api4.ipify.org" "https://ipv4.icanhazip.com" "https://ifconfig.me/ip"; do
    ip="$(curl -4 -fsSL --max-time 5 "$svc" 2>/dev/null | tr -d '[:space:]' || true)"
    if is_ipv4_address "$ip"; then
      SERVER_IPV4="$ip"
      break
    fi
  done

  for svc in "https://api6.ipify.org" "https://ipv6.icanhazip.com"; do
    ip="$(curl -6 -fsSL --max-time 5 "$svc" 2>/dev/null | tr -d '[:space:]' || true)"
    if is_ipv6_address "$ip"; then
      SERVER_IPV6="$ip"
      break
    fi
  done
}

dig_records() {
  local resolver="$1"
  local rtype="$2"
  local host="$3"
  dig +short +time=4 +tries=1 "@${resolver}" "$host" "$rtype" 2>/dev/null \
    | grep -E '^[0-9a-fA-F.:]+$' || true
}

print_dns_instructions() {
  local domain="$1"
  local www_redirect="$2"

  cat <<EOF

--------------------------------------------------------------------------------
DNS Records to Add at Your DNS Provider
--------------------------------------------------------------------------------
  Type   Host               Value
  -----  -----------------  ----------------------------------------------------
  A      ${domain}          ${SERVER_IPV4:-<YOUR-SERVER-IPV4>}
EOF
  if [[ "$www_redirect" == "yes" ]]; then
    printf '  A      www.%-14s %s   (or CNAME www -> %s)\n' "$domain" "${SERVER_IPV4:-<YOUR-SERVER-IPV4>}" "$domain"
  fi
  if [[ -n "$SERVER_IPV6" ]]; then
    printf '  AAAA   %-17s  %s   (optional; matches this server)\n' "$domain" "$SERVER_IPV6"
  else
    printf '  AAAA   (REMOVE any existing AAAA record for %s — stale AAAA records break HTTPS issuance!)\n' "$domain"
  fi
  cat <<'EOF'

Cloudflare Users (important):
  1. Start with the Cloudflare proxy OFF ("DNS only" / grey cloud) until HTTPS
     certificate issuance succeeds.
  2. If you turn the proxy ON (orange cloud) later, set Cloudflare SSL/TLS mode
     to "Full (strict)". "Flexible" causes infinite HTTP/HTTPS redirect loops.
--------------------------------------------------------------------------------
EOF
}

verify_domain_dns_loop() {
  local domain="$1"
  local www_redirect="$2"
  local auto_retries_left="$DNS_MAX_AUTO_RETRIES"

  while true; do
    local a1 a8 aaaa1 aaaa8 eval_out rc=0
    a1="$(dig_records "1.1.1.1" "A" "$domain")"
    a8="$(dig_records "8.8.8.8" "A" "$domain")"
    aaaa1="$(dig_records "1.1.1.1" "AAAA" "$domain")"
    aaaa8="$(dig_records "8.8.8.8" "AAAA" "$domain")"

    eval_out="$(evaluate_dns_records "$domain" "$SERVER_IPV4" "$SERVER_IPV6" "$a1" "$a8" "$aaaa1" "$aaaa8")" || rc=$?
    if [[ "$rc" -eq 0 && "$www_redirect" == "yes" ]]; then
      local wa1 wa8 waaaa1 waaaa8 w_out w_rc=0
      wa1="$(dig_records "1.1.1.1" "A" "www.${domain}")"
      wa8="$(dig_records "8.8.8.8" "A" "www.${domain}")"
      waaaa1="$(dig_records "1.1.1.1" "AAAA" "www.${domain}")"
      waaaa8="$(dig_records "8.8.8.8" "AAAA" "www.${domain}")"
      w_out="$(evaluate_dns_records "www.${domain}" "$SERVER_IPV4" "$SERVER_IPV6" "$wa1" "$wa8" "$waaaa1" "$waaaa8")" || w_rc=$?
      if [[ "$w_rc" -ne 0 ]]; then
        rc="$w_rc"
        eval_out="$w_out"
      fi
    fi

    if [[ "$rc" -eq 0 ]]; then
      log_ok "$eval_out"
      return 0
    fi

    log_warn "$eval_out"
    printf '  Expected IPv4: %s\n' "$SERVER_IPV4"
    printf '  Found on 1.1.1.1: A=[%s] AAAA=[%s]\n' "${a1//$'\n'/, }" "${aaaa1//$'\n'/, }"
    printf '  Found on 8.8.8.8: A=[%s] AAAA=[%s]\n' "${a8//$'\n'/, }" "${aaaa8//$'\n'/, }"

    if [[ "$FLAG_YES" -eq 1 || ! -t 0 ]]; then
      if (( auto_retries_left > 0 )); then
        auto_retries_left=$((auto_retries_left - 1))
        log_info "Waiting ${DNS_RETRY_WAIT_SECS}s before retrying DNS (${auto_retries_left} retries left)..."
        sleep "$DNS_RETRY_WAIT_SECS"
        continue
      fi
      log_warn "DNS did not match after retries; skipping domain and staying live on server IP."
      return 1
    fi

    printf '\nDNS check did not match yet. Choose an action:\n'
    printf '  1) Retry now\n'
    printf '  2) Wait %ss and auto-retry (up to %s times)\n' "$DNS_RETRY_WAIT_SECS" "$DNS_MAX_AUTO_RETRIES"
    printf '  3) Skip domain (stay live on http://%s)\n' "$SERVER_IPV4"
    local choice=""
    printf 'Selection [1/2/3]: '
    IFS= read -r choice || choice="3"
    case "$choice" in
      1)
        continue
        ;;
      2)
        local n=0
        while (( n < DNS_MAX_AUTO_RETRIES )); do
          n=$((n + 1))
          log_info "Waiting ${DNS_RETRY_WAIT_SECS}s (attempt ${n}/${DNS_MAX_AUTO_RETRIES})..."
          sleep "$DNS_RETRY_WAIT_SECS"
          a1="$(dig_records "1.1.1.1" "A" "$domain")"
          a8="$(dig_records "8.8.8.8" "A" "$domain")"
          aaaa1="$(dig_records "1.1.1.1" "AAAA" "$domain")"
          aaaa8="$(dig_records "8.8.8.8" "AAAA" "$domain")"
          rc=0
          eval_out="$(evaluate_dns_records "$domain" "$SERVER_IPV4" "$SERVER_IPV6" "$a1" "$a8" "$aaaa1" "$aaaa8")" || rc=$?
          if [[ "$rc" -eq 0 ]]; then
            log_ok "$eval_out"
            return 0
          fi
          log_warn "Attempt ${n}: ${eval_out}"
        done
        ;;
      *)
        return 1
        ;;
    esac
  done
}

poll_https_domain() {
  local domain="$1"
  if [[ "$FLAG_DRY_RUN" -eq 1 ]]; then
    log_dry "Poll https://${domain}/, /docs, /keeper/health for valid TLS cert and HTTP 200 (up to ${HTTPS_POLL_TIMEOUT_SECS}s)"
    return 0
  fi
  if [[ "$MOCK_MODE" == "1" ]]; then
    if [[ "${FAIRBATCH_MOCK_HTTPS_FAIL:-0}" == "1" ]]; then
      return 1
    fi
    log_ok "[MOCK] HTTPS verified for https://${domain} (/, /docs, /keeper/health -> 200)."
    return 0
  fi

  local elapsed=0
  log_info "Polling https://${domain} for valid TLS certificate & HTTP 200 (up to ${HTTPS_POLL_TIMEOUT_SECS}s)..."
  while (( elapsed < HTTPS_POLL_TIMEOUT_SECS )); do
    local c_root c_docs c_health
    c_root="$(curl -fsS --max-time 8 -o /dev/null -w '%{http_code}' "https://${domain}/" 2>/dev/null || printf '000')"
    c_docs="$(curl -fsS --max-time 8 -o /dev/null -w '%{http_code}' "https://${domain}/docs" 2>/dev/null || printf '000')"
    c_health="$(curl -fsS --max-time 8 -o /dev/null -w '%{http_code}' "https://${domain}/keeper/health" 2>/dev/null || printf '000')"
    if [[ "$c_root" == "200" && "$c_docs" == "200" && "$c_health" == "200" ]]; then
      log_ok "HTTPS live & verified on https://${domain} (/=${c_root}, /docs=${c_docs}, /keeper/health=${c_health})."
      return 0
    fi
    sleep "$HTTPS_POLL_INTERVAL_SECS"
    elapsed=$((elapsed + HTTPS_POLL_INTERVAL_SECS))
  done
  return 1
}

run_domain_flow() {
  log_step "5. Domain & HTTPS Setup"

  local want_domain=0
  local chosen_domain=""
  local chosen_www="no"

  if [[ "$FLAG_NO_DOMAIN" -eq 1 ]]; then
    log_info "--no-domain specified; staying live on http://${SERVER_IPV4:-<server-ip>}."
    DEPLOY_MODE="ip"
    DEPLOY_DOMAIN=""
    DEPLOY_WWW_REDIRECT="no"
    return 0
  elif [[ -n "$FLAG_DOMAIN" ]]; then
    want_domain=1
    chosen_domain="$FLAG_DOMAIN"
  else
    if prompt_yes_no "Do you want to connect a domain?" "N"; then
      want_domain=1
    else
      log_info "Staying live on IP mode: http://${SERVER_IPV4:-<server-ip>}"
      DEPLOY_MODE="ip"
      DEPLOY_DOMAIN=""
      DEPLOY_WWW_REDIRECT="no"
      return 0
    fi
  fi

  if [[ "$want_domain" -eq 1 ]]; then
    while true; do
      if [[ -z "$chosen_domain" ]]; then
        printf 'Enter your domain name (e.g. fairbatch.example.com): '
        IFS= read -r chosen_domain || chosen_domain=""
      fi
      chosen_domain="$(normalize_domain "$chosen_domain")"
      if validate_domain "$chosen_domain"; then
        break
      fi
      log_err "Invalid domain '${chosen_domain}'. Enter a valid hostname (no IP addresses)."
      if [[ -n "$FLAG_DOMAIN" || "$FLAG_YES" -eq 1 || ! -t 0 ]]; then
        exit 1
      fi
      chosen_domain=""
    done

    if [[ -n "$FLAG_WWW_REDIRECT" ]]; then
      chosen_www="$FLAG_WWW_REDIRECT"
    elif prompt_yes_no "Redirect www.${chosen_domain} to ${chosen_domain}?" "N"; then
      chosen_www="yes"
    else
      chosen_www="no"
    fi

    print_dns_instructions "$chosen_domain" "$chosen_www"

    if [[ "$FLAG_DRY_RUN" -eq 1 ]]; then
      log_dry "Check DNS with dig @1.1.1.1 and @8.8.8.8 for ${chosen_domain} -> ${SERVER_IPV4:-<server-ip>}"
      log_dry "Write HTTPS Caddyfile for ${chosen_domain} (www redirect=${chosen_www}), reload Caddy, poll https://${chosen_domain}/{,docs,keeper/health}"
      DEPLOY_MODE="domain"
      DEPLOY_DOMAIN="$chosen_domain"
      DEPLOY_WWW_REDIRECT="$chosen_www"
      return 0
    fi

    if [[ "$FLAG_YES" -eq 0 && -t 0 ]]; then
      if ! prompt_yes_no "Have you added the DNS record(s)?" "N"; then
        log_info "Skipping domain for now; app remains live on http://${SERVER_IPV4:-<server-ip>}."
        DEPLOY_MODE="ip"
        DEPLOY_DOMAIN=""
        DEPLOY_WWW_REDIRECT="no"
        return 0
      fi
    fi

    if ! verify_domain_dns_loop "$chosen_domain" "$chosen_www"; then
      log_warn "Domain skipped; app remains live on http://${SERVER_IPV4:-<server-ip>}."
      DEPLOY_MODE="ip"
      DEPLOY_DOMAIN=""
      DEPLOY_WWW_REDIRECT="no"
      return 0
    fi

    while true; do
      install_and_start_services "domain" "$chosen_domain" "$chosen_www"
      if poll_https_domain "$chosen_domain"; then
        DEPLOY_MODE="domain"
        DEPLOY_DOMAIN="$chosen_domain"
        DEPLOY_WWW_REDIRECT="$chosen_www"
        return 0
      fi

      log_err "HTTPS verification failed for https://${chosen_domain}."
      cat >&2 <<'EOF'
Likely causes:
  1. Cloud firewall / security group blocking inbound TCP ports 80 or 443.
  2. Stale AAAA (IPv6) record pointing to a different host.
  3. Cloudflare proxy ON with SSL/TLS set to "Flexible" (must be DNS-only first, then "Full (strict)").
EOF
      if [[ "$MOCK_MODE" != "1" ]] && command -v journalctl >/dev/null 2>&1; then
        log_info "Recent Caddy log lines:"
        run_priv journalctl -u caddy -n 30 --no-pager >&2 || true
      fi

      if [[ "$FLAG_YES" -eq 0 && -t 0 ]] && prompt_yes_no "Retry HTTPS verification now?" "N"; then
        continue
      fi

      log_warn "Falling back to IP mode so FairBatch stays live on http://${SERVER_IPV4:-<server-ip>}."
      install_and_start_services "ip" "" "no"
      DEPLOY_MODE="ip"
      DEPLOY_DOMAIN=""
      DEPLOY_WWW_REDIRECT="no"
      return 0
    done
  fi
}

# ==============================================================================
# Step 6 & 7: Persist Non-Secret State, Summary, --update, --rollback, --status
# ==============================================================================
save_deploy_conf() {
  if [[ "$FLAG_DRY_RUN" -eq 1 ]]; then
    log_dry "Save non-secret deployment config to ${CONF_FILE}"
    return 0
  fi

  local tmp_conf
  tmp_conf="$(mktemp)"
  cat > "$tmp_conf" <<EOF
# FairBatch non-secret deployment configuration (managed by deploy.sh)
DEPLOY_MODE=${DEPLOY_MODE}
DEPLOY_DOMAIN=${DEPLOY_DOMAIN}
DEPLOY_WWW_REDIRECT=${DEPLOY_WWW_REDIRECT}
DEPLOY_KEEPER_PORT=${DEPLOY_KEEPER_PORT}
DEPLOY_KEEPER_TYPE=${KEEPER_TYPE}
DEPLOY_SERVER_IPV4=${SERVER_IPV4}
DEPLOY_LAST_RELEASE=${ACTIVE_RELEASE_ID}
EOF

  if [[ "$MOCK_MODE" == "1" ]]; then
    mkdir -p "$(dirname "$CONF_FILE")"
    cp "$tmp_conf" "$CONF_FILE"
  else
    run_priv install -d -m 0750 "$(dirname "$CONF_FILE")"
    run_priv install -m 0644 "$tmp_conf" "$CONF_FILE"
  fi
  rm -f "$tmp_conf"
  log_ok "Saved non-secret state to ${CONF_FILE}."
}

load_deploy_conf() {
  [[ -f "$CONF_FILE" ]] || return 0
  local line key val
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*# || "$line" != *"="* ]] && continue
    key="${line%%=*}"
    val="${line#*=}"
    case "$key" in
      DEPLOY_MODE) DEPLOY_MODE="$val" ;;
      DEPLOY_DOMAIN) DEPLOY_DOMAIN="$val" ;;
      DEPLOY_WWW_REDIRECT) DEPLOY_WWW_REDIRECT="$val" ;;
      DEPLOY_KEEPER_PORT) DEPLOY_KEEPER_PORT="$val" ;;
      DEPLOY_KEEPER_TYPE) KEEPER_TYPE="$val" ;;
      DEPLOY_SERVER_IPV4) SERVER_IPV4="$val" ;;
      DEPLOY_LAST_RELEASE) ACTIVE_RELEASE_ID="$val" ;;
    esac
  done < "$CONF_FILE"
}

print_final_summary() {
  log_step "6. Deployment Summary (Zero Secrets)"
  local keeper_state="dry-run" caddy_state="dry-run"
  if [[ "$FLAG_DRY_RUN" -eq 0 ]]; then
    if [[ "$MOCK_MODE" == "1" ]]; then
      keeper_state="active (mock)"
      caddy_state="active (mock)"
    elif command -v systemctl >/dev/null 2>&1; then
      keeper_state="$(systemctl is-active fairbatch-keeper 2>/dev/null || printf 'inactive')"
      caddy_state="$(systemctl is-active caddy 2>/dev/null || printf 'inactive')"
    fi
  fi

  printf '  Active release:       %s\n' "${ACTIVE_RELEASE_ID:-unknown}"
  printf '  Keeper stack:         %s\n' "${KEEPER_TYPE:-unknown}"
  printf '  Keeper service:       %s (loopback 127.0.0.1:%s)\n' "$keeper_state" "$DEPLOY_KEEPER_PORT"
  printf '  Caddy service:        %s\n' "$caddy_state"
  printf '  Live IP URL:          http://%s\n' "${SERVER_IPV4:-<server-ip>}"
  if [[ "$DEPLOY_MODE" == "domain" && -n "$DEPLOY_DOMAIN" ]]; then
    printf '  Live Domain URL:      https://%s\n' "$DEPLOY_DOMAIN"
    printf '  Live Docs URL:        https://%s/docs\n' "$DEPLOY_DOMAIN"
    printf '  Live Keeper Health:   https://%s/keeper/health\n' "$DEPLOY_DOMAIN"
  else
    printf '  Live Docs URL:        http://%s/docs\n' "${SERVER_IPV4:-<server-ip>}"
    printf '  Live Keeper Health:   http://%s/keeper/health\n' "${SERVER_IPV4:-<server-ip>}"
  fi
  printf '  Keeper address:       %s\n' "${KEEPER_PUBLIC_ADDRESS:-unknown}"
  printf '  Keeper Sepolia ETH:   %s ETH\n' "${KEEPER_SEPOLIA_ETH:-unknown}"

  cat <<EOF

Next steps:
  1. Fund the dedicated keeper wallet (${KEEPER_PUBLIC_ADDRESS:-<keeper-address>}) with ~0.10 Sepolia ETH
     if balance is below ${ENV_VALUES[KEEPER_MIN_BALANCE_ETH]:-0.005} ETH.
  2. Add the live URL to README.md and your Fe Builders Challenge submission form.
  3. Useful operations:
       ./deploy.sh --status      # Check live status, release & balance
       ./deploy.sh --update      # Pull, rebuild, health-check & atomically swap
       ./deploy.sh --rollback    # Revert instantly to the previous release
EOF
}

cmd_status() {
  log_step "FairBatch Deployment Status"
  load_deploy_conf
  local current_rel
  current_rel="$(resolve_active_release_id)"
  ACTIVE_RELEASE_ID="$current_rel"

  if [[ -f "$ENV_FILE" ]]; then
    if [[ "$MOCK_MODE" != "1" && "${EUID:-$(id -u)}" -ne 0 && ! -r "$ENV_FILE" ]]; then
      local tmp_read
      tmp_read="$(umask 077 && mktemp)"
      run_priv cat "$ENV_FILE" > "$tmp_read"
      parse_env_file_safe "$tmp_read"
      rm -f "$tmp_read"
    else
      parse_env_file_safe "$ENV_FILE"
    fi
    DEPLOY_KEEPER_PORT="${ENV_VALUES[KEEPER_PORT]:-$DEPLOY_KEEPER_PORT}"
    if KEEPER_PUBLIC_ADDRESS="$(derive_public_address_from_env 2>/dev/null)"; then
      local rpc_url="${ENV_VALUES[KEEPER_RPC_URL]:-}"
      if [[ -n "$rpc_url" ]]; then
        local b_resp b_hex
        if b_resp="$(rpc_json_call "$rpc_url" "eth_getBalance" "[\"${KEEPER_PUBLIC_ADDRESS}\",\"latest\"]" 2>/dev/null)"; then
          b_hex="$(printf '%s' "$b_resp" | json_extract_rpc_result 2>/dev/null || printf '0x0')"
          KEEPER_SEPOLIA_ETH="$(wei_hex_to_eth "$b_hex")"
        fi
      fi
    fi
  fi

  detect_public_ips
  print_final_summary

  if [[ -d "${BASE_DIR}/releases" ]]; then
    printf '\nAvailable releases (newest first):\n'
    find "${BASE_DIR}/releases" -mindepth 1 -maxdepth 1 -type d | sort -r | while IFS= read -r r; do
      local bn
      bn="$(basename "$r")"
      if [[ "$bn" == "$current_rel" ]]; then
        printf '  * %s (active)\n' "$bn"
      else
        printf '    %s\n' "$bn"
      fi
    done
  fi
}

cmd_rollback() {
  log_step "Rolling Back to Previous Release"
  load_deploy_conf
  local current_link="${BASE_DIR}/current"
  local releases_dir="${BASE_DIR}/releases"

  if [[ ! -L "$current_link" && ! -f "${BASE_DIR}/.current_release" ]]; then
    log_err "No active release at ${current_link}; cannot rollback."
    exit 1
  fi

  local current_rel
  current_rel="$(resolve_active_release_id)"

  local prev_rel=""
  local entry bn
  while IFS= read -r entry; do
    bn="$(basename "$entry")"
    if [[ "$bn" != "$current_rel" ]]; then
      prev_rel="$bn"
      break
    fi
  done < <(find "$releases_dir" -mindepth 1 -maxdepth 1 -type d | sort -r)

  if [[ -z "$prev_rel" ]]; then
    log_err "No previous release found in ${releases_dir} to roll back to."
    exit 1
  fi

  log_info "Switching from ${current_rel} -> ${prev_rel}..."
  if [[ "$FLAG_DRY_RUN" -eq 1 ]]; then
    log_dry "Switch ${current_link} -> ${releases_dir}/${prev_rel} and restart fairbatch-keeper + reload caddy"
    return 0
  fi

  activate_release_symlink "$prev_rel"
  ACTIVE_RELEASE_ID="$prev_rel"

  if [[ "$MOCK_MODE" == "1" ]]; then
    log_ok "[MOCK] Restarted fairbatch-keeper and reloaded caddy."
  else
    run_priv systemctl restart fairbatch-keeper
    run_priv systemctl reload-or-restart caddy
  fi

  wait_for_local_health 25
  save_deploy_conf
  log_ok "Rollback complete! Active release: ${prev_rel}"
}

cmd_update() {
  log_step "Updating FairBatch Deployment"
  load_deploy_conf
  check_os_and_privileges
  verify_env_and_chain

  local prev_release=""
  prev_release="$(resolve_active_release_id)"
  [[ "$prev_release" == "none" ]] && prev_release=""

  if [[ "$FLAG_DRY_RUN" -eq 1 ]]; then
    log_dry "git -C ${REPO_DIR} pull --ff-only"
  elif [[ "$MOCK_MODE" == "1" ]]; then
    log_ok "[MOCK] Skipped git pull in mock update test."
  else
    log_info "Pulling latest changes (fast-forward only)..."
    git -C "$REPO_DIR" pull --ff-only
  fi

  build_release
  activate_release_symlink "$ACTIVE_RELEASE_ID"
  install_and_start_services "${DEPLOY_MODE:-ip}" "${DEPLOY_DOMAIN:-}" "${DEPLOY_WWW_REDIRECT:-no}"

  if ! wait_for_local_health 25; then
    local failed_release="$ACTIVE_RELEASE_ID"
    log_err "New release ${failed_release} failed health check!"
    if [[ -n "$prev_release" && -d "${BASE_DIR}/releases/${prev_release}" ]]; then
      log_warn "Restoring previous working release: ${prev_release}"
      activate_release_symlink "$prev_release"
      ACTIVE_RELEASE_ID="$prev_release"
      if [[ "$MOCK_MODE" == "1" ]]; then
        rm -rf -- "${BASE_DIR}/releases/${failed_release}"
      else
        run_priv systemctl restart fairbatch-keeper
        run_priv systemctl reload-or-restart caddy
        run_priv rm -rf -- "${BASE_DIR}/releases/${failed_release}"
      fi
      log_ok "Previous release ${prev_release} restored (failed release ${failed_release} removed)."
    fi
    exit 1
  fi

  if [[ "$FLAG_DRY_RUN" -eq 0 ]]; then
    prune_old_releases "${BASE_DIR}/releases" "${BASE_DIR}/current" 3
  fi
  detect_public_ips
  save_deploy_conf
  print_final_summary
}

main() {
  parse_args "$@"

  if [[ "$FLAG_STATUS" -eq 1 ]]; then
    cmd_status
    return 0
  fi
  if [[ "$FLAG_ROLLBACK" -eq 1 ]]; then
    cmd_rollback
    return 0
  fi
  if [[ "$FLAG_UPDATE" -eq 1 ]]; then
    cmd_update
    return 0
  fi

  load_deploy_conf
  check_os_and_privileges
  install_missing_dependencies
  verify_env_and_chain
  build_release
  activate_release_symlink "$ACTIVE_RELEASE_ID"

  if [[ "$FLAG_DRY_RUN" -eq 0 ]]; then
    prune_old_releases "${BASE_DIR}/releases" "${BASE_DIR}/current" 3
  fi

  detect_public_ips

  # Go live on IP mode first so the server is verified working before domain/TLS
  install_and_start_services "ip" "" "no"
  wait_for_local_health 25
  log_ok "FairBatch is live in IP mode: http://${SERVER_IPV4:-<server-ip>}"

  # Optional domain + HTTPS flow
  run_domain_flow
  save_deploy_conf
  print_final_summary
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
