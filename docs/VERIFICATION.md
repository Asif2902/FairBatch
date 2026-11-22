# FairBatch Verification Record

This document records the exact commands, tool versions, pass counts, and verbatim terminal output collected from a **fresh clone** of the pushed GitHub remote (`https://github.com/Asif2902/FairBatch.git`).

> **GitHub Actions CI note:** Continuous integration is configured in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) (`ubuntu-latest`, Fe `v26.5.0`, Node 22, Rust stable, `shellcheck`, live bytecode verification, and full `deploy.sh` tests); GitHub Actions jobs could not start on this account because the account is locked due to a billing issue (observed on run `44916951422`), so no CI badge is shown and the complete fresh-clone verification run is captured verbatim below.

---

## Run Metadata

| Field | Value |
| :--- | :--- |
| **Verification Date (UTC)** | `2026-11-22T18:19:06Z` (completed `2026-11-22T18:39Z`) |
| **Remote URL** | `https://github.com/Asif2902/FairBatch.git` |
| **Verified Fresh-Clone Commit SHA** | `43c40e45fd3e1ad1763b787c23c6f9554a032c1e` *(this `docs/VERIFICATION.md` file is committed immediately on top with zero code, contract, or script changes)* |
| **Sepolia Redeploy Freeze Audit (`ff98649..HEAD`)** | `git diff ff98649..HEAD -- src/ ':(exclude)src/tests.fe'` is **empty** (0 production contract changes); `src/tests.fe` had only `fe fmt` whitespace formatting in `d5239106`. |

## Tool Versions

| Tool | Exact Version |
| :--- | :--- |
| **Fe compiler (`fe`)** | `fe 26.5.0 (3dab95f)` |
| **Node.js (`node`)** | `v22.22.3` |
| **npm (`npm`)** | `10.9.8` |
| **Rust Cargo (`cargo`)** | `cargo 1.94.0 (85eff7c80 2026-01-15)` |
| **Rust Compiler (`rustc`)** | `rustc 1.94.0 (4a4ef493e 2026-03-02)` |
| **ShellCheck (`shellcheck`)** | `0.10.0` |

## Pass Counts Summary

| Suite | Command(s) | Result |
| :--- | :--- | :--- |
| **Fe Smart Contracts** | `fe fmt --check && fe check && fe test && fe build` | **69 passed, 0 failed**; all bytecode & ABI artifacts emitted |
| **Deployed Sepolia Bytecode** | `node scripts/verify_deployed_bytecode.mjs` | **4/4 contracts matched byte-for-byte** (static runtime prefix + reconstructed Sonatina immutable trailer; 0 masked bytes) |
| **Rust Reference Verifier (`backend/`)** | `cd backend && cargo test` | **30 passed, 0 failed** (20 unit + 10 integration/parity) |
| **Frontend (`frontend/`, Node 22)** | `cd frontend && npm ci && npm test && npm run build` | **54 passed, 0 failed** (5 Vitest files); clean `tsc -b && vite build` |
| **Optional Keeper (`keeper/`, Node 22)** | `cd keeper && npm ci && npm test && npm run build` | **10 passed, 0 failed** (2 Vitest files); clean `tsc` build |
| **Deploy Script Linting** | `shellcheck -s bash deploy.sh deploy/tests/test_deploy.sh && bash -n deploy.sh deploy/tests/test_deploy.sh` | **0 warnings, 0 errors** |
| **Deploy Script Tests** | `SKIP_HEAVY_BUILD=1 bash deploy/tests/test_deploy.sh` | **43 passed, 0 failed** *(clean `frontend` & `keeper` builds already verified directly above; `.github/workflows/ci.yml` runs full `bash deploy/tests/test_deploy.sh` on `ubuntu-latest`)* |

---

## Exact Commands Executed

```sh
git clone https://github.com/Asif2902/FairBatch.git /tmp/fairbatch-stage-h-verify
cd /tmp/fairbatch-stage-h-verify
git rev-parse HEAD
git diff --stat ff98649..HEAD -- src/
git diff --stat ff98649..HEAD -- src/ ':(exclude)src/tests.fe'
fe fmt --check && fe check && fe test && fe build
node scripts/verify_deployed_bytecode.mjs
(cd backend && cargo test)
(cd frontend && npm ci --no-audit --no-fund && npm test && npm run build)
(cd keeper && npm ci --no-audit --no-fund && npm test && npm run build)
shellcheck -s bash deploy.sh deploy/tests/test_deploy.sh
bash -n deploy.sh deploy/tests/test_deploy.sh
SKIP_HEAVY_BUILD=1 bash deploy/tests/test_deploy.sh
```

