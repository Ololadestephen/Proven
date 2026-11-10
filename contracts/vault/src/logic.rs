//! The vault's pure logic: no host calls, no allocation, so it can be tested on the host and
//! reused by the bounty contract's vector tests. The WASM entry points in `lib.rs` only read and
//! write state and call host functions around these rules.

/// NEP-413's prefix tag, 2^31 + 413.
pub const NEP413_TAG: u32 = 2_147_484_061;
/// NEAR's storage price, 10^19 yoctoNEAR per byte.
pub const BYTE_COST: u128 = 10_000_000_000_000_000_000;
/// The latest a withdrawal's deadline may be, after the executing block's time (15 minutes).
pub const MAX_DEADLINE_AHEAD_NS: u64 = 900 * 1_000_000_000;
pub const RECORD_LEN: usize = 25;
pub const INFO_LEN: usize = 106;
pub const MAX_MESSAGE: usize = 512;
pub const MAX_PAYLOAD: usize = 4 + 4 + MAX_MESSAGE + 32 + 4 + 64 + 1;

pub const E_ARGS: &str = "bad arguments";
pub const E_INIT: &str = "vault not initialized";
pub const E_SIGNATURE: &str = "bad signature";
pub const E_NUMBER: &str = "wrong withdrawal number";
pub const E_PASSED: &str = "withdrawal deadline passed";
pub const E_TOO_FAR: &str = "withdrawal deadline too far ahead";
pub const E_DESTINATION: &str = "bad destination";
pub const E_BALANCE: &str = "more than the vault can pay";
pub const E_DEPOSIT_AMOUNT: &str = "attach the amount and the storage fee";
pub const E_HAS_DEPOSIT: &str = "this settlement already has a deposit";
pub const E_SEALED: &str = "this attempt is sealed";
pub const E_FEE: &str = "attach the storage fee";

/// `(v / 10, v % 10)` with 32-bit limbs, so the WASM needs no 128-bit division routine.
pub fn div10(v: u128) -> (u128, u8) {
    let mut q: u128 = 0;
    let mut rem: u64 = 0;
    for shift in [96u32, 64, 32, 0] {
        let cur = (rem << 32) | ((v >> shift) as u32 as u64);
        q |= u128::from(cur / 10) << shift;
        rem = cur % 10;
    }
    (q, rem as u8)
}

/// Copies without a length-mismatch panic (stops at the shorter side).
#[inline]
pub fn copy(dst: &mut [u8], src: &[u8]) {
    for (d, s) in dst.iter_mut().zip(src.iter()) {
        *d = *s;
    }
}

/// Writes `src` into `dst` from `at`, without a panic (bytes past the end are dropped; callers
/// pass fixed offsets inside fixed-size arrays).
#[inline]
pub fn put_at(dst: &mut [u8], at: usize, src: &[u8]) {
    for (k, x) in src.iter().enumerate() {
        if let Some(d) = dst.get_mut(at.wrapping_add(k)) {
            *d = *x;
        }
    }
}

/// `b[start..end]` without a panic.
#[inline]
pub fn sub(b: &[u8], start: usize, end: usize) -> Result<&[u8], &'static str> {
    b.get(start..end).ok_or(E_ARGS)
}

/// A bounded byte writer for messages and payloads.
pub struct Writer<'a> {
    buf: &'a mut [u8],
    len: usize,
}

impl<'a> Writer<'a> {
    pub fn new(buf: &'a mut [u8]) -> Self {
        Writer { buf, len: 0 }
    }

    pub fn put(&mut self, bytes: &[u8]) -> Result<(), &'static str> {
        let end = self.len.checked_add(bytes.len()).ok_or(E_ARGS)?;
        let dst = self.buf.get_mut(self.len..end).ok_or(E_ARGS)?;
        copy(dst, bytes);
        self.len = end;
        Ok(())
    }

    pub fn put_dec(&mut self, mut v: u128) -> Result<(), &'static str> {
        let mut digits = [0u8; 39];
        let mut i = digits.len();
        for d in digits.iter_mut().rev() {
            let (q, r) = div10(v);
            *d = b'0' + r;
            v = q;
            i -= 1;
            if v == 0 {
                break;
            }
        }
        self.put(digits.get(i..).ok_or(E_ARGS)?)
    }

    /// A borsh string: u32 little-endian length, then the bytes.
    pub fn put_borsh_str(&mut self, s: &[u8]) -> Result<(), &'static str> {
        self.put(&(s.len() as u32).to_le_bytes())?;
        self.put(s)
    }

    pub fn len(&self) -> usize {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }
}

