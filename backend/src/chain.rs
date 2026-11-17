//! Smart Contract Artifact Inspector & JSON-RPC Readiness Bridge (`chain.rs`).
//!
//! Reads environment variables (`RPC_URL`, `CHAIN_ID`, `FAIRBATCH_ADDRESS`,
//! `BASE_TOKEN_ADDRESS`, `QUOTE_TOKEN_ADDRESS`), dynamically scans `../out/` for
//! compiled Fe 26.5.0 contract artifacts (`.bin`, `.runtime.bin`, `.abi.json`),
//! and provides JSON-RPC `eth_call` / `eth_sendRawTransaction` forwarding when connected
//! to local Anvil or Cancun-compatible Ethereum networks (Mainnet, Sepolia, Hoodi).

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::intent::{keccak256, parse_eth_address, to_checksum_address};

pub const ZERO_ADDRESS: &str = "0x0000000000000000000000000000000000000000";
pub const DEFAULT_CHAIN_ID: u64 = 31337; // Local Anvil / Hardhat default; override via CHAIN_ID (e.g. 11155111 Sepolia)

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContractAddressesDto {
    pub fair_batch: String,
    pub base_token: String,
    pub quote_token: String,
    pub deployed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthResponse {
    pub status: String,
    pub execution_mode: String, // "local_engine" | "rpc_connected"
    pub rpc_url: Option<String>,
    pub chain_id: u64,
    pub contracts: ContractAddressesDto,
    pub fe_artifacts_present: bool,
    pub fe_artifacts: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArtifactDetailDto {
    pub file_name: String,
    pub size_bytes: u64,
    pub kind: String,
    pub abi: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SupportedNetworkDto {
    pub name: String,
    pub chain_id: u64,
    pub cancun_eip1153_ready: bool,
    pub notes: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContractsMetadataResponse {
    pub execution_mode: String,
    pub rpc_url: Option<String>,
    pub chain_id: u64,
    pub contracts: ContractAddressesDto,
    pub fe_artifacts_present: bool,
    pub artifacts: Vec<ArtifactDetailDto>,
    pub sepolia_deployment: Option<Value>,
    pub supported_networks: Vec<SupportedNetworkDto>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct UpdateContractsConfigRequest {
    pub rpc_url: Option<String>,
    pub chain_id: Option<u64>,
    pub fair_batch: Option<String>,
    pub base_token: Option<String>,
    pub quote_token: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ChainBridgeConfig {
    pub rpc_url: Option<String>,
    pub chain_id: u64,
    pub fair_batch: String,
    pub base_token: String,
    pub quote_token: String,
}

impl ChainBridgeConfig {
    pub fn from_env() -> Self {
        Self::from_lookup(|k| std::env::var(k).ok())
    }

    /// Startup constructor used by `main.rs` after `load_dotenv_if_present()`:
    /// reads environment variables and falls back to `deployments/sepolia.json` when
    /// `chain_id == 11155111` and contract addresses in `.env` are still `0x000...000`.
    pub fn from_env_with_manifest() -> Self {
        let mut cfg = Self::from_env();
        if let Some(manifest) = load_sepolia_deployment_manifest() {
            cfg.apply_manifest_fallback(&manifest);
        }
        cfg
    }

    /// Pure constructor from any key-value lookup closure (ideal for deterministic `.env` unit tests).
    pub fn from_lookup<F>(mut lookup: F) -> Self
    where
        F: FnMut(&str) -> Option<String>,
    {
        let rpc_url = lookup("RPC_URL")
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        let chain_id = lookup("CHAIN_ID")
            .and_then(|s| s.trim().parse::<u64>().ok())
            .unwrap_or(DEFAULT_CHAIN_ID);

        let fair_batch = normalize_optional_address(lookup("FAIRBATCH_ADDRESS"));
        let base_token = normalize_optional_address(lookup("BASE_TOKEN_ADDRESS"));
        let quote_token = normalize_optional_address(lookup("QUOTE_TOKEN_ADDRESS"));

        Self {
            rpc_url,
            chain_id,
            fair_batch,
            base_token,
            quote_token,
        }
    }

    /// Populates unset (`0x000...000`) contract addresses from a parsed deployment manifest
    /// (such as `deployments/sepolia.json`) when `chain_id` matches the manifest's network.
    pub fn apply_manifest_fallback(&mut self, manifest: &Value) {
        let manifest_chain_id = manifest
            .get("chain_id")
            .or_else(|| manifest.get("chainId"))
            .and_then(|v| v.as_u64())
            .or_else(|| {
                manifest
                    .get("network")
                    .and_then(|v| v.as_str())
                    .and_then(|n| {
                        if n.eq_ignore_ascii_case("sepolia") {
                            Some(11155111)
                        } else {
                            None
                        }
                    })
            })
            .unwrap_or(11155111);

        if self.chain_id != manifest_chain_id {
            return;
        }

        if self.fair_batch == ZERO_ADDRESS {
            if let Some(addr) = extract_manifest_address(
                manifest,
                &["fair_batch", "fairBatch", "fairbatch_address", "fairBatchAddress"],
            ) {
                self.fair_batch = addr;
            }
        }
        if self.base_token == ZERO_ADDRESS {
            if let Some(addr) = extract_manifest_address(
                manifest,
                &["base_token", "baseToken", "base_token_address", "weth", "fWETH"],
            ) {
                self.base_token = addr;
            }
        }
        if self.quote_token == ZERO_ADDRESS {
            if let Some(addr) = extract_manifest_address(
                manifest,
                &["quote_token", "quoteToken", "quote_token_address", "usdc", "fUSDC"],
            ) {
                self.quote_token = addr;
            }
        }
        if self.rpc_url.is_none() {
            if let Some(rpc) = manifest
                .get("rpc_url")
                .or_else(|| manifest.get("rpcUrl"))
                .and_then(|v| v.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
            {
                self.rpc_url = Some(rpc);
            }
        }
    }

    pub fn apply_update(&mut self, req: UpdateContractsConfigRequest) -> Result<(), String> {
        if let Some(rpc) = req.rpc_url {
            let trimmed = rpc.trim().to_string();
            self.rpc_url = if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            };
        }
        if let Some(cid) = req.chain_id {
            if cid == 0 {
                return Err("chain_id must be > 0".to_string());
            }
            self.chain_id = cid;
        }
        if let Some(fb) = req.fair_batch {
            self.fair_batch = validate_or_zero_address(&fb)?;
        }
        if let Some(bt) = req.base_token {
            self.base_token = validate_or_zero_address(&bt)?;
        }
        if let Some(qt) = req.quote_token {
            self.quote_token = validate_or_zero_address(&qt)?;
        }
        Ok(())
    }

    pub fn verifying_contract_bytes(&self) -> [u8; 20] {
        parse_eth_address(&self.fair_batch).unwrap_or([0u8; 20])
    }

    pub fn is_contract_deployed(&self) -> bool {
        let bytes = self.verifying_contract_bytes();
        bytes != [0u8; 20]
    }

    pub fn execution_mode(&self) -> &'static str {
        if self.rpc_url.is_some() && self.is_contract_deployed() {
            "rpc_connected"
        } else {
            "local_engine"
        }
    }

    pub fn contracts_dto(&self) -> ContractAddressesDto {
        ContractAddressesDto {
            fair_batch: self.fair_batch.clone(),
            base_token: self.base_token.clone(),
            quote_token: self.quote_token.clone(),
            deployed: self.is_contract_deployed(),
        }
    }

    pub fn build_health_response(&self) -> HealthResponse {
        let artifacts = scan_fe_artifacts();
        let names: Vec<String> = artifacts.into_iter().map(|a| a.file_name).collect();
        HealthResponse {
            status: "ok".to_string(),
            execution_mode: self.execution_mode().to_string(),
            rpc_url: self.rpc_url.clone(),
            chain_id: self.chain_id,
            contracts: self.contracts_dto(),
            fe_artifacts_present: !names.is_empty(),
            fe_artifacts: names,
        }
    }

    pub fn build_contracts_metadata(&self) -> ContractsMetadataResponse {
        let artifacts = scan_fe_artifacts();
        ContractsMetadataResponse {
            execution_mode: self.execution_mode().to_string(),
            rpc_url: self.rpc_url.clone(),
            chain_id: self.chain_id,
            contracts: self.contracts_dto(),
            fe_artifacts_present: !artifacts.is_empty(),
            artifacts,
            sepolia_deployment: load_sepolia_deployment_manifest(),
            supported_networks: vec![
                SupportedNetworkDto {
                    name: "Anvil Local EVM".to_string(),
                    chain_id: 31337,
                    cancun_eip1153_ready: true,
                    notes: "Instant local Cancun/Prague EVM verification (`anvil --hardfork cancun`).".to_string(),
                },
                SupportedNetworkDto {
                    name: "Ethereum Sepolia Testnet".to_string(),
                    chain_id: 11155111,
                    cancun_eip1153_ready: true,
                    notes: "Active Ethereum app-dev testnet supporting PUSH0, MCOPY, and EIP-1153 TLOAD/TSTORE.".to_string(),
                },
                SupportedNetworkDto {
                    name: "Ethereum Hoodi Testnet".to_string(),
                    chain_id: 560048,
                    cancun_eip1153_ready: true,
                    notes: "Modern Ethereum testnet replacing Holesky with full Cancun/Prague opcode support.".to_string(),
                },
                SupportedNetworkDto {
                    name: "Ethereum Mainnet".to_string(),
                    chain_id: 1,
                    cancun_eip1153_ready: true,
                    notes: "Full Cancun/Prague support, organic two-sided CoW orderflow & solver ecosystem.".to_string(),
                },
            ],
        }
    }

    /// Performs a read-only JSON-RPC `eth_call` against `self.fair_batch` when `rpc_url` is configured.
    pub async fn eth_call(&self, calldata_hex: &str) -> Result<String, String> {
        let rpc = self
            .rpc_url
            .as_ref()
            .ok_or_else(|| "RPC_URL is not configured".to_string())?;
        if !self.is_contract_deployed() {
            return Err("FAIRBATCH_ADDRESS is zero/unset".to_string());
        }

        let payload = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "eth_call",
            "params": [
                {
                    "to": self.fair_batch,
                    "data": calldata_hex,
                },
                "latest"
            ]
        });

        send_json_rpc(rpc, &payload).await
    }

    /// Forwards a pre-signed raw transaction (`eth_sendRawTransaction`) to the configured JSON-RPC endpoint.
    pub async fn send_raw_transaction(&self, signed_tx_hex: &str) -> Result<String, String> {
        let rpc = self
            .rpc_url
            .as_ref()
            .ok_or_else(|| "RPC_URL is not configured".to_string())?;

        let payload = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "eth_sendRawTransaction",
            "params": [signed_tx_hex]
        });

        send_json_rpc(rpc, &payload).await
    }
}

async fn send_json_rpc(rpc_url: &str, payload: &Value) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(6))
        .build()
        .map_err(|e| format!("HTTP client init error: {e}"))?;

    let resp = client
        .post(rpc_url)
        .json(payload)
        .send()
        .await
        .map_err(|e| format!("JSON-RPC request failed: {e}"))?;

    let body: Value = resp
        .json()
        .await
        .map_err(|e| format!("Invalid JSON-RPC response: {e}"))?;

    if let Some(err) = body.get("error") {
        return Err(format!("EVM RPC error: {err}"));
    }

    body.get("result")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "Missing `result` string in JSON-RPC response".to_string())
}

