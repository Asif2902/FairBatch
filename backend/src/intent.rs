//! Cryptographic Commit-Reveal (`keccak256`) and EIP-712 (`k256` secp256k1 ECDSA)
//! intent verification engine matching `src/intent.fe`.

use k256::ecdsa::{RecoveryId, Signature, SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha3::{Digest, Keccak256};

use crate::clearing::OrderSide;
use crate::math::{f64_to_raw, f64_to_wad};

pub const EIP712_DOMAIN_TYPE: &str =
    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";
pub const EIP712_DOMAIN_NAME: &str = "FairBatch";
pub const EIP712_DOMAIN_VERSION: &str = "1";
pub const SIGNED_ORDER_TYPE: &str =
    "SignedOrder(address trader,uint8 side,uint256 amountIn,uint256 limitPrice,uint256 batchId,uint256 nonce,uint256 deadline)";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DemoWalletDto {
    pub index: usize,
    pub name: String,
    pub address: String,
}

#[derive(Clone)]
pub struct DemoWallet {
    pub index: usize,
    pub name: &'static str,
    pub address_bytes: [u8; 20],
    pub address: String,
    pub signing_key: SigningKey,
}

#[inline]
pub fn keccak256(data: &[u8]) -> [u8; 32] {
    let mut hasher = Keccak256::new();
    hasher.update(data);
    let out = hasher.finalize();
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&out);
    arr
}

#[inline]
pub fn word_u128(v: u128) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[16..].copy_from_slice(&v.to_be_bytes());
    w
}

#[inline]
pub fn word_u64(v: u64) -> [u8; 32] {
    word_u128(u128::from(v))
}

#[inline]
pub fn word_address(addr: &[u8; 20]) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[12..].copy_from_slice(addr);
    w
}

pub fn parse_eth_address(addr: &str) -> Result<[u8; 20], String> {
    let trimmed = addr.trim();
    let hex_part = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
        .unwrap_or(trimmed);
    if hex_part.len() != 40 {
        return Err(format!(
            "Invalid Ethereum address length (expected 40 hex chars, got {})",
            hex_part.len()
        ));
    }
    let bytes = hex::decode(hex_part).map_err(|e| format!("Invalid hex in address: {e}"))?;
    let mut out = [0u8; 20];
    out.copy_from_slice(&bytes);
    Ok(out)
}

/// Formats a 20-byte Ethereum address with EIP-55 mixed-case checksum.
pub fn to_checksum_address(addr: &[u8; 20]) -> String {
    let lower = hex::encode(addr);
    let hash = keccak256(lower.as_bytes());
    let mut out = String::with_capacity(42);
    out.push_str("0x");
    for (i, ch) in lower.chars().enumerate() {
        let nibble = if i % 2 == 0 {
            hash[i / 2] >> 4
        } else {
            hash[i / 2] & 0x0f
        };
        if nibble >= 8 {
            out.push(ch.to_ascii_uppercase());
        } else {
            out.push(ch);
        }
    }
    out
}

/// Parses a salt string (`0x...` hex word, decimal `u128`, or UTF-8 passphrase) into a 32-byte EVM word.
pub fn parse_salt_word(salt: &str) -> [u8; 32] {
    let trimmed = salt.trim();
    if let Some(hex_str) = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
    {
        if !hex_str.is_empty() && hex_str.len() <= 64 && hex_str.chars().all(|c| c.is_ascii_hexdigit())
        {
            let padded = if hex_str.len() % 2 == 1 {
                format!("0{hex_str}")
            } else {
                hex_str.to_string()
            };
            if let Ok(decoded) = hex::decode(&padded) {
                let mut word = [0u8; 32];
                let start = 32 - decoded.len();
                word[start..].copy_from_slice(&decoded);
                return word;
            }
        }
    }
    if let Ok(num) = trimmed.parse::<u128>() {
        return word_u128(num);
    }
    keccak256(trimmed.as_bytes())
}