/// NEAR's account id rules: 2 to 64 bytes of `a-z`, `0-9`, `-`, `_`, `.`, with no separator at the
/// start or end and no two separators in a row.
pub fn is_account_id(id: &[u8]) -> bool {
    if id.len() < 2 || id.len() > 64 {
        return false;
    }
    let mut last_sep = true;
    for &c in id.iter() {
        let sep = matches!(c, b'-' | b'_' | b'.');
        let ok = c.is_ascii_lowercase() || c.is_ascii_digit() || sep;
        if !ok || (sep && last_sep) {
            return false;
        }
        last_sep = sep;
    }
    !last_sep
}

/// One decoded withdrawal request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Withdrawal<'a> {
    pub to: &'a [u8],
    pub amount: u128,
    pub n: u64,
    pub deadline: u64,
    pub signature: [u8; 64],
}

fn skip_ws(b: &[u8], mut i: usize) -> usize {
    while matches!(b.get(i), Some(b' ' | b'\t' | b'\n' | b'\r')) {
        i += 1;
    }
    i
}

/// A JSON string with no escapes and no control characters; returns its bytes and the index
/// after the closing quote.
fn json_str(b: &[u8], i: usize) -> Result<(&[u8], usize), &'static str> {
    if b.get(i) != Some(&b'"') {
        return Err(E_ARGS);
    }
    let start = i + 1;
    let mut j = start;
    while let Some(&c) = b.get(j) {
        match c {
            b'"' => return Ok((sub(b, start, j)?, j + 1)),
            b'\\' => return Err(E_ARGS),
            c if c < 0x20 => return Err(E_ARGS),
            _ => j += 1,
        }
    }
    Err(E_ARGS)
}

/// A plain decimal string with no sign and no leading zero (other than "0") that fits `max`.
pub fn decimal(s: &[u8], max: u128) -> Result<u128, &'static str> {
    if s.is_empty() || s.len() > 39 || (s.len() > 1 && s.first() == Some(&b'0')) {
        return Err(E_ARGS);
    }
    let mut v: u128 = 0;
    for &c in s.iter() {
        if !c.is_ascii_digit() {
            return Err(E_ARGS);
        }
        v = v
            .checked_mul(10)
            .and_then(|v| v.checked_add(u128::from(c - b'0')))
            .ok_or(E_ARGS)?;
    }
    if v > max {
        return Err(E_ARGS);
    }
    Ok(v)
}

fn hex64(s: &[u8]) -> Result<[u8; 64], &'static str> {
    if s.len() != 128 {
        return Err(E_ARGS);
    }
    let nib = |c: u8| match c {
        b'0'..=b'9' => Ok(c - b'0'),
        b'a'..=b'f' => Ok(c - b'a' + 10),
        _ => Err(E_ARGS),
    };
    let mut out = [0u8; 64];
    for (k, o) in out.iter_mut().enumerate() {
        let hi = *s.get(2 * k).ok_or(E_ARGS)?;
        let lo = *s.get(2 * k + 1).ok_or(E_ARGS)?;
        *o = (nib(hi)? << 4) | nib(lo)?;
    }
    Ok(out)
}