---

## Verbatim Fresh-Clone Output

```text
﻿Verification Date (UTC): 2026-11-22T18:19:06Z
=== Tool Versions ===
fe:         fe 26.5.0 (3dab95f)
node:       v22.22.3
npm:        10.9.8
cargo:      cargo 1.94.0 (85eff7c80 2026-01-15)
rustc:      rustc 1.94.0 (4a4ef493e 2026-03-02)
shellcheck: version: 0.10.0

>>> git clone https://github.com/Asif2902/FairBatch.git
Cloning into 'C:\Users\Asif\AppData\Local\Temp\fairbatch-stage-h-verify'...
Fresh-clone HEAD: 43c40e45fd3e1ad1763b787c23c6f9554a032c1e

>>> git diff --stat ff98649..HEAD -- src/ (and excluding src/tests.fe)
-- All src/ --
 src/tests.fe | 60 ++++++++++++++++++++++++++++++++++++++++--------------------
 1 file changed, 40 insertions(+), 20 deletions(-)
-- Production contracts only (excluding src/tests.fe) --
(empty - zero production contract changes since ff98649)

>>> fe fmt --check

>>> fe check

>>> fe test
PASS  [0.0006s] effect_mocked_clock_transitions
PASS  [0.0002s] effect_revert_open_window_blocked_when_ready_to_settle
PASS  [0.0005s] effect_revert_faucet_cooldown_active_with_mock_clock
PASS  [0.0007s] effect_lp_lock_expiry_before_and_after_unlock
PASS  [0.0000s] effect_slashable_window_mock_clock
PASS  [0.0003s] effect_revert_lp_lock_rejects_locked_shares_before_unlock
PASS  [0.0001s] effect_revert_reveal_window_blocked_when_ready_to_settle
PASS  [0.0012s] effect_faucet_cooldown_before_and_after_with_mock_clock
PASS  [0.0008s] effect_revert_intent_window_blocked_when_ready_to_settle
PASS  [0.0009s] evm_faucet_claim_transfers_exact_amounts_and_tracks_cooldown
PASS  [0.0016s] eip712_ecdsa_recover_and_tamper_rejection
PASS  [0.0026s] evm_commit_reveal_bond_refund_to_stateful_receiver
PASS  [0.0027s] evm_basic_lifecycle_weth_usdc_6dec
PASS  [0.0023s] evm_liquidity_first_deposit_min_liquidity_and_unused_side_refund
PASS  [0.0043s] evm_eip712_erc1271_smart_wallet_intent
PASS  [0.0027s] evm_liquidity_lock_optional_and_partial_withdrawal
PASS  [0.0052s] evm_eip712_eoa_signed_intent_gasless_relayer
PASS  [0.0035s] evm_multi_batch_rollover_and_lp_withdraw
PASS  [0.0066s] evm_blacklisted_usdc_user_never_blocks_settlement
PASS  [0.0030s] evm_multicall_batch_claim_across_orders
PASS  [0.0020s] evm_revert_add_liquidity_locked_slippage_min_shares
PASS  [0.0073s] evm_commit_reveal_bond_refund_and_unrevealed_slashing
PASS  [0.0020s] evm_revert_add_liquidity_slippage_min_shares
PASS  [0.0022s] evm_revert_bad_reveal_salt
PASS  [0.0019s] evm_revert_early_settle_before_reveal_deadline
PASS  [0.0025s] evm_revert_double_claim
PASS  [0.0056s] evm_reentrancy_mutex_blocks_malicious_token_callback
PASS  [0.0023s] evm_revert_eip712_skipped_nonce
PASS  [0.0023s] evm_revert_eip712_wrong_batch_id
PASS  [0.0046s] evm_revert_dust_order_below_minimum
PASS  [0.0022s] evm_revert_expired_eip712_deadline
PASS  [0.0054s] evm_revert_commit_cap_at_65th_commit
PASS  [0.0018s] evm_revert_first_deposit_below_minimum_liquidity
PASS  [0.0057s] evm_revert_direct_order_blocked_by_reserved_commit_slot
PASS  [0.0025s] evm_revert_faucet_double_claim_during_cooldown
PASS  [0.0117s] evm_five_distinct_traders_uniform_execution
PASS  [0.0021s] evm_revert_remove_liquidity_slippage_min_base
PASS  [0.0018s] evm_revert_remove_locked_liquidity
PASS  [0.0026s] evm_revert_payable_multicall_double_value_attack
PASS  [0.0003s] evm_revert_unauthorized_token_blacklist
PASS  [0.0027s] evm_revert_remove_liquidity_slippage_min_quote
PASS  [0.0025s] evm_revert_replayed_eip712_intent
PASS  [0.0005s] proof_mev_sandwich_zero_profit
PASS  [0.0005s] property_lnd_invariant_across_imbalanced_regimes
PASS  [0.0033s] evm_revert_slash_already_slashed
PASS  [0.0034s] evm_revert_slash_before_reveal_expiry
PASS  [0.0019s] evm_revert_unauthorized_token_mint
PASS  [0.0000s] pure_commitment_hash_determinism_and_sensitivity
PASS  [0.0025s] evm_revert_slash_revealed_commit
PASS  [0.0003s] pure_empty_batch_preserves_reserves
PASS  [0.0006s] pure_cow_balanced_zero_slippage
PASS  [0.0007s] pure_decimal_scaling_weth18_usdc6_solvency
PASS  [0.0012s] pure_clearing_equal_prices_and_tiny_amounts_rounding
PASS  [0.0057s] evm_revert_order_cap_at_65th_order
PASS  [0.0012s] property_order_permutation_invariance
PASS  [0.0025s] evm_token_owner_and_authorized_minter_succeed
PASS  [0.0000s] pure_math_helpers_floor_rounding_and_price
PASS  [0.0006s] pure_marginal_buyer_tier_pinning_pro_rata
PASS  [0.0008s] pure_five_eth_sellers_uniform_price
PASS  [0.0004s] pure_p2p_one_sided_and_non_crossing_refunds
PASS  [0.0006s] pure_marginal_seller_tier_pinning_pro_rata
PASS  [0.0006s] pure_p2p_zero_reserves_crossing
PASS  [0.0006s] pure_p2p_rounding_solvency_stress
PASS  [0.0007s] pure_out_of_the_money_orders_full_refund
PASS  [0.0005s] regression_counterexample_b_tiny_reserve_base_solvency
PASS  [0.0005s] regression_counterexample_a_buyer_denominator_lnd
PASS  [0.0004s] regression_dust_weth_to_6dec_usdc_zero_payout_refunded
PASS  [0.0006s] regression_counterexample_c_marginal_pro_rata_spot_pin_lnd
PASS  [0.0104s] evm_settle_full_64_order_batch

test result: ok. 69 passed; 0 failed

>>> fe build
Wrote \\?\C:\Users\Asif\AppData\Local\Temp\fairbatch-stage-h-verify\out/FairBatch.bin
Wrote \\?\C:\Users\Asif\AppData\Local\Temp\fairbatch-stage-h-verify\out/FairBatch.runtime.bin
Wrote \\?\C:\Users\Asif\AppData\Local\Temp\fairbatch-stage-h-verify\out/Faucet.bin
Wrote \\?\C:\Users\Asif\AppData\Local\Temp\fairbatch-stage-h-verify\out/Faucet.runtime.bin
Wrote \\?\C:\Users\Asif\AppData\Local\Temp\fairbatch-stage-h-verify\out/MaliciousReentrantERC20.bin
Wrote \\?\C:\Users\Asif\AppData\Local\Temp\fairbatch-stage-h-verify\out/MaliciousReentrantERC20.runtime.bin
Wrote \\?\C:\Users\Asif\AppData\Local\Temp\fairbatch-stage-h-verify\out/MockERC20.bin
Wrote \\?\C:\Users\Asif\AppData\Local\Temp\fairbatch-stage-h-verify\out/MockERC20.runtime.bin
Wrote \\?\C:\Users\Asif\AppData\Local\Temp\fairbatch-stage-h-verify\out/TraderActor.bin
Wrote \\?\C:\Users\Asif\AppData\Local\Temp\fairbatch-stage-h-verify\out/TraderActor.runtime.bin
Wrote \\?\C:\Users\Asif\AppData\Local\Temp\fairbatch-stage-h-verify\out/Faucet.abi.json
Wrote \\?\C:\Users\Asif\AppData\Local\Temp\fairbatch-stage-h-verify\out/FairBatch.abi.json
Wrote \\?\C:\Users\Asif\AppData\Local\Temp\fairbatch-stage-h-verify\out/MockERC20.abi.json
Wrote \\?\C:\Users\Asif\AppData\Local\Temp\fairbatch-stage-h-verify\out/MaliciousReentrantERC20.abi.json
Wrote \\?\C:\Users\Asif\AppData\Local\Temp\fairbatch-stage-h-verify\out/TraderActor.abi.json

>>> node scripts/verify_deployed_bytecode.mjs
FairBatch Deployed Bytecode Verification (Ethereum Sepolia, chainId=11155111)
RPC: https://ethereum-sepolia-rpc.publicnode.com
Method: Exact static prefix comparison (out/*.runtime.bin) + exact immutable trailer reconstruction from config/deployment.json (0 bytes masked).

[PASS] FairBatch (0x6fa21b7ada82e8b04fca51fdc60793c3fd80265f) -> 23038 B = 22686 B static prefix + 352 B immutables
       static sha256:   57cb7240176c487a33109ad7be7566fa4065eb0bfb93929161d16c209015af35
       deployed sha256: 51c012fa62c1d1b961246298ffdfe4061327d9405c70acb8ca4ef0a812d4aed7
       immutables:      base/quote tokens, decimals (18/6), windows (60s/60s), minBond (100000000000000 wei), EIP-712 Domain + domainSeparator 0x5f0204041a131fe55ebf032359d28559fb9d9caeddf81c37e11fcb05fc6c8ef5
[PASS] baseToken (fWETH) (0xe9903189bf3e418759feb26f11a7d1c99be0e556) -> 1594 B = 1530 B static prefix + 64 B immutables
       static sha256:   b07e38cee1dddb19ae183ddf9fa3b7bdd452ddb44e26a97c9b31dbaee8576009
       deployed sha256: 87c0009414de4d2cb59f3c8fb6ae0fe0c6a4802f1803cc53a24d5fadc8f5cd52
       immutables:      decimals=18, owner=0x7d9Cb2994D86B6a4e65761B5d81DADa69ce54a7f
[PASS] quoteToken (fUSDC) (0xbd2c54af6dd7e5e14d5b97d393eb2c8e2e8ebcca) -> 1594 B = 1530 B static prefix + 64 B immutables
       static sha256:   b07e38cee1dddb19ae183ddf9fa3b7bdd452ddb44e26a97c9b31dbaee8576009
       deployed sha256: 778d6ffa83ff290ace49886fe25d3f4359cd94d32e8d817b6396159188947a22
       immutables:      decimals=6, owner=0x7d9Cb2994D86B6a4e65761B5d81DADa69ce54a7f
[PASS] Faucet (0xe355220e8e9a650d082d49f130f0bfe344a792c7) -> 1346 B = 1186 B static prefix + 160 B immutables
       static sha256:   8ca8ba7f408c0da1d97277dbfd7f7d85baa030bd2b9fa03baa52d7a3464b0a51
       deployed sha256: a447d502f7c42a151c199e6ce1285ecab122c9e92ebf8001f480eaeb0c530a06
       immutables:      base/quote tokens, drip=1000000000000000000/100000000, cooldown=43200s

VERIFIED: All 4/4 deployed Sepolia contracts match this commit byte-for-byte (static runtime + immutable trailer).

>>> backend: cargo test
   Compiling proc-macro2 v1.0.107
   Compiling unicode-ident v1.0.27
   Compiling quote v1.0.47
   Compiling cfg-if v1.0.5
   Compiling zeroize v1.9.2
   Compiling windows-link v0.2.1
   Compiling version_check v0.9.5
   Compiling smallvec v1.16.5
   Compiling windows-sys v0.61.2
   Compiling stable_deref_trait v1.2.1
   Compiling pin-project-lite v0.2.17
   Compiling typenum v1.20.1
   Compiling const-oid v0.9.6
   Compiling itoa v1.0.19
   Compiling bytes v1.12.1
   Compiling generic-array v0.14.9
   Compiling subtle v2.6.1
   Compiling once_cell v1.21.4
   Compiling futures-core v0.3.34
   Compiling parking_lot_core v0.9.12
   Compiling scopeguard v1.2.0
   Compiling tracing-core v0.1.36
   Compiling lock_api v0.4.14
   Compiling log v0.4.35
   Compiling litemap v0.8.3
   Compiling writeable v0.6.4
   Compiling parking_lot v0.12.5
   Compiling syn v3.0.10
   Compiling syn v2.0.119
   Compiling http v1.5.0
   Compiling utf_types v1.0.0
   Compiling getrandom v0.2.17
   Compiling utf8_iter v1.1.0
   Compiling slab v0.4.12
   Compiling percent-encoding v2.3.2
   Compiling futures-task v0.3.34
   Compiling icu_normalizer_data v2.4.0
   Compiling serde_core v1.0.229
   Compiling block-buffer v0.10.4
   Compiling crypto-common v0.1.6
   Compiling digest v0.10.7
   Compiling icu_properties_data v2.4.0
   Compiling futures-util v0.3.34
   Compiling rand_core v0.6.4
   Compiling tower-service v0.3.3
   Compiling httparse v1.10.1
   Compiling http-body v1.1.0
   Compiling der v0.7.10
   Compiling libc v0.2.191
   Compiling try-lock v0.2.5
   Compiling want v0.3.2
   Compiling form_urlencoded v1.2.2
   Compiling sync_wrapper v1.0.2
   Compiling native-tls v0.2.18
   Compiling atomic-waker v1.1.2
   Compiling serde v1.0.229
   Compiling zmij v1.0.23
   Compiling httpdate v1.0.3
   Compiling tower-layer v0.3.3
   Compiling spki v0.7.3
   Compiling http-body-util v0.1.5
   Compiling ff v0.13.1
   Compiling futures-channel v0.3.34
   Compiling base16ct v0.2.0
   Compiling serde_json v1.0.154
   Compiling rustversion v1.0.23
   Compiling ipnet v2.12.2
   Compiling base64 v0.23.1
   Compiling sec1 v0.7.3
   Compiling pkcs8 v0.10.2
   Compiling group v0.13.0
   Compiling crypto-bigint v0.5.5
   Compiling synstructure v0.14.0
   Compiling hmac v0.12.1
   Compiling regex-syntax v0.8.11
   Compiling ryu v1.0.23
   Compiling memchr v2.8.3
   Compiling rfc6979 v0.4.0
   Compiling signature v2.2.0
   Compiling cpufeatures v0.2.17
   Compiling mime v0.3.18
   Compiling lazy_static v1.5.1
   Compiling thiserror v2.0.21
   Compiling bitflags v2.13.2
   Compiling regex-automata v0.4.18
   Compiling sharded-slab v0.1.7
   Compiling tracing-attributes v0.1.31
   Compiling elliptic-curve v0.13.8
   Compiling zerofrom-derive v0.1.8
   Compiling yoke-derive v0.8.4
   Compiling zerovec-derive v0.11.7
   Compiling displaydoc v0.2.7
   Compiling socket2 v0.6.5
   Compiling mio v1.2.5
   Compiling tokio-macros v2.7.2
   Compiling tracing v0.1.44
   Compiling schannel v0.1.30
   Compiling serde_derive v1.0.229
   Compiling async-trait v0.1.92
   Compiling zerofrom v0.1.8
   Compiling yoke v0.8.4
   Compiling tokio v1.54.1
   Compiling zerovec v0.11.9
   Compiling zerotrie v0.2.5
   Compiling matchers v0.2.0
   Compiling ecdsa v0.16.9
   Compiling nu-ansi-term v0.50.3
   Compiling tinystr v0.8.5
   Compiling potential_utf v0.1.6
   Compiling axum-core v0.4.5
   Compiling thiserror-impl v2.0.21
   Compiling icu_locale_core v2.4.0
   Compiling icu_collections v2.4.0
   Compiling axum-macros v0.4.2
   Compiling sha2 v0.10.9
   Compiling serde_path_to_error v0.1.20
   Compiling tracing-log v0.2.0
   Compiling rustls-pki-types v1.16.0
   Compiling thread_local v1.1.10
   Compiling base64 v0.22.1
   Compiling icu_provider v2.4.0
   Compiling keccak v0.1.6
   Compiling serde_urlencoded v0.7.1
   Compiling matchit v0.7.3
   Compiling icu_normalizer v2.4.0
   Compiling icu_properties v2.4.0
   Compiling sha3 v0.10.9
   Compiling tracing-subscriber v0.3.23
   Compiling k256 v0.13.4
   Compiling hex v0.4.3
   Compiling idna_adapter v1.2.2
   Compiling idna v1.1.0
   Compiling url v2.5.8
   Compiling hyper v1.12.0
   Compiling tower v0.5.3
   Compiling tokio-native-tls v0.3.1
   Compiling tower-http v0.6.11
   Compiling hyper-util v0.1.21
   Compiling hyper-tls v0.6.0
   Compiling axum v0.7.9
   Compiling reqwest v0.12.28
   Compiling fairbatch-backend v0.1.0 (C:\Users\Asif\AppData\Local\Temp\fairbatch-stage-h-verify\backend)
    Finished `test` profile [unoptimized + debuginfo] target(s) in 4m 58s
     Running unittests src\lib.rs (target\debug\deps\fairbatch_backend-25e30b0f0f04c0bd.exe)

running 20 tests
test chain::tests::test_function_selector ... ok
test chain::tests::test_dotenv_parsing_comments_quotes_and_empty_keys ... ok
test clearing::tests::test_balanced_cow_zero_slippage_zero_pool_impact ... ok
test clearing::tests::test_counterexample_a_buyer_denominator_floor_truncation_lnd ... ok
test chain::tests::test_global_deployment_config_parsing_faucet_and_secret_redaction ... ok
test chain::tests::test_local_fork_manifest_and_rpc_ignored ... ok
test clearing::tests::test_counterexample_b_buyer_denominator_tiny_reserve_solvency ... ok
test clearing::tests::test_five_eth_sellers_uniform_clearing_and_lnd ... ok
test clearing::tests::test_marginal_limit_price_pinning_and_pro_rata_partial_fills ... ok
test clearing::tests::test_counterexample_c_pinned_marginal_tier_pro_rata_input_truncation_lnd ... ok
test clearing::tests::test_six_decimal_dust_zero_output_refunded_in_pass1 ... ok
test clearing::tests::test_pure_p2p_zero_reserves_mode ... ok
test clearing::tests::test_order_permutation_invariance ... ok
test math::tests::test_mul_div_overflow_intermediate_and_rounding ... ok
test math::tests::test_usdc_6_decimal_normalization_and_floor_denormalization ... ok
test intent::tests::test_commitment_hash_parity_and_salt_sensitivity ... ok
test intent::tests::test_demo_wallets_deterministic_and_distinct ... ok
test simulator::tests::test_sequential_amm_arrival_unfairness_and_zero_fairbatch_mev ... ok
test intent::tests::test_eip712_sign_recover_and_tamper_rejection ... ok
test chain::tests::test_chain_config_defaults_to_sepolia_only ... ok

test result: ok. 20 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.24s

     Running unittests src\main.rs (target\debug\deps\fairbatch_backend-881c9e72c052f688.exe)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running tests\api_integration.rs (target\debug\deps\api_integration-887847c5218f470b.exe)

running 10 tests
test test_cross_tier_fe_evm_exact_atom_parity ... ok
test test_eip712_personal_sign_and_high_s_malleability_rejection ... ok
test test_health_and_sepolia_contracts_from_global_config ... ok
test test_buy_base_zero_limit_price_rejected_while_sell_base_zero_allowed ... ok
test test_preset_five_sellers_with_sandwich_bot_zero_mev_proof ... ok
test test_preset_cow_balanced_and_marginal_pro_rata ... ok
test test_commit_reveal_flow_bad_salt_and_bond_slashing ... ok
test test_whale_imbalance_preset_and_direct_order_phase_guard ... ok
test test_eip712_intent_signing_recovery_replay_expiry_and_claims ... ok
test test_stateless_compare_and_reset_endpoint ... ok

test result: ok. 10 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.39s

   Doc-tests fairbatch_backend

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s


>>> frontend: npm ci --no-audit --no-fund
npm warn deprecated whatwg-encoding@3.1.1: Use @exodus/bytes instead for a more spec-conformant and faster implementation

added 263 packages in 5m

>>> frontend: npm test

> fairbatch-frontend@0.1.0 test
> vitest run


 RUN  v2.1.9 C:/Users/Asif/AppData/Local/Temp/fairbatch-stage-h-verify/frontend

 ✓ src/__tests__/clearingMath.test.ts (10 tests) 85ms
 ✓ src/__tests__/onchainData.test.ts (11 tests) 149ms
 ✓ src/__tests__/labelParity.test.tsx (3 tests) 778ms
   ✓ UI button label parity across /docs, tooltips, and README.md > renders only canonical uiLabels.ts button labels across every /docs tab 673ms
 ✓ src/__tests__/simpleExperience.test.tsx (16 tests) 3040ms
   ✓ Simple mode end-to-end flows > shows install links when no Ethereum wallet exists 398ms
   ✓ Simple mode end-to-end flows > opens How it works, Why Fe, and MEV Sandwich Simulation modals cleanly 633ms
   ✓ Simple mode end-to-end flows > opens in-app /docs route from header, modal, and footer with User Guide, Developer Guide, Visuals, Threat Table, and Glossary 656ms
   ✓ Simple mode end-to-end flows > validates balances, sealed deposit, and gas in Simple Swap and Simple Earn while keeping Max working 311ms
 ✓ src/__tests__/FairBatchApp.test.tsx (14 tests) 6064ms
   ✓ FairBatch on-chain terminal > renders the live batch, reserves and clearing preview from chain snapshot 442ms
   ✓ FairBatch on-chain terminal > enables permissionless settlement only for a connected wallet in the ready phase 365ms
   ✓ FairBatch on-chain terminal > submits a sealed commitment through the connected wallet 911ms
   ✓ FairBatch on-chain terminal > lets only the connected owner claim settled receipts 771ms
   ✓ FairBatch on-chain terminal > supports optional liquidity locking when adding liquidity and shows active lock status 327ms
   ✓ FairBatch on-chain terminal > renders the read-only Sepolia deployment modal from config/deployment.json with no local fork controls 457ms
   ✓ FairBatch on-chain terminal > displays Pro balance row, per-input Balance + Max, collapsible details, and section tabs 1065ms
   ✓ FairBatch on-chain terminal > validates balances across Pro order slip, commit bond, LP add/remove, ETH gas, and removes duplicated Settlement Account balances 806ms

 Test Files  5 passed (5)
      Tests  54 passed (54)
   Start at  00:31:08
   Duration  27.38s (transform 5.46s, setup 10.39s, collect 40.24s, tests 10.11s, environment 24.21s, prepare 3.51s)


>>> frontend: npm run build

> fairbatch-frontend@0.1.0 build
> tsc -b && vite build

vite v6.4.6 building for production...
transforming...
✓ 2886 modules transformed.
rendering chunks...
computing gzip size...
dist/index.html                     0.78 kB │ gzip:   0.46 kB
dist/assets/index-C-9UfucT.css     39.61 kB │ gzip:   7.75 kB
dist/assets/ccip-DpZAznB8.js        4.63 kB │ gzip:   2.05 kB
dist/assets/DocsPage-CUSN20Di.js   86.81 kB │ gzip:  21.32 kB
dist/assets/index-D03qenoX.js     787.35 kB │ gzip: 222.69 kB

(!) Some chunks are larger than 500 kB after minification. Consider:
- Using dynamic import() to code-split the application
- Use build.rollupOptions.output.manualChunks to improve chunking: https://rollupjs.org/configuration-options/#output-manualchunks
- Adjust chunk size limit for this warning via build.chunkSizeWarningLimit.
✓ built in 19.14s

>>> keeper: npm ci --no-audit --no-fund

added 63 packages in 2m

>>> keeper: npm test

> fairbatch-keeper@0.1.0 test
> vitest run


 RUN  v2.1.9 C:/Users/Asif/AppData/Local/Temp/fairbatch-stage-h-verify/keeper

 ✓ src/__tests__/decision.test.ts (6 tests) 119ms
 ✓ src/__tests__/relayer.test.ts (4 tests) 337ms

 Test Files  2 passed (2)
      Tests  10 passed (10)
   Start at  00:34:02
   Duration  5.66s (transform 450ms, setup 0ms, collect 7.83s, tests 456ms, environment 1ms, prepare 1.05s)


>>> keeper: npm run build

> fairbatch-keeper@0.1.0 build
> tsc -p tsconfig.json


>>> shellcheck -s bash deploy.sh deploy/tests/test_deploy.sh

>>> bash -n deploy.sh deploy/tests/test_deploy.sh

>>> SKIP_HEAVY_BUILD=1 bash deploy/tests/test_deploy.sh
CLONE_HEAD=43c40e45fd3e1ad1763b787c23c6f9554a032c1e
=== 1. Pure Function Unit Tests ===
  [PASS] detect_keeper_type detects TypeScript keeper
  [PASS] parse_required_node_major matches frontend engines (>=20 <23 -> 22)
  [PASS] normalize_domain strips scheme, path, query & lowercases
  [PASS] normalize_domain strips trailing slash and trailing dot
  [PASS] validate_domain accepts valid apex domain
  [PASS] validate_domain accepts valid subdomain
  [PASS] validate_domain rejects IPv4 address
  [PASS] validate_domain rejects IPv6 address
  [PASS] validate_domain rejects single-label hostname
  [PASS] validate_domain rejects leading hyphen label
  [PASS] validate_domain rejects underscores
  [PASS] is_forbidden_private_key rejects all-zero key
  [PASS] is_forbidden_private_key rejects repeated-char dummy key
  [PASS] is_forbidden_private_key rejects tiny key 0x...0001
  [PASS] is_forbidden_private_key rejects Anvil/Hardhat default #0
  [PASS] is_forbidden_private_key rejects Anvil/Hardhat default #1
  [PASS] is_forbidden_private_key accepts fresh random throwaway key
  [PASS] validate_env_map rejects broken env
  [PASS] validate_env_map reports ALL problems at once (>= 8 errors)
  [PASS] validate_env_map accepts valid env
  [PASS] derive_address.mjs matches EIP-55 vector via stdin
  [PASS] is_cloudflare_ipv4 detects 104.21.44.10
  [PASS] is_cloudflare_ipv4 detects 172.67.150.22
  [PASS] is_cloudflare_ipv4 ignores normal VPS IP 203.0.113.42
  [PASS] evaluate_dns_records passes exact A match on 1.1.1.1 & 8.8.8.8
  [PASS] evaluate_dns_records outputs DNS_OK
  [PASS] evaluate_dns_records detects Cloudflare orange-cloud proxy IP (rc=2)
  [PASS] evaluate_dns_records explains Cloudflare grey-cloud fix
  [PASS] evaluate_dns_records flags stale AAAA mismatch (rc=3)
  [PASS] evaluate_dns_records explains stale AAAA removal
  [PASS] evaluate_dns_records flags missing/wrong A record (rc=1)
  [PASS] evaluate_dns_records reports A_MISMATCH
  [PASS] resolve_keeper_exec discovers absolute node via command -v node and quotes ExecStart
  [PASS] Caddyfile IP has same-origin /keeper/* proxy
  [PASS] Caddyfile IP has SPA try_files fallback
  [PASS] Caddyfile domain renders www 308 redirect
  [PASS] systemd unit enables NoNewPrivileges + ProtectSystem=strict
  [PASS] systemd unit quotes absolute node path in ExecStart
  [PASS] prune_old_releases keeps exactly last 3 releases

=== 2. Mocked Ubuntu 24.04 End-to-End Flow (--dry-run, real deploy, --update auto-rollback, --rollback, --status) ===
  [PASS] --dry-run exits 0 and shows planned actions
  [PASS] --dry-run NEVER leaks KEEPER_PRIVATE_KEY into output
  [PASS] --dry-run verifies live Sepolia chainId=11155111
  [PASS] --dry-run verifies deployed FairBatch contract code
  [SKIP] Heavy build E2E skipped (SKIP_HEAVY_BUILD=1)

=== Summary: 43 passed, 0 failed ===
DEPLOY_TEST_RC=0
```