/// Computes 4-byte Solidity/Fe function selector `keccak256(sig)[0..4]` as `0x`-prefixed hex.
pub fn function_selector(signature: &str) -> String {
    let hash = keccak256(signature.as_bytes());
    format!("0x{}", hex::encode(&hash[0..4]))
}

fn normalize_optional_address(val: Option<String>) -> String {
    match val {
        Some(s) if !s.trim().is_empty() => validate_or_zero_address(&s).unwrap_or_else(|_| ZERO_ADDRESS.to_string()),
        _ => ZERO_ADDRESS.to_string(),
    }
}

fn validate_or_zero_address(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(ZERO_ADDRESS.to_string());
    }
    let bytes = parse_eth_address(trimmed)?;
    if bytes == [0u8; 20] {
        Ok(ZERO_ADDRESS.to_string())
    } else {
        Ok(to_checksum_address(&bytes))
    }
}

fn locate_out_directory() -> Option<PathBuf> {
    let candidates = [
        PathBuf::from("../out"),
        PathBuf::from("out"),
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../out"),
    ];
    candidates.into_iter().find(|path| path.is_dir())
}

/// Scans `out/` recursively (up to 2 levels) for Fe build outputs (`.bin`, `.runtime.bin`, `.abi`, `.json`).
pub fn scan_fe_artifacts() -> Vec<ArtifactDetailDto> {
    let Some(out_dir) = locate_out_directory() else {
        return Vec::new();
    };

    let mut files = Vec::new();
    collect_artifacts_in_dir(&out_dir, "", 0, &mut files);
    files.sort_by(|a, b| a.file_name.cmp(&b.file_name));
    files.dedup_by(|a, b| a.file_name == b.file_name);
    files
}