/// Exact `keccak_words([batch_id, trader, side, amount_in, limit_price, salt])` commitment hash
/// matching `FairBatch` contract in `src/intent.fe`.
pub fn compute_commitment_hash_raw(
    batch_id: u128,
    trader: &[u8; 20],
    side: u8,
    amount_in_raw: u128,
    limit_price_wad: u128,
    salt_word: &[u8; 32],
) -> [u8; 32] {
    let mut buf = [0u8; 192];
    buf[0..32].copy_from_slice(&word_u128(batch_id));
    buf[32..64].copy_from_slice(&word_address(trader));
    buf[64..96].copy_from_slice(&word_u128(u128::from(side)));
    buf[96..128].copy_from_slice(&word_u128(amount_in_raw));
    buf[128..160].copy_from_slice(&word_u128(limit_price_wad));
    buf[160..192].copy_from_slice(salt_word);
    keccak256(&buf)
}

/// Computes `0x`-prefixed commitment hash from human order parameters.
#[allow(clippy::too_many_arguments)]
pub fn compute_commitment_hash_human(
    batch_id: u64,
    trader: &str,
    side: OrderSide,
    amount_in: f64,
    limit_price: f64,
    salt: &str,
    base_decimals: u8,
    quote_decimals: u8,
) -> Result<String, String> {
    let trader_bytes = parse_eth_address(trader)?;
    let in_decimals = match side {
        OrderSide::SellBase => base_decimals,
        OrderSide::BuyBase => quote_decimals,
    };
    let amount_in_raw = f64_to_raw(amount_in, in_decimals);
    let limit_price_wad = f64_to_wad(limit_price);
    let salt_word = parse_salt_word(salt);

    let hash = compute_commitment_hash_raw(
        u128::from(batch_id),
        &trader_bytes,
        side.as_u8(),
        amount_in_raw,
        limit_price_wad,
        &salt_word,
    );
    Ok(format!("0x{}", hex::encode(hash)))
}

/// Computes EIP-712 `FairBatch` Domain Separator matching `Domain::new(name_hash: keccak("FairBatch"), version_hash: keccak("1"))`.
pub fn compute_domain_separator(chain_id: u64, verifying_contract: &[u8; 20]) -> [u8; 32] {
    let type_hash = keccak256(EIP712_DOMAIN_TYPE.as_bytes());
    let name_hash = keccak256(EIP712_DOMAIN_NAME.as_bytes());
    let version_hash = keccak256(EIP712_DOMAIN_VERSION.as_bytes());

    let mut buf = [0u8; 160];
    buf[0..32].copy_from_slice(&type_hash);
    buf[32..64].copy_from_slice(&name_hash);
    buf[64..96].copy_from_slice(&version_hash);
    buf[96..128].copy_from_slice(&word_u64(chain_id));
    buf[128..160].copy_from_slice(&word_address(verifying_contract));
    keccak256(&buf)
}

/// Computes EIP-712 `SignedOrder` struct hash.
pub fn compute_signed_order_struct_hash(
    trader: &[u8; 20],
    side: u8,
    amount_in: u128,
    limit_price: u128,
    batch_id: u64,
    nonce: u64,
    deadline: u64,
) -> [u8; 32] {
    let type_hash = keccak256(SIGNED_ORDER_TYPE.as_bytes());
    let mut buf = [0u8; 256];
    buf[0..32].copy_from_slice(&type_hash);
    buf[32..64].copy_from_slice(&word_address(trader));
    buf[64..96].copy_from_slice(&word_u128(u128::from(side)));
    buf[96..128].copy_from_slice(&word_u128(amount_in));
    buf[128..160].copy_from_slice(&word_u128(limit_price));
    buf[160..192].copy_from_slice(&word_u64(batch_id));
    buf[192..224].copy_from_slice(&word_u64(nonce));
    buf[224..256].copy_from_slice(&word_u64(deadline));
    keccak256(&buf)
}