/// Decodes `withdraw`'s JSON arguments: exactly the string members `to`, `amount`, `n`,
/// `deadline` and `signature`, in any order, with insignificant whitespace. Escapes, duplicate,
/// unknown or missing members, non-decimal or zero-padded numbers and overflow are refused.
pub fn parse_withdraw(b: &[u8]) -> Result<Withdrawal<'_>, &'static str> {
    let mut i = skip_ws(b, 0);
    if b.get(i) != Some(&b'{') {
        return Err(E_ARGS);
    }
    i = skip_ws(b, i + 1);
    let (mut to, mut amount, mut n, mut deadline, mut sig) = (None, None, None, None, None);
    let mut first = true;
    loop {
        if b.get(i) == Some(&b'}') && first {
            return Err(E_ARGS);
        }
        let (key, after) = json_str(b, i)?;
        i = skip_ws(b, after);
        if b.get(i) != Some(&b':') {
            return Err(E_ARGS);
        }
        i = skip_ws(b, i + 1);
        let (value, after) = json_str(b, i)?;
        i = skip_ws(b, after);
        let slot_taken = match key {
            b"to" => to.replace(value).is_some(),
            b"amount" => amount.replace(decimal(value, u128::MAX)?).is_some(),
            b"n" => n
                .replace(decimal(value, u128::from(u64::MAX))? as u64)
                .is_some(),
            b"deadline" => deadline
                .replace(decimal(value, u128::from(u64::MAX))? as u64)
                .is_some(),
            b"signature" => sig.replace(hex64(value)?).is_some(),
            _ => return Err(E_ARGS),
        };
        if slot_taken {
            return Err(E_ARGS);
        }
        first = false;
        match b.get(i) {
            Some(b',') => i = skip_ws(b, i + 1),
            Some(b'}') => {
                i = skip_ws(b, i + 1);
                break;
            }
            _ => return Err(E_ARGS),
        }
    }
    if i != b.len() {
        return Err(E_ARGS);
    }
    Ok(Withdrawal {
        to: to.ok_or(E_ARGS)?,
        amount: amount.ok_or(E_ARGS)?,
        n: n.ok_or(E_ARGS)?,
        deadline: deadline.ok_or(E_ARGS)?,
        signature: sig.ok_or(E_ARGS)?,
    })
}

/// The deadline rule: refused at or after the deadline, or if the deadline is more than
/// 15 minutes after the executing block.
pub fn check_deadline(now_ns: u64, deadline_s: u64) -> Result<(), &'static str> {
    let d = deadline_s.checked_mul(1_000_000_000).ok_or(E_TOO_FAR)?;
    if now_ns >= d {
        return Err(E_PASSED);
    }
    if d - now_ns > MAX_DEADLINE_AHEAD_NS {
        return Err(E_TOO_FAR);
    }
    Ok(())
}

/// The text a withdrawal signs.
#[allow(clippy::too_many_arguments)]
pub fn withdraw_message<'a>(
    buf: &'a mut [u8; MAX_MESSAGE],
    chain: &[u8],
    vault: &[u8],
    to: &[u8],
    amount: u128,
    n: u64,
    deadline: u64,
) -> Result<&'a [u8], &'static str> {
    let mut w = Writer::new(buf);
    w.put(b"proven-vault-withdraw:v2|chain=")?;
    w.put(chain)?;
    w.put(b"|vault=")?;
    w.put(vault)?;
    w.put(b"|to=")?;
    w.put(to)?;
    w.put(b"|amount=")?;
    w.put_dec(amount)?;
    w.put(b"|n=")?;
    w.put_dec(u128::from(n))?;
    w.put(b"|deadline=")?;
    w.put_dec(u128::from(deadline))?;
    let len = w.len();
    buf.get(..len).ok_or(E_ARGS)
}

/// A withdrawal's NEP-413 nonce: 24 zero bytes, then the withdrawal number, big-endian.
pub fn withdraw_nonce(n: u64) -> [u8; 32] {
    let mut nonce = [0u8; 32];
    let be = n.to_be_bytes();
    put_at(&mut nonce, 24, &be);
    nonce
}

/// The bytes NEP-413 hashes: tag, borsh(message, nonce, recipient, no callback URL).
pub fn nep413_payload<'a>(
    buf: &'a mut [u8; MAX_PAYLOAD],
    message: &[u8],
    nonce: &[u8; 32],
    recipient: &[u8],
) -> Result<&'a [u8], &'static str> {
    let mut w = Writer::new(buf);
    w.put(&NEP413_TAG.to_le_bytes())?;
    w.put_borsh_str(message)?;
    w.put(nonce)?;
    w.put_borsh_str(recipient)?;
    w.put(&[0])?;
    let len = w.len();
    buf.get(..len).ok_or(E_ARGS)
}

/// A settlement record: deposit flag, attempt, amount, highest sealed attempt.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Record {
    pub deposited: bool,
    pub attempt: u32,
    pub amount: u128,
    pub sealed_through: u32,
}

impl Record {
    pub fn encode(&self) -> [u8; RECORD_LEN] {
        let mut out = [0u8; RECORD_LEN];
        out[0] = u8::from(self.deposited);
        put_at(&mut out, 1, &self.attempt.to_le_bytes());
        put_at(&mut out, 5, &self.amount.to_le_bytes());
        put_at(&mut out, 21, &self.sealed_through.to_le_bytes());
        out
    }