fn collect_artifacts_in_dir(
    dir: &Path,
    prefix: &str,
    depth: usize,
    acc: &mut Vec<ArtifactDetailDto>,
) {
    if depth > 2 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if name.starts_with('.') {
            continue;
        }
        let rel_name = if prefix.is_empty() {
            name.to_string()
        } else {
            format!("{prefix}/{name}")
        };

        if path.is_dir() {
            collect_artifacts_in_dir(&path, &rel_name, depth + 1, acc);
        } else if path.is_file() {
            let is_relevant = name.ends_with(".bin")
                || name.ends_with(".abi")
                || name.ends_with(".json")
                || name.ends_with(".yul")
                || name.ends_with(".ir");
            if !is_relevant {
                continue;
            }
            let size_bytes = entry.metadata().map(|m| m.len()).unwrap_or(0);
            let kind = if name.ends_with(".runtime.bin") {
                "runtime_bytecode"
            } else if name.ends_with(".bin") {
                "deploy_bytecode"
            } else if name.contains("abi") || name.ends_with(".json") {
                "abi_json"
            } else {
                "compiler_artifact"
            }
            .to_string();

            let abi = if kind == "abi_json" && size_bytes <= 512_000 {
                std::fs::read_to_string(&path).ok().and_then(|raw| {
                    let clean = raw.strip_prefix('\u{feff}').unwrap_or(&raw);
                    serde_json::from_str::<Value>(clean).ok()
                })
            } else {
                None
            };

            acc.push(ArtifactDetailDto {
                file_name: rel_name,
                size_bytes,
                kind,
                abi,
            });
        }
    }
}

