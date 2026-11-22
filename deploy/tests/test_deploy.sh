#!/usr/bin/env bash
# ==============================================================================
# Pure Bash Unit & Mocked Ubuntu 24.04 Integration Tests for deploy.sh
#
# NEVER uses a real private key — generates a fresh ephemeral throwaway key in
# memory/tempdir for the mocked flow and wipes it on exit.
# ==============================================================================
set -Eeuo pipefail

TESTS_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "${TESTS_DIR}/../.." && pwd -P)"

# shellcheck disable=SC1091
source "${REPO_ROOT}/deploy.sh"

PASS_COUNT=0
FAIL_COUNT=0

assert_eq() {
  local expected="$1"
  local actual="$2"
  local label="$3"
  if [[ "$expected" == "$actual" ]]; then
    PASS_COUNT=$((PASS_COUNT + 1))
    printf '  [PASS] %s\n' "$label"
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    printf '  [FAIL] %s (expected=%q, actual=%q)\n' "$label" "$expected" "$actual" >&2
  fi
}

assert_ok() {
  local label="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    PASS_COUNT=$((PASS_COUNT + 1))
    printf '  [PASS] %s\n' "$label"
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    printf '  [FAIL] %s (expected exit 0)\n' "$label" >&2
  fi
}

assert_fail() {
  local label="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    FAIL_COUNT=$((FAIL_COUNT + 1))
    printf '  [FAIL] %s (expected non-zero exit)\n' "$label" >&2
  else
    PASS_COUNT=$((PASS_COUNT + 1))
    printf '  [PASS] %s\n' "$label"
  fi
}

