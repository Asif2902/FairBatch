//! Fixed-point WAD (10^18) arithmetic, overflow-safe 256-bit intermediate `mul_div`,
//! and token decimal normalization/denormalization mirroring `src/math.fe`.
//!
//! All user-facing payouts and partial-fill refunds round strictly DOWN (floor)
//! to guarantee protocol solvency to the last wei/atom.

use std::cmp::Ordering;

/// 18-decimal fixed-point unit (`10^18`).
pub const WAD: u128 = 1_000_000_000_000_000_000;
pub const WAD_F64: f64 = 1_000_000_000_000_000_000.0;
pub const MAX_DECIMALS: u8 = 18;

/// Exact 256-bit unsigned integer (`hi * 2^128 + lo`) for overflow-free
/// product and LND (`R_x' * R_y' >= R_x * R_y`) invariant comparisons.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct U256 {
    pub hi: u128,
    pub lo: u128,
}

impl U256 {
    pub const ZERO: Self = Self { hi: 0, lo: 0 };
    pub const MAX: Self = Self {
        hi: u128::MAX,
        lo: u128::MAX,
    };

    #[inline]
    pub const fn from_u128(v: u128) -> Self {
        Self { hi: 0, lo: v }
    }

    /// Exact 128x128 -> 256-bit multiplication (`a * b`).
    #[inline]
    pub const fn mul_u128(a: u128, b: u128) -> Self {
        let mask64 = 0xFFFF_FFFF_FFFF_FFFFu128;
        let a_lo = a & mask64;
        let a_hi = a >> 64;
        let b_lo = b & mask64;
        let b_hi = b >> 64;

        let p0 = a_lo * b_lo;
        let p1 = a_lo * b_hi;
        let p2 = a_hi * b_lo;
        let p3 = a_hi * b_hi;

        let mid = (p0 >> 64) + (p1 & mask64) + (p2 & mask64);
        let lo = (p0 & mask64) | ((mid & mask64) << 64);
        let hi = p3 + (p1 >> 64) + (p2 >> 64) + (mid >> 64);

        Self { hi, lo }
    }

    #[inline]
    pub fn checked_add(self, rhs: Self) -> Option<Self> {
        let (lo, carry) = self.lo.overflowing_add(rhs.lo);
        let hi = self.hi.checked_add(rhs.hi)?.checked_add(u128::from(carry))?;
        Some(Self { hi, lo })
    }

    #[inline]
    pub fn checked_sub(self, rhs: Self) -> Option<Self> {
        let (lo, borrow) = self.lo.overflowing_sub(rhs.lo);
        let hi = self.hi.checked_sub(rhs.hi)?.checked_sub(u128::from(borrow))?;
        Some(Self { hi, lo })
    }

    #[inline]
    pub fn to_be_bytes(self) -> [u8; 32] {
        let mut out = [0u8; 32];
        out[..16].copy_from_slice(&self.hi.to_be_bytes());
        out[16..].copy_from_slice(&self.lo.to_be_bytes());
        out
    }

    #[inline]
    pub fn from_be_bytes(bytes: [u8; 32]) -> Self {
        let mut hi_b = [0u8; 16];
        let mut lo_b = [0u8; 16];
        hi_b.copy_from_slice(&bytes[..16]);
        lo_b.copy_from_slice(&bytes[16..]);
        Self {
            hi: u128::from_be_bytes(hi_b),
            lo: u128::from_be_bytes(lo_b),
        }
    }
}

impl Ord for U256 {
    #[inline]
    fn cmp(&self, other: &Self) -> Ordering {
        match self.hi.cmp(&other.hi) {
            Ordering::Equal => self.lo.cmp(&other.lo),
            ord => ord,
        }
    }
}

