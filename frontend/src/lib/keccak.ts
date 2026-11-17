import type { OrderSide } from '../types';

const MASK_64 = (1n << 64n) - 1n;

const KECCAK_ROUND_CONSTANTS: readonly bigint[] = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

const ROTATION_OFFSETS: readonly number[] = [
  0, 1, 62, 28, 27,
  36, 44, 6, 55, 20,
  3, 10, 43, 25, 39,
  41, 45, 15, 21, 8,
  18, 2, 61, 56, 14,
];

function rotl64(value: bigint, shift: number): bigint {
  if (shift === 0) return value & MASK_64;
  const s = BigInt(shift);
  return (((value << s) | (value >> (64n - s))) & MASK_64);
}

function keccakF1600(state: bigint[]): void {
  const b = new Array<bigint>(25).fill(0n);
  const c = new Array<bigint>(5).fill(0n);
  const d = new Array<bigint>(5).fill(0n);

  for (let round = 0; round < 24; round++) {
    for (let x = 0; x < 5; x++) {
      c[x] =
        state[x] ^
        state[x + 5] ^
        state[x + 10] ^
        state[x + 15] ^
        state[x + 20];
    }

    for (let x = 0; x < 5; x++) {
      d[x] = c[(x + 4) % 5] ^ rotl64(c[(x + 1) % 5], 1);
      for (let y = 0; y < 5; y++) {
        state[x + 5 * y] = (state[x + 5 * y] ^ d[x]) & MASK_64;
      }
    }

    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        const idx = x + 5 * y;
        const newX = y;
        const newY = (2 * x + 3 * y) % 5;
        b[newX + 5 * newY] = rotl64(state[idx], ROTATION_OFFSETS[idx]);
      }
    }

    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        const idx = x + 5 * y;
        const notNext = (~b[((x + 1) % 5) + 5 * y]) & MASK_64;
        state[idx] = (b[idx] ^ (notNext & b[((x + 2) % 5) + 5 * y])) & MASK_64;
      }
    }

    state[0] = (state[0] ^ KECCAK_ROUND_CONSTANTS[round]) & MASK_64;
  }
}

export function keccak256Bytes(input: Uint8Array): Uint8Array {
  const rateBytes = 136;
  const state = new Array<bigint>(25).fill(0n);

  const rem = input.length % rateBytes;
  const paddedLen = input.length + (rateBytes - rem);
  const padded = new Uint8Array(paddedLen);
  padded.set(input);
  padded[input.length] ^= 0x01;
  padded[paddedLen - 1] ^= 0x80;

  for (let offset = 0; offset < paddedLen; offset += rateBytes) {
    for (let lane = 0; lane < 17; lane++) {
      let word = 0n;
      const base = offset + lane * 8;
      for (let byteIdx = 0; byteIdx < 8; byteIdx++) {
        word |= BigInt(padded[base + byteIdx]) << BigInt(byteIdx * 8);
      }
      state[lane] = (state[lane] ^ word) & MASK_64;
    }
    keccakF1600(state);
  }

  const out = new Uint8Array(32);
  for (let lane = 0; lane < 4; lane++) {
    const word = state[lane];
    for (let byteIdx = 0; byteIdx < 8; byteIdx++) {
      out[lane * 8 + byteIdx] = Number((word >> BigInt(byteIdx * 8)) & 0xffn);
    }
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let hex = '0x';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  const normalized = clean.length % 2 === 0 ? clean : '0' + clean;
  const out = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byteVal = Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
    out[i] = Number.isNaN(byteVal) ? 0 : byteVal;
  }
  return out;
}

export function utf8ToBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function keccak256Hex(hexData: string): string {
  return bytesToHex(keccak256Bytes(hexToBytes(hexData)));
}

export function keccak256Utf8(text: string): string {
  return bytesToHex(keccak256Bytes(utf8ToBytes(text)));
}

export function toRawBigInt(amount: number, decimals = 18): bigint {
  if (!Number.isFinite(amount) || amount <= 0) return 0n;
  const fixed = amount.toFixed(Math.min(decimals, 9));
  const [whole, frac = ''] = fixed.split('.');
  const paddedFrac = (frac + '0'.repeat(decimals)).slice(0, decimals);
  const scale = 10n ** BigInt(decimals);
  return BigInt(whole) * scale + BigInt(paddedFrac || '0');
}

export function toWadBigInt(amount: number): bigint {
  return toRawBigInt(amount, 18);
}

export function encodeUint256Word(value: bigint | number): string {
  const bn = typeof value === 'bigint' ? value : BigInt(Math.max(0, Math.floor(value)));
  return bn.toString(16).padStart(64, '0').slice(-64);
}

export function encodeAddressWord(address: string): string {
  const clean = address.toLowerCase().replace(/^0x/, '').replace(/[^0-9a-f]/g, '');
  return clean.slice(-40).padStart(64, '0');
}