/// Zero-dependency `.env` parser supporting `#` comments, inline `#` comments,
/// `export KEY=VALUE`, single/double-quoted values, UTF-8 BOM stripping, and skipping empty keys/values.
pub fn parse_dotenv_content(content: &str) -> Vec<(String, String)> {
    let stripped = content.strip_prefix('\u{feff}').unwrap_or(content);
    let mut pairs = Vec::new();

    for raw_line in stripped.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line
            .strip_prefix("export ")
            .map(str::trim_start)
            .unwrap_or(line);

        let Some((raw_key, raw_val)) = line.split_once('=') else {
            continue;
        };
        let key = raw_key.trim();
        if key.is_empty() || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            continue;
        }

        let val_trimmed = raw_val.trim();
        if val_trimmed.is_empty() || val_trimmed.starts_with('#') {
            continue;
        }

        let parsed_val = if let Some(after_dquote) = val_trimmed.strip_prefix('"') {
            let mut out = String::new();
            let mut escaped = false;
            for ch in after_dquote.chars() {
                if escaped {
                    match ch {
                        'n' => out.push('\n'),
                        'r' => out.push('\r'),
                        't' => out.push('\t'),
                        other => out.push(other),
                    }
                    escaped = false;
                } else if ch == '\\' {
                    escaped = true;
                } else if ch == '"' {
                    break;
                } else {
                    out.push(ch);
                }
            }
            out
        } else if let Some(after_squote) = val_trimmed.strip_prefix('\'') {
            after_squote
                .split_once('\'')
                .map(|(inner, _)| inner.to_string())
                .unwrap_or_else(|| after_squote.to_string())
        } else {
            strip_inline_comment(val_trimmed).trim().to_string()
        };

        if !parsed_val.is_empty() {
            pairs.push((key.to_string(), parsed_val));
        }
    }

    pairs
}