impl PartialOrd for U256 {
    #[inline]
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// Computes `floor((a * b) / d)` with exact 256-bit intermediate product, returning `(quotient, remainder)`.
/// Returns `None` on division by zero or `u128` quotient overflow.
#[inline]
pub fn checked_mul_div_rem(a: u128, b: u128, d: u128) -> Option<(u128, u128)> {
    if d == 0 {
        return None;
    }
    let prod = U256::mul_u128(a, b);
    if prod.hi == 0 {
        return Some((prod.lo / d, prod.lo % d));
    }
    if prod.hi >= d {
        return None;
    }

    let mut rem = prod.hi;
    let mut quot = 0u128;
    for shift in (0..128).rev() {
        let bit = (prod.lo >> shift) & 1;
        let overflow = (rem >> 127) != 0;
        rem = (rem << 1) | bit;
        if overflow || rem >= d {
            rem = rem.wrapping_sub(d);
            quot |= 1u128 << shift;
        }
    }
    Some((quot, rem))
}

/// Overflow-safe `floor((a * b) / d)` matching `core::num::mul_div` in Fe 26.5.
#[inline]
pub fn mul_div(a: u128, b: u128, d: u128) -> u128 {
    checked_mul_div_rem(a, b, d)
        .expect("mul_div: division by zero or u128 overflow")
        .0
}

/// Checked `floor((a * b) / d)`.
#[inline]
pub fn checked_mul_div(a: u128, b: u128, d: u128) -> Option<u128> {
    checked_mul_div_rem(a, b, d).map(|(q, _)| q)
}

/// Overflow-safe `ceil((a * b) / d)` matching `core::num::mul_div_ceil` in Fe 26.5.
#[inline]
pub fn mul_div_ceil(a: u128, b: u128, d: u128) -> u128 {
    let (q, rem) =
        checked_mul_div_rem(a, b, d).expect("mul_div_ceil: division by zero or u128 overflow");
    if rem > 0 {
        q.checked_add(1).expect("mul_div_ceil: u128 overflow")
    } else {
        q
    }
}

/// Computes `10^(18 - decimals)` for `decimals <= 18`.
#[inline]
pub const fn decimal_scale_factor(decimals: u8) -> u128 {
    assert!(decimals <= MAX_DECIMALS, "decimals must be <= 18");
    10u128.pow((MAX_DECIMALS - decimals) as u32)
}

/// Scales raw token units (e.g. 6-decimal USDC) into 18-decimal normalized WAD space.
#[inline]
pub fn normalize_raw(raw_amount: u128, decimals: u8) -> u128 {
    raw_amount
        .checked_mul(decimal_scale_factor(decimals))
        .expect("normalize_raw overflow")
}

/// Denormalizes 18-decimal WAD amount back to raw token atoms using STRICT FLOOR division.
#[inline]
pub fn denormalize_floor(norm_amount: u128, decimals: u8) -> u128 {
    norm_amount / decimal_scale_factor(decimals)
}

/// Quantizes a normalized 18-decimal amount down to an exact multiple of the raw token atom.
#[inline]
pub fn quantize_norm_floor(norm_amount: u128, decimals: u8) -> u128 {
    let scale = decimal_scale_factor(decimals);
    (norm_amount / scale) * scale
}

/// Converts a human floating-point token amount into raw integer units (`10^decimals`).
#[inline]
pub fn f64_to_raw(amount: f64, decimals: u8) -> u128 {
    if !amount.is_finite() || amount <= 0.0 {
        return 0;
    }
    let scale = 10f64.powi(i32::from(decimals.min(MAX_DECIMALS)));
    (amount * scale).round() as u128
}

/// Converts raw integer token units (`10^decimals`) into a human floating-point number.
#[inline]
pub fn raw_to_f64(raw_amount: u128, decimals: u8) -> f64 {
    let scale = 10f64.powi(i32::from(decimals.min(MAX_DECIMALS)));
    (raw_amount as f64) / scale
}

/// Converts a human floating-point value (e.g. price in Quote/Base) into 18-decimal WAD.
#[inline]
pub fn f64_to_wad(val: f64) -> u128 {
    if !val.is_finite() || val <= 0.0 {
        return 0;
    }
    // Split integer + fractional parts so large values (e.g., 300,000.0 * 10^18) keep full 53-bit mantissa precision.
    let int_part = val.trunc();
    let frac_part = val - int_part;
    let int_wad = (int_part as u128).saturating_mul(WAD);
    let frac_wad = (frac_part * WAD_F64).round() as u128;
    int_wad.saturating_add(frac_wad)
}

/// Converts an 18-decimal WAD integer into a human floating-point value.
#[inline]
pub fn wad_to_f64(wad_val: u128) -> f64 {
    let int_part = (wad_val / WAD) as f64;
    let frac_part = ((wad_val % WAD) as f64) / WAD_F64;
    int_part + frac_part
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_mul_div_overflow_intermediate_and_rounding() {
        // Large 18-decimal values whose product overflows u128::MAX (~3.4e38):
        // 300_000 * 10^18 * 10^18 = 3 * 10^41 > u128::MAX!
        let ry = 300_000 * WAD;
        let rx_plus_2s = 110 * WAD;
        let price = mul_div(ry, WAD, rx_plus_2s);
        assert_eq!(price, 2_727_272_727_272_727_272_727u128);

        // Floor vs Ceil
        assert_eq!(mul_div(10, 1, 3), 3);
        assert_eq!(mul_div_ceil(10, 1, 3), 4);
        assert_eq!(mul_div_ceil(9, 1, 3), 3);

        // Extreme boundary: u128::MAX * (u128::MAX - 1) / u128::MAX == u128::MAX - 1
        assert_eq!(mul_div(u128::MAX, u128::MAX - 1, u128::MAX), u128::MAX - 1);
    }

    #[test]
    fn test_usdc_6_decimal_normalization_and_floor_denormalization() {
        // 2,727.272727272727272727 USDC normalized -> raw 6-decimal USDC floors to 2,727,272,727
        let norm = 2_727_272_727_272_727_272_727u128;
        let raw_usdc = denormalize_floor(norm, 6);
        assert_eq!(raw_usdc, 2_727_272_727u128);
        assert_eq!(normalize_raw(raw_usdc, 6), 2_727_272_727_000_000_000_000u128);
    }
}