export function encodeBytes32Salt(salt: string): string {
  if (/^0x[0-9a-fA-F]{64}$/.test(salt)) {
    return salt.slice(2).toLowerCase();
  }
  return keccak256Utf8(salt).slice(2);
}

export function generateRandomSaltHex(): string {
  const buf = new Uint8Array(32);
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.getRandomValues) {
    globalThis.crypto.getRandomValues(buf);
  } else {
    for (let i = 0; i < 32; i++) {
      buf[i] = Math.floor(Math.random() * 256);
    }
  }
  return bytesToHex(buf);
}

export function computeLocalCommitmentHash(params: {
  batch_id: number;
  trader: string;
  side: OrderSide;
  amount_in: number;
  limit_price: number;
  salt: string;
  base_decimals?: number;
  quote_decimals?: number;
}): string {
  const sideNum = params.side === 'SellBase' ? 0 : 1;
  const inDecimals =
    params.side === 'SellBase'
      ? (params.base_decimals ?? 18)
      : (params.quote_decimals ?? 6);
  const payloadHex =
    '0x' +
    encodeUint256Word(params.batch_id) +
    encodeAddressWord(params.trader) +
    encodeUint256Word(sideNum) +
    encodeUint256Word(toRawBigInt(params.amount_in, inDecimals)) +
    encodeUint256Word(toWadBigInt(params.limit_price)) +
    encodeBytes32Salt(params.salt);

  return keccak256Hex(payloadHex);
}

export interface Eip712TypedDataPayload {
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: string;
  };
  types: {
    EIP712Domain: Array<{ name: string; type: string }>;
    SignedOrder: Array<{ name: string; type: string }>;
  };
  primaryType: 'SignedOrder';
  message: {
    trader: string;
    side: number;
    amountIn: string;
    limitPrice: string;
    batchId: string;
    nonce: string;
    deadline: string;
  };
}

export function buildEip712TypedData(params: {
  chain_id: number;
  verifying_contract: string;
  trader: string;
  side: OrderSide;
  amount_in: number;
  limit_price: number;
  batch_id: number;
  nonce: number;
  deadline: number;
}): Eip712TypedDataPayload {
  const sideNum = params.side === 'SellBase' ? 0 : 1;
  return {
    domain: {
      name: 'FairBatch',
      version: '1',
      chainId: params.chain_id,
      verifyingContract: params.verifying_contract,
    },
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      SignedOrder: [
        { name: 'trader', type: 'address' },
        { name: 'side', type: 'uint8' },
        { name: 'amountIn', type: 'uint256' },
        { name: 'limitPrice', type: 'uint256' },
        { name: 'batchId', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    primaryType: 'SignedOrder',
    message: {
      trader: params.trader,
      side: sideNum,
      amountIn: toRawBigInt(
        params.amount_in,
        params.side === 'SellBase' ? 18 : 6,
      ).toString(),
      limitPrice: toWadBigInt(params.limit_price).toString(),
      batchId: String(params.batch_id),
      nonce: String(params.nonce),
      deadline: String(params.deadline),
    },
  };
}

export function computeLocalEip712Digest(params: {
  chain_id: number;
  verifying_contract: string;
  trader: string;
  side: OrderSide;
  amount_in: number;
  limit_price: number;
  batch_id: number;
  nonce: number;
  deadline: number;
}): string {
  const domainTypeHash = keccak256Utf8(
    'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)',
  ).slice(2);
  const nameHash = keccak256Utf8('FairBatch').slice(2);
  const versionHash = keccak256Utf8('1').slice(2);
  const domainSeparator = keccak256Hex(
    '0x' +
      domainTypeHash +
      nameHash +
      versionHash +
      encodeUint256Word(params.chain_id) +
      encodeAddressWord(params.verifying_contract),
  ).slice(2);

  const orderTypeHash = keccak256Utf8(
    'SignedOrder(address trader,uint8 side,uint256 amountIn,uint256 limitPrice,uint256 batchId,uint256 nonce,uint256 deadline)',
  ).slice(2);

  const sideNum = params.side === 'SellBase' ? 0 : 1;
  const inDecimals = params.side === 'SellBase' ? 18 : 6;
  const structHash = keccak256Hex(
    '0x' +
      orderTypeHash +
      encodeAddressWord(params.trader) +
      encodeUint256Word(sideNum) +
      encodeUint256Word(toRawBigInt(params.amount_in, inDecimals)) +
      encodeUint256Word(toWadBigInt(params.limit_price)) +
      encodeUint256Word(params.batch_id) +
      encodeUint256Word(params.nonce) +
      encodeUint256Word(params.deadline),
  ).slice(2);

  return keccak256Hex('0x1901' + domainSeparator + structHash);
}