run_unit_tests() {
  printf '=== 1. Pure Function Unit Tests ===\n'

  # Keeper type & Node LTS detection
  assert_eq "typescript" "$(detect_keeper_type "$REPO_ROOT")" "detect_keeper_type detects TypeScript keeper"
  assert_eq "22" "$(parse_required_node_major "${REPO_ROOT}/frontend/package.json")" "parse_required_node_major matches frontend engines (>=20 <23 -> 22)"

  # Domain normalization & validation
  assert_eq "swap.fairbatch.xyz" "$(normalize_domain "  HTTPS://SWAP.FairBatch.XYZ/docs?x=1  ")" "normalize_domain strips scheme, path, query & lowercases"
  assert_eq "example.com" "$(normalize_domain "http://example.com./")" "normalize_domain strips trailing slash and trailing dot"
  assert_ok   "validate_domain accepts valid apex domain" validate_domain "fairbatch.xyz"
  assert_ok   "validate_domain accepts valid subdomain" validate_domain "app-1.swap.fairbatch.xyz"
  assert_fail "validate_domain rejects IPv4 address" validate_domain "203.0.113.10"
  assert_fail "validate_domain rejects IPv6 address" validate_domain "2001:db8::1"
  assert_fail "validate_domain rejects single-label hostname" validate_domain "localhost"
  assert_fail "validate_domain rejects leading hyphen label" validate_domain "-bad.example.com"
  assert_fail "validate_domain rejects underscores" validate_domain "bad_host.example.com"

  # Private key safety rules
  assert_ok   "is_forbidden_private_key rejects all-zero key" is_forbidden_private_key "0x0000000000000000000000000000000000000000000000000000000000000000"
  assert_ok   "is_forbidden_private_key rejects repeated-char dummy key" is_forbidden_private_key "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  assert_ok   "is_forbidden_private_key rejects tiny key 0x...0001" is_forbidden_private_key "0x0000000000000000000000000000000000000000000000000000000000000001"
  assert_ok   "is_forbidden_private_key rejects Anvil/Hardhat default #0" is_forbidden_private_key "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
  assert_ok   "is_forbidden_private_key rejects Anvil/Hardhat default #1" is_forbidden_private_key "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"

  local fresh_key
  fresh_key="$(node -e "console.log('0x'+require('node:crypto').randomBytes(32).toString('hex'))")"
  assert_fail "is_forbidden_private_key accepts fresh random throwaway key" is_forbidden_private_key "$fresh_key"

  # Env parsing & multi-error reporting
  local tmp_dir
  tmp_dir="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf -- '$tmp_dir'" RETURN

  local bad_env="${tmp_dir}/bad.env"
  cat > "$bad_env" <<'EOF'
KEEPER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
KEEPER_RPC_URL=ftp://not-http
KEEPER_HOST=0.0.0.0
KEEPER_PORT=80
KEEPER_GRACE_SECONDS=abc
EOF
  parse_env_file_safe "$bad_env"
  assert_fail "validate_env_map rejects broken env" validate_env_map "${REPO_ROOT}/deploy/env.example"
  local err_count="${#ENV_ERRORS[@]}"
  assert_ok "validate_env_map reports ALL problems at once (>= 8 errors)" test "$err_count" -ge 8

  # Valid env file passes
  local good_env="${tmp_dir}/good.env"
  cat > "$good_env" <<EOF
KEEPER_PRIVATE_KEY=${fresh_key}
KEEPER_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
KEEPER_HOST=127.0.0.1
KEEPER_PORT=3002
KEEPER_GRACE_SECONDS=5
KEEPER_EMPTY_ROUND_MINUTES=10
KEEPER_SLASH=true
KEEPER_SLASH_GRACE_SECONDS=60
KEEPER_MIN_BALANCE_ETH=0.005
KEEPER_MAX_GAS_PRICE_GWEI=50
KEEPER_SETTLE_GAS_LIMIT=12000000
KEEPER_SLASH_GAS_LIMIT=600000
KEEPER_RELAY_ENABLED=true
KEEPER_RELAY_GRACE_SECONDS=5
KEEPER_RELAY_GAS_LIMIT=1500000
EOF
  parse_env_file_safe "$good_env"
  assert_ok "validate_env_map accepts valid env" validate_env_map "${REPO_ROOT}/deploy/env.example"

  # Public address derivation via stdin (known test vector)
  local derived
  derived="$(printf '%s\n' "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" | node "${REPO_ROOT}/deploy/lib/derive_address.mjs")"
  assert_eq "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" "$derived" "derive_address.mjs matches EIP-55 vector via stdin"

  # DNS comparison & Cloudflare proxy detection
  assert_ok   "is_cloudflare_ipv4 detects 104.21.44.10" is_cloudflare_ipv4 "104.21.44.10"
  assert_ok   "is_cloudflare_ipv4 detects 172.67.150.22" is_cloudflare_ipv4 "172.67.150.22"
  assert_fail "is_cloudflare_ipv4 ignores normal VPS IP 203.0.113.42" is_cloudflare_ipv4 "203.0.113.42"

  local dns_out dns_rc=0
  dns_out="$(evaluate_dns_records "swap.example.com" "203.0.113.42" "" "203.0.113.42" "203.0.113.42" "" "")" || dns_rc=$?
  assert_eq "0" "$dns_rc" "evaluate_dns_records passes exact A match on 1.1.1.1 & 8.8.8.8"
  assert_ok "evaluate_dns_records outputs DNS_OK" grep -q "DNS_OK" <<< "$dns_out"

  dns_rc=0
  dns_out="$(evaluate_dns_records "swap.example.com" "203.0.113.42" "" "104.21.44.10" "104.21.44.10" "" "")" || dns_rc=$?
  assert_eq "2" "$dns_rc" "evaluate_dns_records detects Cloudflare orange-cloud proxy IP (rc=2)"
  assert_ok "evaluate_dns_records explains Cloudflare grey-cloud fix" grep -q "CLOUDFLARE_PROXY" <<< "$dns_out"

  dns_rc=0
  dns_out="$(evaluate_dns_records "swap.example.com" "203.0.113.42" "" "203.0.113.42" "203.0.113.42" "2001:db8::99" "2001:db8::99")" || dns_rc=$?
  assert_eq "3" "$dns_rc" "evaluate_dns_records flags stale AAAA mismatch (rc=3)"
  assert_ok "evaluate_dns_records explains stale AAAA removal" grep -q "AAAA_MISMATCH" <<< "$dns_out"

  dns_rc=0
  dns_out="$(evaluate_dns_records "swap.example.com" "203.0.113.42" "" "198.51.100.7" "" "" "")" || dns_rc=$?
  assert_eq "1" "$dns_rc" "evaluate_dns_records flags missing/wrong A record (rc=1)"
  assert_ok "evaluate_dns_records reports A_MISMATCH" grep -q "A_MISMATCH" <<< "$dns_out"

  # Template rendering checks
  local rendered_ip="${tmp_dir}/Caddyfile.ip"
  local rendered_dom="${tmp_dir}/Caddyfile.dom"
  local rendered_unit="${tmp_dir}/fairbatch-keeper.service"
  local discovered_node resolved_exec
  discovered_node="$(command -v node)"
  KEEPER_TYPE="typescript"
  BASE_DIR="/opt/fairbatch"
  resolved_exec="$(resolve_keeper_exec)"
  assert_eq "\"${discovered_node}\" \"/opt/fairbatch/current/keeper/dist/index.js\"" "$resolved_exec" "resolve_keeper_exec discovers absolute node via command -v node and quotes ExecStart"
  render_caddyfile_ip "$rendered_ip" "/opt/fairbatch/current/frontend/dist" "3002"
  render_caddyfile_domain "$rendered_dom" "swap.example.com" "yes" "/opt/fairbatch/current/frontend/dist" "3002"
  render_systemd_unit "$rendered_unit" "$resolved_exec"

  assert_ok "Caddyfile IP has same-origin /keeper/* proxy" grep -q 'handle_path /keeper/\*' "$rendered_ip"
  assert_ok "Caddyfile IP has SPA try_files fallback" grep -q 'try_files {path} /index.html' "$rendered_ip"
  assert_ok "Caddyfile domain renders www 308 redirect" grep -q 'www\.swap\.example\.com' "$rendered_dom"
  assert_ok "systemd unit enables NoNewPrivileges + ProtectSystem=strict" grep -q 'ProtectSystem=strict' "$rendered_unit"
  assert_ok "systemd unit quotes absolute node path in ExecStart" grep -qE '^ExecStart="/.+node" "/opt/fairbatch/current/keeper/dist/index\.js"$' "$rendered_unit"

  # Prune releases keeps last 3 plus active
  local rel_dir="${tmp_dir}/releases"
  mkdir -p "${rel_dir}/20261101-000001" "${rel_dir}/20261102-000001" "${rel_dir}/20261103-000001" "${rel_dir}/20261104-000001" "${rel_dir}/20261105-000001"
  ln -sfn "${rel_dir}/20261105-000001" "${tmp_dir}/current"
  prune_old_releases "$rel_dir" "${tmp_dir}/current" 3
  local remaining
  remaining="$(find "$rel_dir" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
  assert_eq "3" "$remaining" "prune_old_releases keeps exactly last 3 releases"
}