fn strip_inline_comment(unquoted: &str) -> &str {
    let bytes = unquoted.as_bytes();
    for i in 1..bytes.len() {
        if bytes[i] == b'#' && bytes[i - 1].is_ascii_whitespace() {
            return &unquoted[..i - 1];
        }
    }
    unquoted
}

/// Loads `.env` from CWD or workspace root (`../.env`) without overriding already-set
/// process environment variables. Safe to call at single-threaded process startup in `main.rs`.
pub fn load_dotenv_if_present() -> Option<PathBuf> {
    let candidates = [
        PathBuf::from(".env"),
        PathBuf::from("../.env"),
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../.env"),
    ];
    let found = candidates.into_iter().find(|p| p.is_file())?;
    let raw = std::fs::read_to_string(&found).ok()?;
    for (k, v) in parse_dotenv_content(&raw) {
        if std::env::var_os(&k).is_none() {
            std::env::set_var(&k, &v);
        }
    }
    Some(found)
}

fn locate_sepolia_manifest() -> Option<PathBuf> {
    let candidates = [
        PathBuf::from("../deployments/sepolia.json"),
        PathBuf::from("deployments/sepolia.json"),
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../deployments/sepolia.json"),
    ];
    candidates.into_iter().find(|p| p.is_file())
}

/// Parses a deployment manifest JSON string (stripping any Windows UTF-8 BOM `\u{feff}`),
/// and redacts any accidental secret-bearing keys.
pub fn parse_deployment_manifest_str(raw: &str) -> Option<Value> {
    let clean = raw.strip_prefix('\u{feff}').unwrap_or(raw);
    let mut parsed = serde_json::from_str::<Value>(clean).ok()?;
    redact_manifest_secrets(&mut parsed);
    Some(parsed)
}

/// Loads `deployments/sepolia.json` if present, redacting any accidental secret-bearing keys.
pub fn load_sepolia_deployment_manifest() -> Option<Value> {
    let path = locate_sepolia_manifest()?;
    let raw = std::fs::read_to_string(path).ok()?;
    parse_deployment_manifest_str(&raw)
}

fn redact_manifest_secrets(val: &mut Value) {
    match val {
        Value::Object(map) => {
            map.retain(|k, _| {
                let lower = k.to_ascii_lowercase();
                !lower.contains("private_key")
                    && !lower.contains("privatekey")
                    && !lower.contains("secret")
                    && !lower.contains("mnemonic")
            });
            for v in map.values_mut() {
                redact_manifest_secrets(v);
            }
        }
        Value::Array(arr) => {
            for item in arr {
                redact_manifest_secrets(item);
            }
        }
        _ => {}
    }
}