/// Computes `\x19\x01 || domainSeparator || structHash` EIP-712 digest.
pub fn compute_eip712_digest(domain_separator: &[u8; 32], struct_hash: &[u8; 32]) -> [u8; 32] {
    let mut buf = [0u8; 66];
    buf[0] = 0x19;
    buf[1] = 0x01;
    buf[2..34].copy_from_slice(domain_separator);
    buf[34..66].copy_from_slice(struct_hash);
    keccak256(&buf)
}

/// Computes EIP-191 `personal_sign` digest over a 32-byte message hash.
pub fn compute_personal_sign_digest(inner_hash: &[u8; 32]) -> [u8; 32] {
    const PREFIX: &[u8] = b"\x19Ethereum Signed Message:\n32";
    let mut buf = Vec::with_capacity(PREFIX.len() + 32);
    buf.extend_from_slice(PREFIX);
    buf.extend_from_slice(inner_hash);
    keccak256(&buf)
}

/// Derives 20-byte Ethereum address from a `k256` `VerifyingKey`.
pub fn verifying_key_to_address(vk: &VerifyingKey) -> [u8; 20] {
    let uncompressed = vk.to_encoded_point(false);
    let bytes = uncompressed.as_bytes();
    debug_assert_eq!(bytes.len(), 65);
    debug_assert_eq!(bytes[0], 0x04);
    let hash = keccak256(&bytes[1..65]);
    let mut addr = [0u8; 20];
    addr.copy_from_slice(&hash[12..32]);
    addr
}

/// Signs a 32-byte prehash digest using secp256k1 ECDSA (`k256`) and encodes `0x{r}{s}{v}` (`v` in 27..=28).
pub fn sign_prehash_ethereum(
    signing_key: &SigningKey,
    digest: &[u8; 32],
) -> Result<String, String> {
    let (sig, rec_id) = signing_key
        .sign_prehash_recoverable(digest)
        .map_err(|e| format!("ECDSA sign failed: {e}"))?;
    let mut out = [0u8; 65];
    out[0..64].copy_from_slice(&sig.to_bytes());
    out[64] = rec_id.to_byte() + 27;
    Ok(format!("0x{}", hex::encode(out)))
}

/// Recovers the 20-byte Ethereum signer address from a 65-byte `0x{r}{s}{v}` or 64-byte EIP-2098 signature,
/// strictly enforcing EIP-2 low-`s` canonical signatures.
pub fn recover_signer_from_digest(digest: &[u8; 32], signature_hex: &str) -> Result<[u8; 20], String> {
    let trimmed = signature_hex.trim();
    let hex_part = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
        .unwrap_or(trimmed);
    let raw = hex::decode(hex_part).map_err(|e| format!("Invalid signature hex: {e}"))?;

    let (r_s_bytes, rec_byte): ([u8; 64], u8) = match raw.len() {
        65 => {
            let mut rs = [0u8; 64];
            rs.copy_from_slice(&raw[0..64]);
            let v = raw[64];
            let normalized_v = match v {
                0 | 1 => v,
                27 | 28 => v - 27,
                _ => return Err(format!("Invalid ECDSA recovery id v={v}")),
            };
            (rs, normalized_v)
        }
        64 => {
            // EIP-2098 compact signature: bit 255 of `vs` encodes yParity
            let mut rs = [0u8; 64];
            rs.copy_from_slice(&raw);
            let y_parity = (rs[32] >> 7) & 1;
            rs[32] &= 0x7f;
            (rs, y_parity)
        }
        len => {
            return Err(format!(
                "Invalid signature byte length (expected 65 or 64 bytes, got {len})"
            ))
        }
    };

    let sig = Signature::from_slice(&r_s_bytes)
        .map_err(|e| format!("Malformed ECDSA r/s scalars: {e}"))?;

    // EIP-2 canonical low-S check matching OpenZeppelin & Fe 26.5 `std::evm::signature::recover`
    if sig.normalize_s().is_some() {
        return Err("Non-canonical high-S malleable signature rejected (EIP-2)".to_string());
    }

    let rec_id = RecoveryId::from_byte(rec_byte)
        .ok_or_else(|| format!("Invalid recovery id byte: {rec_byte}"))?;
    let vk = VerifyingKey::recover_from_prehash(digest, &sig, rec_id)
        .map_err(|e| format!("secp256k1 public key recovery failed: {e}"))?;

    Ok(verifying_key_to_address(&vk))
}

