#!/usr/bin/env node
/**
 * Derives an EIP-55 checksummed Ethereum public address from a 0x-prefixed
 * 32-byte private key read strictly from stdin (NEVER from argv, so the key
 * never appears in `ps`). Zero external npm dependencies: uses Node's built-in
 * `secp256k1` ECDH plus pure-JS Keccak-256 (Ethereum original padding 0x01).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

const ROTC = [
  1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14,
  27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44,
];

const PILN = [
  10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4,
  15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1,
];

const MASK64 = 0xffffffffffffffffn;

function rotl64(x, n) {
  const bn = BigInt(n);
  return ((x << bn) | (x >> (64n - bn))) & MASK64;
}

function keccakF1600(st) {
  const bc = new Array(5);
  for (let round = 0; round < 24; round += 1) {
    for (let i = 0; i < 5; i += 1) {
      bc[i] = st[i] ^ st[i + 5] ^ st[i + 10] ^ st[i + 15] ^ st[i + 20];
    }
    for (let i = 0; i < 5; i += 1) {
      const t = bc[(i + 4) % 5] ^ rotl64(bc[(i + 1) % 5], 1);
      for (let j = 0; j < 25; j += 5) st[j + i] ^= t;
    }
    let t = st[1];
    for (let i = 0; i < 24; i += 1) {
      const j = PILN[i];
      const next = st[j];
      st[j] = rotl64(t, ROTC[i]);
      t = next;
    }
    for (let j = 0; j < 25; j += 5) {
      for (let i = 0; i < 5; i += 1) bc[i] = st[j + i];
      for (let i = 0; i < 5; i += 1) {
        st[j + i] ^= (~bc[(i + 1) % 5] & MASK64) & bc[(i + 2) % 5];
      }
    }
    st[0] ^= RC[round];
  }
}

function keccak256(inputBytes) {
  const rate = 136; // (1600 - 2*256) / 8
  const st = new Array(25).fill(0n);
  const padLen = rate - (inputBytes.length % rate);
  const padded = Buffer.alloc(inputBytes.length + padLen);
  inputBytes.copy(padded, 0);
  padded[inputBytes.length] = 0x01; // Original Keccak domain separator (Ethereum)
  padded[padded.length - 1] |= 0x80;

  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i += 1) {
      st[i] ^= padded.readBigUInt64LE(off + i * 8);
    }
    keccakF1600(st);
  }

  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i += 1) {
    out.writeBigUInt64LE(st[i], i * 8);
  }
  return out;
}

function toChecksumAddress(lowerHex40) {
  const hashHex = keccak256(Buffer.from(lowerHex40, 'ascii')).toString('hex');
  let out = '0x';
  for (let i = 0; i < 40; i += 1) {
    out += parseInt(hashHex[i], 16) >= 8 ? lowerHex40[i].toUpperCase() : lowerHex40[i];
  }
  return out;
}

const raw = fs.readFileSync(0, 'utf8').trim();
const normalized = raw.startsWith('0x') || raw.startsWith('0X') ? raw.slice(2) : raw;
if (!/^[0-9a-fA-F]{64}$/.test(normalized)) {
  process.stderr.write('Invalid private key format\n');
  process.exit(1);
}

const ecdh = crypto.createECDH('secp256k1');
ecdh.setPrivateKey(Buffer.from(normalized, 'hex'));
const pubUncompressed = ecdh.getPublicKey(); // 65 bytes: 0x04 || X(32) || Y(32)
const hash = keccak256(pubUncompressed.subarray(1));
const address = toChecksumAddress(hash.subarray(12).toString('hex'));
process.stdout.write(`${address}\n`);