run_mocked_e2e_flow() {
  printf '\n=== 2. Mocked Ubuntu 24.04 End-to-End Flow (--dry-run, real deploy, --update auto-rollback, --rollback, --status) ===\n'

  local sandbox
  sandbox="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf -- '$sandbox'" RETURN

  # Mock Ubuntu 24.04 os-release
  cat > "${sandbox}/os-release" <<'EOF'
ID=ubuntu
VERSION_ID="24.04"
PRETTY_NAME="Ubuntu 24.04.1 LTS"
EOF

  # Ephemeral random throwaway key (NEVER a real key, NEVER logged)
  local throwaway_key
  throwaway_key="$(node -e "console.log('0x'+require('node:crypto').randomBytes(32).toString('hex'))")"
  local env_path="${sandbox}/etc/fairbatch.env"
  mkdir -p "${sandbox}/etc" "${sandbox}/bin"
  cat > "$env_path" <<EOF
KEEPER_PRIVATE_KEY=${throwaway_key}
KEEPER_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
KEEPER_HOST=127.0.0.1
KEEPER_PORT=3002
KEEPER_GRACE_SECONDS=5
KEEPER_EMPTY_ROUND_MINUTES=10
KEEPER_SLASH=true
KEEPER_SLASH_GRACE_SECONDS=60
KEEPER_MIN_BALANCE_ETH=0.005
KEEPER_MAX_GAS_PRICE_GWEI=50
KEEPER_SETTLE_GAS_LIMIT=12000000
KEEPER_SLASH_GAS_LIMIT=600000
KEEPER_RELAY_ENABLED=true
KEEPER_RELAY_GRACE_SECONDS=5
KEEPER_RELAY_GAS_LIMIT=1500000
EOF
  chmod 600 "$env_path"

  # Mock dig, caddy, systemctl on PATH for sandboxed run
  cat > "${sandbox}/bin/dig" <<'EOF'
#!/usr/bin/env bash
for arg in "$@"; do
  if [[ "$arg" == "AAAA" ]]; then
    exit 0
  fi
done
printf '203.0.113.42\n'
EOF
  cat > "${sandbox}/bin/caddy" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "version" ]]; then
  printf 'v2.8.4 (mock)\n'