fn extract_manifest_address(manifest: &Value, keys: &[&str]) -> Option<String> {
    // Check nested `contracts` object first, then top-level fields
    let scopes: [Option<&Value>; 2] = [manifest.get("contracts"), Some(manifest)];
    for scope in scopes.into_iter().flatten() {
        for &key in keys {
            if let Some(entry) = scope.get(key) {
                let addr_str = entry
                    .as_str()
                    .or_else(|| entry.get("address").and_then(|v| v.as_str()));
                if let Some(s) = addr_str {
                    if let Ok(normalized) = validate_or_zero_address(s) {
                        if normalized != ZERO_ADDRESS {
                            return Some(normalized);
                        }
                    }
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn test_chain_config_default_and_runtime_update() {
        let mut cfg = ChainBridgeConfig {
            rpc_url: None,
            chain_id: DEFAULT_CHAIN_ID,
            fair_batch: ZERO_ADDRESS.to_string(),
            base_token: ZERO_ADDRESS.to_string(),
            quote_token: ZERO_ADDRESS.to_string(),
        };
        assert_eq!(cfg.execution_mode(), "local_engine");
        assert!(!cfg.is_contract_deployed());

        cfg.apply_update(UpdateContractsConfigRequest {
            rpc_url: Some("http://127.0.0.1:8545".to_string()),
            chain_id: Some(11155111),
            fair_batch: Some("0x1111111111111111111111111111111111111111".to_string()),
            base_token: Some("0x2222222222222222222222222222222222222222".to_string()),
            quote_token: Some("0x3333333333333333333333333333333333333333".to_string()),
        })
        .unwrap();

        assert_eq!(cfg.execution_mode(), "rpc_connected");
        assert!(cfg.is_contract_deployed());
        assert_eq!(cfg.chain_id, 11155111);
    }

    #[test]
    fn test_function_selector() {
        // transfer(address,uint256) == 0xa9059cbb
        assert_eq!(function_selector("transfer(address,uint256)"), "0xa9059cbb");
    }

    #[test]
    fn test_dotenv_parsing_comments_quotes_sepolia_and_empty_keys() {
        let sample_env = "\u{feff}# FairBatch Ethereum Sepolia Configuration\n\
            NETWORK=sepolia # target network\n\
            CHAIN_ID=11155111   # Ethereum Sepolia\n\
            export RPC_URL=\"https://ethereum-sepolia-rpc.publicnode.com\"\n\
            DEPLOYER_PRIVATE_KEY=\n\
            SOLVER_PRIVATE_KEY=\"\"\n\
            =invalid_empty_key\n\
            FAIRBATCH_ADDRESS='0xb665658f7ce673de350799823045384afc0302ce'\n\
            BASE_TOKEN_ADDRESS=0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14\n\
            QUOTE_TOKEN_ADDRESS=0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238\n";

        let parsed: HashMap<String, String> = parse_dotenv_content(sample_env).into_iter().collect();
        assert_eq!(parsed.get("NETWORK").map(String::as_str), Some("sepolia"));
        assert_eq!(parsed.get("CHAIN_ID").map(String::as_str), Some("11155111"));
        assert_eq!(
            parsed.get("RPC_URL").map(String::as_str),
            Some("https://ethereum-sepolia-rpc.publicnode.com")
        );
        // Empty placeholders must be ignored, never stored
        assert!(!parsed.contains_key("DEPLOYER_PRIVATE_KEY"));
        assert!(!parsed.contains_key("SOLVER_PRIVATE_KEY"));
        assert!(!parsed.contains_key(""));

        let cfg = ChainBridgeConfig::from_lookup(|k| parsed.get(k).cloned());
        assert_eq!(cfg.chain_id, 11155111);
        assert_eq!(cfg.execution_mode(), "rpc_connected");
        assert!(cfg.is_contract_deployed());
        assert_eq!(
            cfg.fair_batch.to_lowercase(),
            "0xb665658f7ce673de350799823045384afc0302ce"
        );
    }

    #[test]
    fn test_sepolia_manifest_fallback_and_secret_redaction() {
        let mut cfg = ChainBridgeConfig {
            rpc_url: Some("https://ethereum-sepolia-rpc.publicnode.com".to_string()),
            chain_id: 11155111,
            fair_batch: ZERO_ADDRESS.to_string(),
            base_token: ZERO_ADDRESS.to_string(),
            quote_token: ZERO_ADDRESS.to_string(),
        };
        assert_eq!(cfg.execution_mode(), "local_engine");

        let bom_prefixed_raw = "\u{feff}{\
            \"network\": \"sepolia\",\
            \"chain_id\": 11155111,\
            \"deployer_private_key\": \"0xdeadbeef_must_be_stripped\",\
            \"contracts\": {\
                \"fair_batch\": \"0xb665658f7ce673de350799823045384afc0302ce\",\
                \"base_token\": \"0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14\",\
                \"quote_token\": \"0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238\"\
            }\
        }";
        let manifest = parse_deployment_manifest_str(bom_prefixed_raw).expect("BOM JSON must parse");
        assert!(manifest.get("deployer_private_key").is_none());

        cfg.apply_manifest_fallback(&manifest);
        assert_eq!(cfg.execution_mode(), "rpc_connected");
        assert_eq!(
            cfg.fair_batch.to_lowercase(),
            "0xb665658f7ce673de350799823045384afc0302ce"
        );
    }
}