#[derive(Debug, Clone)]
pub struct SignedOrderParams {
    pub chain_id: u64,
    pub verifying_contract: [u8; 20],
    pub trader: [u8; 20],
    pub side: OrderSide,
    pub amount_in: f64,
    pub limit_price: f64,
    pub batch_id: u64,
    pub nonce: u64,
    pub deadline: u64,
    pub base_decimals: u8,
    pub quote_decimals: u8,
}

impl SignedOrderParams {
    pub fn canonical_digest(&self) -> [u8; 32] {
        let in_decimals = match self.side {
            OrderSide::SellBase => self.base_decimals,
            OrderSide::BuyBase => self.quote_decimals,
        };
        let amount_in_raw = f64_to_raw(self.amount_in, in_decimals);
        let limit_price_wad = f64_to_wad(self.limit_price);
        let domain = compute_domain_separator(self.chain_id, &self.verifying_contract);
        let struct_hash = compute_signed_order_struct_hash(
            &self.trader,
            self.side.as_u8(),
            amount_in_raw,
            limit_price_wad,
            self.batch_id,
            self.nonce,
            self.deadline,
        );
        compute_eip712_digest(&domain, &struct_hash)
    }
}

/// Verifies an EIP-712 `SignedOrder` signature against `params.trader`.
/// Supports canonical EIP-712 `eth_signTypedData_v4` as well as browser `personal_sign` over the EIP-712 digest.
pub fn verify_signed_order(params: &SignedOrderParams, signature_hex: &str) -> Result<[u8; 20], String> {
    let canonical = params.canonical_digest();
    let recovered_primary = recover_signer_from_digest(&canonical, signature_hex)?;
    if recovered_primary == params.trader {
        return Ok(recovered_primary);
    }

    // Fallback 1: MetaMask/browser `personal_sign` wrapping the exact EIP-712 digest
    let personal = compute_personal_sign_digest(&canonical);
    if let Ok(rec) = recover_signer_from_digest(&personal, signature_hex) {
        if rec == params.trader {
            return Ok(rec);
        }
    }

    // Fallback 2: Browser `eth_signTypedData_v4` if client scaled `amountIn` as 18-decimal WAD for 6-decimal quote
    let domain = compute_domain_separator(params.chain_id, &params.verifying_contract);
    let wad_struct_hash = compute_signed_order_struct_hash(
        &params.trader,
        params.side.as_u8(),
        f64_to_wad(params.amount_in),
        f64_to_wad(params.limit_price),
        params.batch_id,
        params.nonce,
        params.deadline,
    );
    let wad_digest = compute_eip712_digest(&domain, &wad_struct_hash);
    if let Ok(rec) = recover_signer_from_digest(&wad_digest, signature_hex) {
        if rec == params.trader {
            return Ok(rec);
        }
    }

    Err(format!(
        "Invalid EIP-712 signature: recovered {} != expected trader {}",
        to_checksum_address(&recovered_primary),
        to_checksum_address(&params.trader)
    ))
}

const DEMO_WALLET_NAMES: [(&str, &str); 6] = [
    ("Alice", "fairbatch-demo-trader-0-alice"),
    ("Bob", "fairbatch-demo-trader-1-bob"),
    ("Carol", "fairbatch-demo-trader-2-carol"),
    ("Dave", "fairbatch-demo-trader-3-dave"),
    ("Eve", "fairbatch-demo-trader-4-eve"),
    ("MEV Sandwich Bot", "fairbatch-demo-attacker-5-mev-bot"),
];