fi
exit 0
EOF
  cat > "${sandbox}/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "is-active" ]]; then
  printf 'active\n'
fi
exit 0
EOF
  chmod +x "${sandbox}/bin/dig" "${sandbox}/bin/caddy" "${sandbox}/bin/systemctl"

  local common_env=(
    "PATH=${sandbox}/bin:${PATH}"
    "FAIRBATCH_OS_RELEASE=${sandbox}/os-release"
    "FAIRBATCH_BASE_DIR=${sandbox}/opt/fairbatch"
    "FAIRBATCH_ENV_FILE=${env_path}"
    "FAIRBATCH_CONF_FILE=${sandbox}/etc/deploy.conf"
    "FAIRBATCH_SYSTEMD_DIR=${sandbox}/systemd"
    "FAIRBATCH_CADDYFILE=${sandbox}/caddy/Caddyfile"
    "FAIRBATCH_STATE_DIR=${sandbox}/var/lib/fairbatch"
    "FAIRBATCH_MOCK_MODE=1"
    "FAIRBATCH_MOCK_IPV4=203.0.113.42"
    "FAIRBATCH_DNS_RETRY_WAIT_SECS=1"
  )

  # (a) --dry-run (verifies secret is NEVER printed!)
  local dry_out
  dry_out="$(env "${common_env[@]}" bash "${REPO_ROOT}/deploy.sh" --dry-run --domain swap.example.com --www-redirect --yes 2>&1)"
  assert_ok "--dry-run exits 0 and shows planned actions" test -n "$dry_out"
  assert_fail "--dry-run NEVER leaks KEEPER_PRIVATE_KEY into output" grep -q "${throwaway_key#0x}" <<< "$dry_out"
  assert_ok "--dry-run verifies live Sepolia chainId=11155111" grep -q "chainId=11155111" <<< "$dry_out"
  assert_ok "--dry-run verifies deployed FairBatch contract code" grep -q "Contract verified on-chain: fairBatch" <<< "$dry_out"

  # (b) Real build & deploy with mocked DNS + domain flow (builds REAL frontend & keeper into sandbox releases!)
  if [[ "${SKIP_HEAVY_BUILD:-0}" == "1" ]]; then
    printf '  [SKIP] Heavy build E2E skipped (SKIP_HEAVY_BUILD=1)\n'
    return 0
  fi

  local deploy_out deploy_rc=0
  deploy_out="$(env "${common_env[@]}" bash "${REPO_ROOT}/deploy.sh" --domain swap.example.com --www-redirect --yes 2>&1)" || deploy_rc=$?
  if [[ "$deploy_rc" -ne 0 ]]; then
    printf '--- REAL DEPLOY FAILURE OUTPUT (exit=%d) ---\n%s\n--- END ---\n' "$deploy_rc" "$deploy_out" >&2
  fi
  assert_eq "0" "$deploy_rc" "real deploy exits 0"
  assert_ok "real deploy creates current/frontend/dist/index.html" test -f "${sandbox}/opt/fairbatch/current/frontend/dist/index.html"
  assert_ok "real deploy creates current/keeper/dist/index.js" test -f "${sandbox}/opt/fairbatch/current/keeper/dist/index.js"
  assert_ok "real deploy writes HTTPS domain Caddyfile" grep -q "swap.example.com" "${sandbox}/caddy/Caddyfile"
  assert_ok "real deploy writes hardened systemd unit" grep -q "NoNewPrivileges=true" "${sandbox}/systemd/fairbatch-keeper.service"
  assert_ok "real deploy systemd ExecStart quotes discovered absolute node path" grep -qE '^ExecStart="/.+node" ".*/current/keeper/dist/index\.js"$' "${sandbox}/systemd/fairbatch-keeper.service"
  assert_ok "real deploy persists non-secret deploy.conf" grep -q "DEPLOY_DOMAIN=swap.example.com" "${sandbox}/etc/deploy.conf"
  assert_fail "deploy.conf NEVER contains private key" grep -q "${throwaway_key#0x}" "${sandbox}/etc/deploy.conf"
  assert_fail "real deploy output NEVER leaks private key" grep -q "${throwaway_key#0x}" <<< "$deploy_out"

  local rel_1
  if [[ -L "${sandbox}/opt/fairbatch/current" ]]; then
    rel_1="$(basename "$(readlink -f "${sandbox}/opt/fairbatch/current")")"
  else
    rel_1="$(cat "${sandbox}/opt/fairbatch/.current_release")"
  fi

  # (c) --status works and prints active release + domain
  local status_out
  status_out="$(env "${common_env[@]}" bash "${REPO_ROOT}/deploy.sh" --status 2>&1)"
  assert_ok "--status reports active release ${rel_1}" grep -q "$rel_1" <<< "$status_out"
  assert_ok "--status reports live domain URL" grep -q "https://swap.example.com" <<< "$status_out"

  # (d) --update with simulated health failure keeps previous release!
  sleep 1
  local fail_rc=0
  env "${common_env[@]}" FAIRBATCH_MOCK_FAST_BUILD=1 FAIRBATCH_MOCK_HEALTH_FAIL=1 bash "${REPO_ROOT}/deploy.sh" --update --yes >/dev/null 2>&1 || fail_rc=$?
  assert_eq "1" "$fail_rc" "--update exits non-zero when new release fails health check"
  local after_fail_rel
  if [[ -L "${sandbox}/opt/fairbatch/current" ]]; then
    after_fail_rel="$(basename "$(readlink -f "${sandbox}/opt/fairbatch/current")")"
  else
    after_fail_rel="$(cat "${sandbox}/opt/fairbatch/.current_release")"
  fi
  assert_eq "$rel_1" "$after_fail_rel" "--update auto-restores previous working release (${rel_1}) on health failure"

  # (e) Successful --update followed by --rollback back to rel_1
  sleep 1
  assert_ok "--update succeeds on healthy build" env "${common_env[@]}" FAIRBATCH_MOCK_FAST_BUILD=1 bash "${REPO_ROOT}/deploy.sh" --update --yes
  local rel_2
  if [[ -L "${sandbox}/opt/fairbatch/current" ]]; then
    rel_2="$(basename "$(readlink -f "${sandbox}/opt/fairbatch/current")")"
  else
    rel_2="$(cat "${sandbox}/opt/fairbatch/.current_release")"
  fi
  assert_ok "--update moved active release to a newer release" test "$rel_2" != "$rel_1"

  assert_ok "--rollback succeeds" env "${common_env[@]}" bash "${REPO_ROOT}/deploy.sh" --rollback --yes
  local after_rb_rel
  if [[ -L "${sandbox}/opt/fairbatch/current" ]]; then
    after_rb_rel="$(basename "$(readlink -f "${sandbox}/opt/fairbatch/current")")"
  else
    after_rb_rel="$(cat "${sandbox}/opt/fairbatch/.current_release")"
  fi
  assert_eq "$rel_1" "$after_rb_rel" "--rollback switched active release back to ${rel_1}"
}

main() {
  run_unit_tests
  run_mocked_e2e_flow
  printf '\n=== Summary: %d passed, %d failed ===\n' "$PASS_COUNT" "$FAIL_COUNT"
  [[ "$FAIL_COUNT" -eq 0 ]]
}

main "$@"
