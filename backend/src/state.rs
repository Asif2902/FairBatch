//! Stateful in-memory FairBatch auction engine (`Open -> Reveal -> Settled -> Next Batch`),
//! scenario presets, commit-reveal bond slashing, EIP-712 replay nonces, and pull-over-push claims.

use std::collections::BTreeMap;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::chain::{ChainBridgeConfig, ContractAddressesDto};
use crate::clearing::{OrderSide, ReservesSnapshotDto, SubmissionType};
use crate::intent::{
    all_demo_wallets, compute_commitment_hash_human, get_demo_wallet, parse_eth_address,
    public_demo_wallet_dtos, sign_prehash_ethereum, to_checksum_address, verify_signed_order,
    DemoWalletDto, SignedOrderParams,
};
use crate::simulator::{
    compute_optimal_sandwich, settle_and_compare, BatchSettlementDto, SimOrder,
};

pub const DEFAULT_RX_WETH: f64 = 100.0;
pub const DEFAULT_RY_USDC: f64 = 300_000.0;
pub const BASE_DECIMALS: u8 = 18;
pub const QUOTE_DECIMALS: u8 = 6;
pub const DEFAULT_FEE_BPS: u64 = 30;
pub const MAX_ORDERS_PER_BATCH: usize = 64;
pub const DEFAULT_COMMIT_DURATION_SECS: u64 = 30;
pub const DEFAULT_REVEAL_DURATION_SECS: u64 = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BatchPhase {
    Open,
    Reveal,
    Settled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitmentDto {
    pub commit_id: u64,
    pub batch_id: u64,
    pub trader: String,
    pub commitment_hash: String,
    pub bond_eth: f64,
    pub revealed: bool,
    pub slashed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActiveOrderDto {
    pub order_id: u64,
    pub trader: String,
    pub label: String,
    pub side: OrderSide,
    pub amount_in: f64,
    pub limit_price: f64,
    pub submission_type: SubmissionType,
    pub is_attacker: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaimableItemDto {
    pub batch_id: u64,
    pub order_id: u64,
    pub trader: String,
    pub label: String,
    pub side: OrderSide,
    pub status: crate::clearing::FillStatus,
    pub amount_in: f64,
    pub amount_filled: f64,
    pub payout_out: f64,
    pub refund_in: f64,
    pub effective_price: f64,
    pub claimed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StateResponse {
    pub batch_id: u64,
    pub phase: BatchPhase,
    pub commit_duration_secs: u64,
    pub reveal_duration_secs: u64,
    pub phase_remaining_secs: u64,
    pub chain_id: u64,
    pub contracts: ContractAddressesDto,
    pub reserves: ReservesSnapshotDto,
    pub demo_wallets: Vec<DemoWalletDto>,
    pub nonces: BTreeMap<String, u64>,
    pub commitments: Vec<CommitmentDto>,
    pub orders: Vec<ActiveOrderDto>,
    pub claimable: Vec<ClaimableItemDto>,
    pub settled_history: Vec<BatchSettlementDto>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DirectOrderRequest {
    pub trader: String,
    pub label: Option<String>,
    pub side: OrderSide,
    pub amount_in: f64,
    pub limit_price: f64,
    #[serde(default)]
    pub is_attacker: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ComputeHashRequest {
    pub trader: String,
    pub batch_id: Option<u64>,
    pub side: OrderSide,
    pub amount_in: f64,
    pub limit_price: f64,
    pub salt: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComputeHashResponse {
    pub commitment_hash: String,
}

fn default_bond_eth() -> f64 {
    0.01
}

#[derive(Debug, Clone, Deserialize)]
pub struct CommitOrderRequest {
    pub trader: String,
    pub commitment_hash: String,
    #[serde(default = "default_bond_eth")]
    pub bond_eth: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitOrderResponse {
    pub commit_id: u64,
    pub state: StateResponse,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RevealOrderRequest {
    pub commit_id: u64,
    pub trader: String,
    pub side: OrderSide,
    pub amount_in: f64,
    pub limit_price: f64,
    pub salt: String,
    pub label: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SignDemoIntentRequest {
    pub demo_account_index: usize,
    pub side: OrderSide,
    pub amount_in: f64,
    pub limit_price: f64,
    pub batch_id: Option<u64>,
    pub deadline: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignDemoIntentResponse {
    pub trader: String,
    pub nonce: u64,
    pub batch_id: u64,
    pub deadline: u64,
    pub chain_id: u64,
    pub verifying_contract: String,
    pub signature: String,
    pub digest: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SubmitIntentRequest {
    pub trader: String,
    pub side: OrderSide,
    pub amount_in: f64,
    pub limit_price: f64,
    pub batch_id: u64,
    pub nonce: u64,
    pub deadline: u64,
    pub signature: String,
    pub label: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ReservesOverride {
    pub rx: f64,
    pub ry: f64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LoadPresetRequest {
    pub preset: String,
    #[serde(default)]
    pub include_sandwich_bot: bool,
    pub reset_reserves: Option<ReservesOverride>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SettleBatchResponse {
    pub settlement: BatchSettlementDto,
    pub state: StateResponse,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ClaimKey {
    pub batch_id: u64,
    pub order_id: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ClaimBatchRequest {
    #[serde(default)]
    pub trader: Option<String>,
    pub claims: Vec<ClaimKey>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaimBatchResponse {
    pub claimed_base: f64,
    pub claimed_quote: f64,
    pub state: StateResponse,
}

#[derive(Debug, Clone, Deserialize)]
pub struct StatelessOrderInput {
    pub order_id: Option<u64>,
    pub trader: Option<String>,
    pub label: Option<String>,
    pub side: OrderSide,
    pub amount_in: f64,
    pub limit_price: f64,
    #[serde(default)]
    pub is_attacker: bool,
}

fn default_fee_bps() -> u64 {
    DEFAULT_FEE_BPS
}

#[derive(Debug, Clone, Deserialize)]
pub struct StatelessCompareRequest {
    pub rx: f64,
    pub ry: f64,
    #[serde(default = "default_fee_bps")]
    pub fee_bps: u64,
    #[serde(default)]
    pub include_sandwich_bot: bool,
    pub orders: Vec<StatelessOrderInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatelessCompareResponse {
    pub settlement: BatchSettlementDto,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct ResetRequest {
    pub rx: Option<f64>,
    pub ry: Option<f64>,
}

pub struct FairBatchEngine {
    pub batch_id: u64,
    pub phase: BatchPhase,
    pub phase_started_unix: u64,
    pub rx: f64,
    pub ry: f64,
    pub next_order_id: u64,
    pub next_commit_id: u64,
    pub commitments: Vec<CommitmentDto>,
    pub orders: Vec<ActiveOrderDto>,
    pub claimable: Vec<ClaimableItemDto>,
    pub settled_history: Vec<BatchSettlementDto>,
    pub nonces: BTreeMap<String, u64>,
    pub chain: ChainBridgeConfig,
}

impl FairBatchEngine {
    pub fn new(chain: ChainBridgeConfig) -> Self {
        let mut engine = Self {
            batch_id: 1,
            phase: BatchPhase::Open,
            phase_started_unix: now_unix_secs(),
            rx: DEFAULT_RX_WETH,
            ry: DEFAULT_RY_USDC,
            next_order_id: 1,
            next_commit_id: 1,
            commitments: Vec::new(),
            orders: Vec::new(),
            claimable: Vec::new(),
            settled_history: Vec::new(),
            nonces: BTreeMap::new(),
            chain,
        };
        engine.seed_demo_nonces();
        engine
    }

    fn seed_demo_nonces(&mut self) {
        for w in all_demo_wallets() {
            self.nonces.entry(w.address.to_lowercase()).or_insert(0);
        }
    }

    pub fn get_nonce(&self, addr: &str) -> u64 {
        let key = normalize_addr_key(addr);
        self.nonces.get(&key).copied().unwrap_or(0)
    }

    fn increment_nonce(&mut self, addr: &str) {
        let key = normalize_addr_key(addr);
        let cur = self.nonces.get(&key).copied().unwrap_or(0);
        self.nonces.insert(key, cur + 1);
    }

    pub fn snapshot_state(&self) -> StateResponse {
        let now = now_unix_secs();
        let elapsed = now.saturating_sub(self.phase_started_unix);
        let window = match self.phase {
            BatchPhase::Open => DEFAULT_COMMIT_DURATION_SECS,
            BatchPhase::Reveal => DEFAULT_REVEAL_DURATION_SECS,
            BatchPhase::Settled => 0,
        };
        let phase_remaining_secs = window.saturating_sub(elapsed);

        StateResponse {
            batch_id: self.batch_id,
            phase: self.phase,
            commit_duration_secs: DEFAULT_COMMIT_DURATION_SECS,
            reveal_duration_secs: DEFAULT_REVEAL_DURATION_SECS,
            phase_remaining_secs,
            chain_id: self.chain.chain_id,
            contracts: self.chain.contracts_dto(),
            reserves: ReservesSnapshotDto::new(self.rx, self.ry, BASE_DECIMALS, QUOTE_DECIMALS),
            demo_wallets: public_demo_wallet_dtos(),
            nonces: self.nonces.clone(),
            commitments: self.commitments.clone(),
            orders: self.orders.clone(),
            claimable: self.claimable.clone(),
            settled_history: self.settled_history.clone(),
        }
    }

    pub fn reset(&mut self, rx: Option<f64>, ry: Option<f64>) -> Result<StateResponse, String> {
        let new_rx = rx.unwrap_or(DEFAULT_RX_WETH);
        let new_ry = ry.unwrap_or(DEFAULT_RY_USDC);
        if !new_rx.is_finite() || new_rx < 0.0 || !new_ry.is_finite() || new_ry < 0.0 {
            return Err("Reserves rx and ry must be finite and >= 0".to_string());
        }
        self.batch_id = 1;
        self.phase = BatchPhase::Open;
        self.phase_started_unix = now_unix_secs();
        self.rx = new_rx;
        self.ry = new_ry;
        self.next_order_id = 1;
        self.next_commit_id = 1;
        self.commitments.clear();
        self.orders.clear();
        self.claimable.clear();
        self.settled_history.clear();
        self.nonces.clear();
        self.seed_demo_nonces();
        Ok(self.snapshot_state())
    }

    pub fn submit_direct(&mut self, req: DirectOrderRequest) -> Result<StateResponse, String> {
        if self.phase != BatchPhase::Open {
            return Err(
                "Direct orders are only accepted during the Open phase; use Reveal or EIP-712 Intent"
                    .to_string(),
            );
        }
        validate_order_numbers(req.side, req.amount_in, req.limit_price)?;
        if self.orders.len() >= MAX_ORDERS_PER_BATCH {
            return Err(format!("Batch order cap ({MAX_ORDERS_PER_BATCH}) reached"));
        }
        let trader_bytes = parse_eth_address(&req.trader)?;
        let trader = to_checksum_address(&trader_bytes);
        let label = resolve_trader_label(&trader, req.label);

        let order_id = self.next_order_id;
        self.next_order_id += 1;

        self.orders.push(ActiveOrderDto {
            order_id,
            trader,
            label,
            side: req.side,
            amount_in: req.amount_in,
            limit_price: req.limit_price,
            submission_type: SubmissionType::Direct,
            is_attacker: req.is_attacker,
        });

        Ok(self.snapshot_state())
    }

    pub fn compute_hash(&self, req: ComputeHashRequest) -> Result<ComputeHashResponse, String> {
        validate_order_numbers(req.side, req.amount_in, req.limit_price)?;
        let batch_id = req.batch_id.unwrap_or(self.batch_id);
        let commitment_hash = compute_commitment_hash_human(
            batch_id,
            &req.trader,
            req.side,
            req.amount_in,
            req.limit_price,
            &req.salt,
            BASE_DECIMALS,
            QUOTE_DECIMALS,
        )?;
        Ok(ComputeHashResponse { commitment_hash })
    }

    pub fn commit_order(&mut self, req: CommitOrderRequest) -> Result<CommitOrderResponse, String> {
        if self.phase != BatchPhase::Open {
            return Err("Commitments are only accepted during the Open phase".to_string());
        }
        if !req.bond_eth.is_finite() || req.bond_eth <= 0.0 {
            return Err("Reveal bond_eth must be > 0".to_string());
        }
        let trader_bytes = parse_eth_address(&req.trader)?;
        let trader = to_checksum_address(&trader_bytes);

        let hash_trimmed = req.commitment_hash.trim();
        let hex_part = hash_trimmed
            .strip_prefix("0x")
            .or_else(|| hash_trimmed.strip_prefix("0X"))
            .unwrap_or(hash_trimmed);
        if hex_part.len() != 64 || !hex_part.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err("commitment_hash must be a 32-byte (64 hex char) keccak256 digest".to_string());
        }
        if hex_part.chars().all(|c| c == '0') {
            return Err("commitment_hash cannot be zero".to_string());
        }
        let normalized_hash = format!("0x{}", hex_part.to_lowercase());

        let commit_id = self.next_commit_id;
        self.next_commit_id += 1;

        self.commitments.push(CommitmentDto {
            commit_id,
            batch_id: self.batch_id,
            trader,
            commitment_hash: normalized_hash,
            bond_eth: req.bond_eth,
            revealed: false,
            slashed: false,
        });

        Ok(CommitOrderResponse {
            commit_id,
            state: self.snapshot_state(),
        })
    }

    pub fn reveal_order(&mut self, req: RevealOrderRequest) -> Result<StateResponse, String> {
        if self.phase != BatchPhase::Reveal {
            return Err("Orders can only be revealed during the Reveal phase".to_string());
        }
        validate_order_numbers(req.side, req.amount_in, req.limit_price)?;
        if self.orders.len() >= MAX_ORDERS_PER_BATCH {
            return Err(format!("Batch order cap ({MAX_ORDERS_PER_BATCH}) reached"));
        }

        let trader_bytes = parse_eth_address(&req.trader)?;
        let trader = to_checksum_address(&trader_bytes);

        let commit_idx = self
            .commitments
            .iter()
            .position(|c| c.commit_id == req.commit_id && c.batch_id == self.batch_id)
            .ok_or_else(|| format!("Commitment #{} not found in active batch #{}", req.commit_id, self.batch_id))?;

        if self.commitments[commit_idx].revealed {
            return Err(format!("Commitment #{} was already revealed", req.commit_id));
        }
        if self.commitments[commit_idx].slashed {
            return Err(format!("Commitment #{} was already slashed", req.commit_id));
        }
        if !self.commitments[commit_idx]
            .trader
            .eq_ignore_ascii_case(&trader)
        {
            return Err("Commitment trader mismatch".to_string());
        }

        let recomputed = compute_commitment_hash_human(
            self.batch_id,
            &trader,
            req.side,
            req.amount_in,
            req.limit_price,
            &req.salt,
            BASE_DECIMALS,
            QUOTE_DECIMALS,
        )?;

        if !recomputed.eq_ignore_ascii_case(&self.commitments[commit_idx].commitment_hash) {
            return Err(
                "Commitment hash mismatch: revealed order parameters or salt do not match commitment"
                    .to_string(),
            );
        }

        self.commitments[commit_idx].revealed = true;
        let order_id = self.next_order_id;
        self.next_order_id += 1;
        let label = resolve_trader_label(&trader, req.label);

        self.orders.push(ActiveOrderDto {
            order_id,
            trader,
            label,
            side: req.side,
            amount_in: req.amount_in,
            limit_price: req.limit_price,
            submission_type: SubmissionType::CommitReveal,
            is_attacker: false,
        });

        Ok(self.snapshot_state())
    }

    pub fn sign_demo_intent(
        &self,
        req: SignDemoIntentRequest,
    ) -> Result<SignDemoIntentResponse, String> {
        validate_order_numbers(req.side, req.amount_in, req.limit_price)?;
        let wallet = get_demo_wallet(req.demo_account_index).ok_or_else(|| {
            format!(
                "Invalid demo_account_index {} (expected 0..=5)",
                req.demo_account_index
            )
        })?;

        let batch_id = req.batch_id.unwrap_or(self.batch_id);
        let now = now_unix_secs();
        let deadline = match req.deadline {
            Some(d) if d > 0 => d,
            _ => now + 3_600,
        };
        let nonce = self.get_nonce(&wallet.address);

        let params = SignedOrderParams {
            chain_id: self.chain.chain_id,
            verifying_contract: self.chain.verifying_contract_bytes(),
            trader: wallet.address_bytes,
            side: req.side,
            amount_in: req.amount_in,
            limit_price: req.limit_price,
            batch_id,
            nonce,
            deadline,
            base_decimals: BASE_DECIMALS,
            quote_decimals: QUOTE_DECIMALS,
        };

        let digest = params.canonical_digest();
        let signature = sign_prehash_ethereum(&wallet.signing_key, &digest)?;

        Ok(SignDemoIntentResponse {
            trader: wallet.address,
            nonce,
            batch_id,
            deadline,
            chain_id: self.chain.chain_id,
            verifying_contract: self.chain.fair_batch.clone(),
            signature,
            digest: format!("0x{}", hex::encode(digest)),
        })
    }

    pub fn submit_signed_intent(
        &mut self,
        req: SubmitIntentRequest,
    ) -> Result<StateResponse, String> {
        if self.phase == BatchPhase::Settled {
            return Err("Cannot submit intent to a settled batch".to_string());
        }
        validate_order_numbers(req.side, req.amount_in, req.limit_price)?;
        if self.orders.len() >= MAX_ORDERS_PER_BATCH {
            return Err(format!("Batch order cap ({MAX_ORDERS_PER_BATCH}) reached"));
        }
        if req.batch_id != self.batch_id {
            return Err(format!(
                "Intent batch_id mismatch (expected {}, got {})",
                self.batch_id, req.batch_id
            ));
        }

        let now = now_unix_secs();
        if req.deadline < now {
            return Err(format!(
                "EIP-712 intent expired (deadline {} < current timestamp {})",
                req.deadline, now
            ));
        }

        let trader_bytes = parse_eth_address(&req.trader)?;
        let trader = to_checksum_address(&trader_bytes);
        let expected_nonce = self.get_nonce(&trader);
        if req.nonce != expected_nonce {
            return Err(format!(
                "Invalid or replayed EIP-712 nonce (expected {}, got {})",
                expected_nonce, req.nonce
            ));
        }

        let params = SignedOrderParams {
            chain_id: self.chain.chain_id,
            verifying_contract: self.chain.verifying_contract_bytes(),
            trader: trader_bytes,
            side: req.side,
            amount_in: req.amount_in,
            limit_price: req.limit_price,
            batch_id: req.batch_id,
            nonce: req.nonce,
            deadline: req.deadline,
            base_decimals: BASE_DECIMALS,
            quote_decimals: QUOTE_DECIMALS,
        };

        verify_signed_order(&params, &req.signature)?;
        self.increment_nonce(&trader);

        let order_id = self.next_order_id;
        self.next_order_id += 1;
        let label = resolve_trader_label(&trader, req.label);

        self.orders.push(ActiveOrderDto {
            order_id,
            trader,
            label,
            side: req.side,
            amount_in: req.amount_in,
            limit_price: req.limit_price,
            submission_type: SubmissionType::Eip712Intent,
            is_attacker: false,
        });

        Ok(self.snapshot_state())
    }

    pub fn advance_phase(&mut self) -> Result<StateResponse, String> {
        match self.phase {
            BatchPhase::Open => {
                self.phase = BatchPhase::Reveal;
                self.phase_started_unix = now_unix_secs();
                Ok(self.snapshot_state())
            }
            BatchPhase::Reveal => Ok(self.snapshot_state()),
            BatchPhase::Settled => Err("Batch is already settled".to_string()),
        }
    }

    pub fn settle_batch(&mut self) -> Result<SettleBatchResponse, String> {
        let current_batch = self.batch_id;

        // Slash all unrevealed commitments in the current batch
        let mut slashed_bonds_count = 0usize;
        for c in &mut self.commitments {
            if c.batch_id == current_batch && !c.revealed && !c.slashed {
                c.slashed = true;
                slashed_bonds_count += 1;
            }
        }

        let sim_orders: Vec<SimOrder> = self
            .orders
            .iter()
            .map(|o| SimOrder {
                order_id: o.order_id,
                trader: o.trader.clone(),
                label: o.label.clone(),
                side: o.side,
                amount_in: o.amount_in,
                limit_price: o.limit_price,
                is_attacker: o.is_attacker,
            })
            .collect();

        let settlement = settle_and_compare(
            current_batch,
            self.rx,
            self.ry,
            BASE_DECIMALS,
            QUOTE_DECIMALS,
            DEFAULT_FEE_BPS,
            slashed_bonds_count,
            &sim_orders,
        );

        // Update reserves from exact post-batch FM-AMM clearing
        self.rx = settlement.reserves_after.rx;
        self.ry = settlement.reserves_after.ry;

        // Record pull-over-push claims for all non-attacker & attacker orders in batch
        for fill in &settlement.fills {
            self.claimable.push(ClaimableItemDto {
                batch_id: current_batch,
                order_id: fill.order_id,
                trader: fill.trader.clone(),
                label: fill.label.clone(),
                side: fill.side,
                status: fill.status,
                amount_in: fill.amount_in,
                amount_filled: fill.amount_filled,
                payout_out: fill.payout_out,
                refund_in: fill.refund_in,
                effective_price: fill.effective_price,
                claimed: false,
            });
        }

        self.settled_history.push(settlement.clone());

        // Advance to `batch_id + 1` in Open phase
        self.batch_id += 1;
        self.phase = BatchPhase::Open;
        self.phase_started_unix = now_unix_secs();
        self.orders.clear();

        Ok(SettleBatchResponse {
            settlement,
            state: self.snapshot_state(),
        })
    }

    pub fn claim_batch(&mut self, req: ClaimBatchRequest) -> Result<ClaimBatchResponse, String> {
        if req.claims.is_empty() {
            return Err("claims array must not be empty".to_string());
        }

        let filter_trader = match &req.trader {
            Some(t) if !t.trim().is_empty() => {
                let bytes = parse_eth_address(t)?;
                Some(to_checksum_address(&bytes))
            }
            _ => None,
        };

        // First validate all requested claims atomically (like Multicall!)
        let mut indices = Vec::with_capacity(req.claims.len());
        for key in &req.claims {
            let pos = self
                .claimable
                .iter()
                .position(|c| c.batch_id == key.batch_id && c.order_id == key.order_id)
                .ok_or_else(|| {
                    format!(
                        "Claim not found for batch_id={}, order_id={}",
                        key.batch_id, key.order_id
                    )
                })?;

            if self.claimable[pos].claimed {
                return Err(format!(
                    "Order #{} in batch #{} has already been claimed",
                    key.order_id, key.batch_id
                ));
            }
            if let Some(ref expected) = filter_trader {
                if !self.claimable[pos].trader.eq_ignore_ascii_case(expected) {
                    return Err(format!(
                        "Claim owner mismatch for order #{} in batch #{}",
                        key.order_id, key.batch_id
                    ));
                }
            }
            if !indices.contains(&pos) {
                indices.push(pos);
            } else {
                return Err(format!(
                    "Duplicate claim key batch_id={}, order_id={} in single request",
                    key.batch_id, key.order_id
                ));
            }
        }

        let mut claimed_base = 0.0;
        let mut claimed_quote = 0.0;
        for pos in indices {
            let item = &mut self.claimable[pos];
            item.claimed = true;
            match item.side {
                OrderSide::SellBase => {
                    claimed_quote += item.payout_out;
                    claimed_base += item.refund_in;
                }
                OrderSide::BuyBase => {
                    claimed_base += item.payout_out;
                    claimed_quote += item.refund_in;
                }
            }
        }

        Ok(ClaimBatchResponse {
            claimed_base,
            claimed_quote,
            state: self.snapshot_state(),
        })
    }

    pub fn load_preset(&mut self, req: LoadPresetRequest) -> Result<StateResponse, String> {
        let (new_rx, new_ry) = match req.reset_reserves {
            Some(r) => {
                if !r.rx.is_finite() || r.rx <= 0.0 || !r.ry.is_finite() || r.ry <= 0.0 {
                    return Err("reset_reserves rx and ry must be finite and > 0".to_string());
                }
                (r.rx, r.ry)
            }
            None => (DEFAULT_RX_WETH, DEFAULT_RY_USDC),
        };

        let wallets = all_demo_wallets();
        let victim_specs: Vec<(usize, OrderSide, f64, f64, SubmissionType)> =
            match req.preset.trim() {
                "five_sellers" => vec![
                    (0, OrderSide::SellBase, 1.0, 2350.0, SubmissionType::Direct),
                    (1, OrderSide::SellBase, 1.0, 2350.0, SubmissionType::Direct),
                    (2, OrderSide::SellBase, 1.0, 2350.0, SubmissionType::Eip712Intent),
                    (3, OrderSide::SellBase, 1.0, 2350.0, SubmissionType::Direct),
                    (4, OrderSide::SellBase, 1.0, 2350.0, SubmissionType::CommitReveal),
                ],
                "cow_balanced" => vec![
                    (0, OrderSide::SellBase, 2.0, 2850.0, SubmissionType::Direct),
                    (1, OrderSide::SellBase, 3.0, 2900.0, SubmissionType::Eip712Intent),
                    (2, OrderSide::BuyBase, 6_000.0, 3150.0, SubmissionType::Direct),
                    (3, OrderSide::BuyBase, 9_000.0, 3100.0, SubmissionType::CommitReveal),
                ],
                "marginal_pro_rata" => vec![
                    // Alice: strictly ITM seller (2600 < 2800) -> 100% Filled
                    (0, OrderSide::SellBase, 2.0, 2600.0, SubmissionType::Direct),
                    // Bob & Carol: marginal tier sellers at p* = 2800 -> Pro-Rata Partial Fill
                    (1, OrderSide::SellBase, 4.0, 2800.0, SubmissionType::Direct),
                    (2, OrderSide::SellBase, 4.0, 2800.0, SubmissionType::Eip712Intent),
                    // Dave: out-of-the-money seller (3150 > 2800) -> 100% OutOfMoneyRefund
                    (3, OrderSide::SellBase, 2.0, 3150.0, SubmissionType::Direct),
                    // Eve: strictly ITM buyer (3100 > 2800) -> 100% Filled
                    (4, OrderSide::BuyBase, 2_800.0, 3100.0, SubmissionType::Direct),
                ],
                "whale_imbalance" => vec![
                    (0, OrderSide::SellBase, 20.0, 1900.0, SubmissionType::Eip712Intent),
                    (1, OrderSide::SellBase, 5.0, 1950.0, SubmissionType::Direct),
                    (2, OrderSide::BuyBase, 6_000.0, 3050.0, SubmissionType::Direct),
                ],
                other => {
                    return Err(format!(
                        "Unknown preset '{other}' (expected five_sellers | cow_balanced | marginal_pro_rata | whale_imbalance)"
                    ))
                }
            };

        self.rx = new_rx;
        self.ry = new_ry;
        self.phase = BatchPhase::Open;
        self.phase_started_unix = now_unix_secs();
        self.orders.clear();
        self.commitments
            .retain(|c| c.batch_id != self.batch_id);

        let mut victim_sim_orders = Vec::with_capacity(victim_specs.len());
        for (idx, &(w_idx, side, amt, lim, _)) in victim_specs.iter().enumerate() {
            victim_sim_orders.push(SimOrder {
                order_id: (idx + 1) as u64,
                trader: wallets[w_idx].address.clone(),
                label: wallets[w_idx].name.to_string(),
                side,
                amount_in: amt,
                limit_price: lim,
                is_attacker: false,
            });
        }

        let sandwich = if req.include_sandwich_bot {
            compute_optimal_sandwich(
                self.rx,
                self.ry,
                DEFAULT_FEE_BPS,
                &victim_sim_orders,
                BASE_DECIMALS,
                QUOTE_DECIMALS,
                1,
            )
        } else {
            None
        };

        if let Some(ref sw) = sandwich {
            let oid = self.next_order_id;
            self.next_order_id += 1;
            self.orders.push(ActiveOrderDto {
                order_id: oid,
                trader: sw.front_run.trader.clone(),
                label: sw.front_run.label.clone(),
                side: sw.front_run.side,
                amount_in: sw.front_run.amount_in,
                limit_price: sw.front_run.limit_price,
                submission_type: SubmissionType::Direct,
                is_attacker: true,
            });
        }

        for (w_idx, side, amt, lim, sub_type) in victim_specs {
            let oid = self.next_order_id;
            self.next_order_id += 1;
            self.orders.push(ActiveOrderDto {
                order_id: oid,
                trader: wallets[w_idx].address.clone(),
                label: wallets[w_idx].name.to_string(),
                side,
                amount_in: amt,
                limit_price: lim,
                submission_type: sub_type,
                is_attacker: false,
            });
        }

        if let Some(sw) = sandwich {
            let oid = self.next_order_id;
            self.next_order_id += 1;
            self.orders.push(ActiveOrderDto {
                order_id: oid,
                trader: sw.back_run.trader,
                label: sw.back_run.label,
                side: sw.back_run.side,
                amount_in: sw.back_run.amount_in,
                limit_price: sw.back_run.limit_price,
                submission_type: SubmissionType::Direct,
                is_attacker: true,
            });
        }

        Ok(self.snapshot_state())
    }
}

pub fn run_stateless_compare(req: StatelessCompareRequest) -> Result<StatelessCompareResponse, String> {
    if !req.rx.is_finite() || req.rx < 0.0 || !req.ry.is_finite() || req.ry < 0.0 {
        return Err("rx and ry must be finite and >= 0".to_string());
    }
    if req.fee_bps >= 10_000 {
        return Err("fee_bps must be < 10000".to_string());
    }

    let wallets = all_demo_wallets();
    let mut base_orders = Vec::with_capacity(req.orders.len());
    for (idx, o) in req.orders.into_iter().enumerate() {
        validate_order_numbers(o.side, o.amount_in, o.limit_price)?;
        let fallback_wallet = &wallets[idx % 5];
        let trader = match o.trader {
            Some(t) if !t.trim().is_empty() => {
                let bytes = parse_eth_address(&t)?;
                to_checksum_address(&bytes)
            }
            _ => fallback_wallet.address.clone(),
        };
        let label = resolve_trader_label(&trader, o.label);
        base_orders.push(SimOrder {
            order_id: o.order_id.unwrap_or((idx + 1) as u64),
            trader,
            label,
            side: o.side,
            amount_in: o.amount_in,
            limit_price: o.limit_price,
            is_attacker: o.is_attacker,
        });
    }

    let already_has_attacker = base_orders.iter().any(|o| o.is_attacker);
    let final_orders = if req.include_sandwich_bot && !already_has_attacker {
        if let Some(sw) = compute_optimal_sandwich(
            req.rx,
            req.ry,
            req.fee_bps,
            &base_orders,
            BASE_DECIMALS,
            QUOTE_DECIMALS,
            9_000,
        ) {
            let mut v = Vec::with_capacity(base_orders.len() + 2);
            v.push(sw.front_run);
            v.extend(base_orders);
            v.push(sw.back_run);
            v
        } else {
            base_orders
        }
    } else {
        base_orders
    };

    let settlement = settle_and_compare(
        1,
        req.rx,
        req.ry,
        BASE_DECIMALS,
        QUOTE_DECIMALS,
        req.fee_bps,
        0,
        &final_orders,
    );

    Ok(StatelessCompareResponse { settlement })
}

fn validate_order_numbers(side: OrderSide, amount_in: f64, limit_price: f64) -> Result<(), String> {
    if !amount_in.is_finite() || amount_in <= 0.0 {
        return Err("amount_in must be finite and > 0".to_string());
    }
    if amount_in < 1e-6 {
        return Err("amount_in below minimum dust threshold (1e-6)".to_string());
    }
    if !limit_price.is_finite() || limit_price < 0.0 {
        return Err("limit_price must be finite and >= 0".to_string());
    }
    if side == OrderSide::BuyBase && limit_price <= 0.0 {
        return Err("BuyBase orders must specify limit_price > 0".to_string());
    }
    Ok(())
}

fn resolve_trader_label(checksum_addr: &str, provided: Option<String>) -> String {
    if let Some(lbl) = provided {
        let trimmed = lbl.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    for w in all_demo_wallets() {
        if w.address.eq_ignore_ascii_case(checksum_addr) {
            return w.name.to_string();
        }
    }
    if checksum_addr.len() >= 10 {
        format!(
            "{}…{}",
            &checksum_addr[0..6],
            &checksum_addr[checksum_addr.len() - 4..]
        )
    } else {
        checksum_addr.to_string()
    }
}

fn normalize_addr_key(addr: &str) -> String {
    parse_eth_address(addr)
        .map(|b| format!("0x{}", hex::encode(b)))
        .unwrap_or_else(|_| addr.trim().to_lowercase())
}

pub fn now_unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(1_794_937_000)
}