pub fn all_demo_wallets() -> Vec<DemoWallet> {
    DEMO_WALLET_NAMES
        .iter()
        .enumerate()
        .map(|(index, (name, seed))| {
            let key_bytes = keccak256(seed.as_bytes());
            let signing_key =
                SigningKey::from_slice(&key_bytes).expect("deterministic demo key must be valid");
            let vk = *signing_key.verifying_key();
            let address_bytes = verifying_key_to_address(&vk);
            let address = to_checksum_address(&address_bytes);
            DemoWallet {
                index,
                name,
                address_bytes,
                address,
                signing_key,
            }
        })
        .collect()
}

pub fn public_demo_wallet_dtos() -> Vec<DemoWalletDto> {
    all_demo_wallets()
        .into_iter()
        .take(5)
        .map(|w| DemoWalletDto {
            index: w.index,
            name: w.name.to_string(),
            address: w.address,
        })
        .collect()
}

pub fn get_demo_wallet(index: usize) -> Option<DemoWallet> {
    all_demo_wallets().into_iter().nth(index)
}

pub fn mev_bot_wallet() -> DemoWallet {
    get_demo_wallet(5).expect("MEV bot wallet index 5 exists")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_demo_wallets_deterministic_and_distinct() {
        let wallets = all_demo_wallets();
        assert_eq!(wallets.len(), 6);
        assert_eq!(wallets[0].name, "Alice");
        assert_eq!(wallets[4].name, "Eve");
        assert_eq!(wallets[5].name, "MEV Sandwich Bot");
        for i in 0..wallets.len() {
            for j in (i + 1)..wallets.len() {
                assert_ne!(wallets[i].address, wallets[j].address);
            }
        }
    }

    #[test]
    fn test_eip712_sign_recover_and_tamper_rejection() {
        let alice = get_demo_wallet(0).unwrap();
        let bob = get_demo_wallet(1).unwrap();
        let contract = [0x11u8; 20];

        let params = SignedOrderParams {
            chain_id: 11155111, // Sepolia
            verifying_contract: contract,
            trader: alice.address_bytes,
            side: OrderSide::SellBase,
            amount_in: 1.5,
            limit_price: 2750.0,
            batch_id: 1,
            nonce: 0,
            deadline: 1_900_000_000,
            base_decimals: 18,
            quote_decimals: 6,
        };

        let digest = params.canonical_digest();
        let sig = sign_prehash_ethereum(&alice.signing_key, &digest).unwrap();
        let recovered = verify_signed_order(&params, &sig).unwrap();
        assert_eq!(recovered, alice.address_bytes);

        // Tamper amount -> must fail
        let mut tampered_amt = params.clone();
        tampered_amt.amount_in = 2.5;
        assert!(verify_signed_order(&tampered_amt, &sig).is_err());

        // Tamper nonce -> must fail
        let mut tampered_nonce = params.clone();
        tampered_nonce.nonce = 1;
        assert!(verify_signed_order(&tampered_nonce, &sig).is_err());

        // Wrong signer claiming to be Bob -> must fail
        let mut wrong_trader = params.clone();
        wrong_trader.trader = bob.address_bytes;
        assert!(verify_signed_order(&wrong_trader, &sig).is_err());
    }

    #[test]
    fn test_commitment_hash_parity_and_salt_sensitivity() {
        let alice = get_demo_wallet(0).unwrap();
        let h1 = compute_commitment_hash_human(
            1,
            &alice.address,
            OrderSide::SellBase,
            1.0,
            2500.0,
            "0x000000000000000000000000000000000000000000000000000000000000002a",
            18,
            6,
        )
        .unwrap();
        let h2 = compute_commitment_hash_human(
            1,
            &alice.address,
            OrderSide::SellBase,
            1.0,
            2500.0,
            "42", // 42 == 0x2a -> identical 32-byte uint256 word!
            18,
            6,
        )
        .unwrap();
        assert_eq!(h1, h2);

        let h_bad = compute_commitment_hash_human(
            1,
            &alice.address,
            OrderSide::SellBase,
            1.0,
            2500.0,
            "43",
            18,
            6,
        )
        .unwrap();
        assert_ne!(h1, h_bad);
    }
}