    pub fn decode(b: &[u8]) -> Result<Self, &'static str> {
        let b: &[u8; RECORD_LEN] = b.try_into().map_err(|_| E_ARGS)?;
        if b[0] > 1 {
            return Err(E_ARGS);
        }
        Ok(Record {
            deposited: b[0] == 1,
            attempt: u32::from_le_bytes([b[1], b[2], b[3], b[4]]),
            amount: le_u128(sub(b, 5, 21)?),
            sealed_through: u32::from_le_bytes([b[21], b[22], b[23], b[24]]),
        })
    }

    /// A deposit for `attempt` of `amount`: once per record, never for a sealed attempt.
    pub fn deposit(self, attempt: u32, amount: u128) -> Result<Self, &'static str> {
        if attempt == 0 || amount == 0 {
            return Err(E_DEPOSIT_AMOUNT);
        }
        if self.deposited {
            return Err(E_HAS_DEPOSIT);
        }
        if attempt <= self.sealed_through {
            return Err(E_SEALED);
        }
        Ok(Record {
            deposited: true,
            attempt,
            amount,
            ..self
        })
    }

    /// A seal of `attempt`: with no deposit, raises the sealed number (never lowers it).
    pub fn seal(self, attempt: u32) -> Self {
        if !self.deposited && attempt > self.sealed_through {
            Record {
                sealed_through: attempt,
                ..self
            }
        } else {
            self
        }
    }
}

/// Little-endian u128 from the first 16 bytes (missing bytes read as zero; callers check length).
pub fn le_u128(b: &[u8]) -> u128 {
    let mut a = [0u8; 16];
    copy(&mut a, b);
    u128::from_le_bytes(a)
}

/// Little-endian u64 from the first 8 bytes (missing bytes read as zero; callers check length).
pub fn le_u64(b: &[u8]) -> u64 {
    let mut a = [0u8; 8];
    copy(&mut a, b);
    u64::from_le_bytes(a)
}

/// `deposit` arguments: bounty u64, kind u8, attempt u32, amount u128 (29 bytes).
pub fn decode_deposit(b: &[u8]) -> Result<(u64, u8, u32, u128), &'static str> {
    let b: &[u8; 29] = b.try_into().map_err(|_| E_ARGS)?;
    Ok((
        le_u64(&b[0..8]),
        b[8],
        u32::from_le_bytes([b[9], b[10], b[11], b[12]]),
        le_u128(sub(b, 13, 29)?),
    ))
}

/// `seal` arguments: bounty u64, kind u8, attempt u32 (13 bytes).
pub fn decode_seal(b: &[u8]) -> Result<(u64, u8, u32), &'static str> {
    let b: &[u8; 13] = b.try_into().map_err(|_| E_ARGS)?;
    Ok((
        le_u64(&b[0..8]),
        b[8],
        u32::from_le_bytes([b[9], b[10], b[11], b[12]]),
    ))
}

/// Storage the vault must keep for itself beyond its fund, given its byte usage.
pub fn shortfall(usage_bytes: u64, fund: u128) -> u128 {
    // At most (2^64 - 1) x 10^19 < 2^128, so the product cannot overflow.
    u128::from(usage_bytes)
        .wrapping_mul(BYTE_COST)
        .saturating_sub(fund)
}

/// A stored public key: curve byte 0 (ed25519), then 32 bytes.
pub fn ed25519_key(stored: &[u8]) -> Result<[u8; 32], &'static str> {
    let stored: &[u8; 33] = stored.try_into().map_err(|_| E_INIT)?;
    if stored[0] != 0 {
        return Err(E_INIT);
    }
    let mut k = [0u8; 32];
    copy(&mut k, sub(stored, 1, 33)?);
    Ok(k)
}

/// The 106-byte `info` answer.
pub fn encode_info(
    primary: &[u8; 33],
    backup: &[u8; 33],
    n: u64,
    fund: u128,
    available: u128,
) -> [u8; INFO_LEN] {
    let mut out = [0u8; INFO_LEN];
    put_at(&mut out, 0, primary);
    put_at(&mut out, 33, backup);
    put_at(&mut out, 66, &n.to_le_bytes());
    put_at(&mut out, 74, &fund.to_le_bytes());
    put_at(&mut out, 90, &available.to_le_bytes());
    out
}
