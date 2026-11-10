//! Prototype NEP-616 vault (sandbox only), written against the raw host functions so the global
//! contract stays small.
//!
//! Address: derived from this code (a global contract, by hash) and three initial entries:
//! `k` the recipient's ed25519 public key (borsh: curve byte 0, then 32 bytes), `n` the next
//! withdrawal number (u64, 0) and `f` the storage fund (u128, 0). The key, not an account name,
//! is the recipient: whoever holds its private key, and nobody else, can move the money.
//!
//! Money in the vault is the recipient's, except the storage fund `f`, which always equals the
//! conservative storage cost of the vault (bytes x 10^19 yoctoNEAR) once anything is written.
//! Every write that grows the vault must bring that growth's cost in its attached fee; the vault
//! keeps exactly the shortfall and sends the rest back to the receipt's refund account. So no
//! storage, record or seal cost is ever taken from a reward or refund.
//!
//! - `deposit(bounty u64, kind u8, attempt u32, amount u128)`, payable `amount` + fee: records
//!   the issuer's (predecessor's) settlement once, for an attempt that is not sealed.
//! - `seal(bounty u64, kind u8, attempt u32)`, payable fee: if there is no deposit, seals every
//!   attempt up to `attempt`, so a later deposit for them fails; returns the slot.
//! - `withdraw(to string, amount u128, seq u64, signature [u8; 64])`: sends `amount` to `to` if
//!   the key signed exactly that (NEP-413, see `message`) for this chain, vault and number. Anyone
//!   may submit it. A withdrawal whose transfer fails is refunded to the vault by the runtime.
//! - views: `info` (key, next number, fund, withdrawable) and `slot(issuer, bounty, kind)`.
//!
//! Arguments and answers are borsh. The vault has no access key and never deploys code, adds a
//! key, deletes itself or pays anyone except as a signed withdrawal or a fee refund.

#![no_std]

mod sys {
    #[link(wasm_import_module = "env")]
    extern "C" {
        pub fn read_register(register_id: u64, ptr: u64);
        pub fn register_len(register_id: u64) -> u64;
        pub fn current_account_id(register_id: u64);
        pub fn predecessor_account_id(register_id: u64);
        pub fn refund_to_account_id(register_id: u64);
        pub fn input(register_id: u64);
        pub fn chain_id(register_id: u64);
        pub fn storage_usage() -> u64;
        pub fn account_balance(balance_ptr: u64);
        pub fn attached_deposit(balance_ptr: u64);
        pub fn sha256(value_len: u64, value_ptr: u64, register_id: u64);
        pub fn ed25519_verify(
            sig_len: u64,
            sig_ptr: u64,
            msg_len: u64,
            msg_ptr: u64,
            pub_key_len: u64,
            pub_key_ptr: u64,
        ) -> u64;
        pub fn value_return(value_len: u64, value_ptr: u64);
        pub fn panic() -> !;
        pub fn panic_utf8(len: u64, ptr: u64) -> !;
        pub fn log_utf8(len: u64, ptr: u64);
        pub fn promise_batch_create(account_id_len: u64, account_id_ptr: u64) -> u64;
        pub fn promise_batch_action_transfer(promise_index: u64, amount_ptr: u64);
        pub fn storage_write(
            key_len: u64,
            key_ptr: u64,
            value_len: u64,
            value_ptr: u64,
            register_id: u64,
        ) -> u64;
        pub fn storage_read(key_len: u64, key_ptr: u64, register_id: u64) -> u64;
    }
}

const REG: u64 = 0;
/// NEAR's storage price, 10^19 yoctoNEAR per byte.
const BYTE_COST: u128 = 10_000_000_000_000_000_000;
/// NEP-413's prefix tag, 2^31 + 413.
const NEP413_TAG: u32 = 2_147_484_061;
const SLOT_LEN: usize = 25;

#[panic_handler]
fn on_panic(_: &core::panic::PanicInfo) -> ! {
    unsafe { sys::panic() }
}

fn fail(msg: &str) -> ! {
    unsafe { sys::panic_utf8(msg.len() as u64, msg.as_ptr() as u64) }
}

fn require(ok: bool, msg: &str) {
    if !ok {
        fail(msg)
    }
}

/// Copies register 0 into `buf`; returns its length.
fn take(buf: &mut [u8]) -> usize {
    let len = unsafe { sys::register_len(REG) } as usize;
    require(len <= buf.len(), "value too long");
    unsafe { sys::read_register(REG, buf.as_mut_ptr() as u64) };
    len
}

fn balance_of(f: unsafe extern "C" fn(u64)) -> u128 {
    let mut out = [0u8; 16];
    unsafe { f(out.as_mut_ptr() as u64) };
    u128::from_le_bytes(out)
}

fn read(key: &[u8], buf: &mut [u8]) -> Option<usize> {
    if unsafe { sys::storage_read(key.len() as u64, key.as_ptr() as u64, REG) } == 1 {
        Some(take(buf))
    } else {
        None
    }
}

fn write(key: &[u8], value: &[u8]) {
    unsafe {
        sys::storage_write(
            key.len() as u64,
            key.as_ptr() as u64,
            value.len() as u64,
            value.as_ptr() as u64,
            REG,
        );
    }
}

fn read_u128(key: &[u8]) -> u128 {
    let mut b = [0u8; 16];
    require(read(key, &mut b) == Some(16), "vault not initialized");
    u128::from_le_bytes(b)
}

fn read_u64(key: &[u8]) -> u64 {
    let mut b = [0u8; 8];
    require(read(key, &mut b) == Some(8), "vault not initialized");
    u64::from_le_bytes(b)
}

fn transfer(to: &[u8], amount: u128) {
    let bytes = amount.to_le_bytes();
    unsafe {
        let p = sys::promise_batch_create(to.len() as u64, to.as_ptr() as u64);
        sys::promise_batch_action_transfer(p, bytes.as_ptr() as u64);
    }
}

fn log(parts: &[&[u8]]) {
    let mut buf = [0u8; 256];
    let mut w = Writer::new(&mut buf);
    for p in parts {
        w.put(p);
    }
    let len = w.len;
    unsafe { sys::log_utf8(len as u64, buf.as_ptr() as u64) };
}

/// A bounded byte writer, for messages and keys.
struct Writer<'a> {
    buf: &'a mut [u8],
    len: usize,
}

impl<'a> Writer<'a> {
    fn new(buf: &'a mut [u8]) -> Self {
        Writer { buf, len: 0 }
    }

    fn put(&mut self, bytes: &[u8]) {
        let end = self.len + bytes.len();
        require(end <= self.buf.len(), "message too long");
        self.buf[self.len..end].copy_from_slice(bytes);
        self.len = end;
    }

    fn put_dec(&mut self, mut v: u128) {
        let mut digits = [0u8; 39];
        let mut i = digits.len();
        loop {
            i -= 1;
            digits[i] = b'0' + (v % 10) as u8;
            v /= 10;
            if v == 0 {
                break;
            }
        }
        self.put(&digits[i..]);
    }

    /// A borsh string: u32 length, then the bytes.
    fn put_str(&mut self, s: &[u8]) {
        self.put(&(s.len() as u32).to_le_bytes());
        self.put(s);
    }
}

/// Reads the call's input into `buf`.
fn input(buf: &mut [u8]) -> usize {
    unsafe { sys::input(REG) };
    take(buf)
}

/// Key of the issuer's slot `(bounty, kind)`: `s` + issuer + bounty (LE) + kind.
fn slot_key<'a>(buf: &'a mut [u8; 80], issuer: &[u8], bounty: &[u8], kind: u8) -> &'a [u8] {
    let mut w = Writer::new(buf);
    w.put(b"s");
    w.put(issuer);
    w.put(bounty);
    w.put(&[kind]);
    let len = w.len;
    &buf[..len]
}

/// Slot layout: has deposit (u8), attempt (u32), amount (u128), sealed through (u32).
fn read_slot(key: &[u8]) -> [u8; SLOT_LEN] {
    let mut slot = [0u8; SLOT_LEN];
    if let Some(len) = read(key, &mut slot) {
        require(len == SLOT_LEN, "bad slot");
    }
    slot
}

fn le_u32(b: &[u8]) -> u32 {
    let mut a = [0u8; 4];
    a.copy_from_slice(&b[..4]);
    u32::from_le_bytes(a)
}

fn le_u64(b: &[u8]) -> u64 {
    let mut a = [0u8; 8];
    a.copy_from_slice(&b[..8]);
    u64::from_le_bytes(a)
}

fn le_u128(b: &[u8]) -> u128 {
    let mut a = [0u8; 16];
    a.copy_from_slice(&b[..16]);
    u128::from_le_bytes(a)
}

/// Keeps exactly what the vault's storage now needs beyond its fund, out of `fee`, and returns
/// the rest to the receipt's refund account.
fn settle_fee(fee: u128) {
    let need = u128::from(unsafe { sys::storage_usage() }) * BYTE_COST;
    let fund = read_u128(b"f");
    let short = need.saturating_sub(fund);
    require(fee >= short, "attach the storage fee");
    if short > 0 {
        write(b"f", &(fund + short).to_le_bytes());
    }
    let excess = fee - short;
    if excess > 0 {
        let mut who = [0u8; 64];
        unsafe { sys::refund_to_account_id(REG) };
        let len = take(&mut who);
        transfer(&who[..len], excess);
    }
}

fn issuer(buf: &mut [u8; 64]) -> usize {
    unsafe { sys::predecessor_account_id(REG) };
    take(buf)
}

#[no_mangle]
pub extern "C" fn deposit() {
    let mut inp = [0u8; 29];
    require(input(&mut inp) == 29, "bad arguments");
    let (bounty, kind, attempt, amount) = (
        &inp[0..8],
        inp[8],
        le_u32(&inp[9..13]),
        le_u128(&inp[13..29]),
    );
    let attached = balance_of(sys::attached_deposit);
    require(
        attempt > 0 && amount > 0,
        "attach the amount, for attempt 1 or later",
    );
    require(attached >= amount, "attach the amount and the storage fee");
    let mut who = [0u8; 64];
    let who_len = issuer(&mut who);
    let mut kb = [0u8; 80];
    let key = slot_key(&mut kb, &who[..who_len], bounty, kind);
    let mut slot = read_slot(key);
    require(slot[0] == 0, "this settlement already has a deposit");
    require(attempt > le_u32(&slot[21..25]), "this attempt is sealed");
    slot[0] = 1;
    slot[1..5].copy_from_slice(&attempt.to_le_bytes());
    slot[5..21].copy_from_slice(&amount.to_le_bytes());
    write(key, &slot);
    settle_fee(attached - amount);
    log(&[b"vault_deposit issuer=", &who[..who_len]]);
}

#[no_mangle]
pub extern "C" fn seal() {
    let mut inp = [0u8; 13];
    require(input(&mut inp) == 13, "bad arguments");
    let (bounty, kind, attempt) = (&inp[0..8], inp[8], le_u32(&inp[9..13]));
    let mut who = [0u8; 64];
    let who_len = issuer(&mut who);
    let mut kb = [0u8; 80];
    let key = slot_key(&mut kb, &who[..who_len], bounty, kind);
    let mut slot = read_slot(key);
    if slot[0] == 0 && le_u32(&slot[21..25]) < attempt {
        slot[21..25].copy_from_slice(&attempt.to_le_bytes());
        write(key, &slot);
    }
    settle_fee(balance_of(sys::attached_deposit));
    unsafe { sys::value_return(SLOT_LEN as u64, slot.as_ptr() as u64) };
}

/// The NEP-413 message a withdrawal signs. Its payload's recipient is the vault and its nonce is
/// 24 zero bytes followed by `seq` (big-endian).
fn message<'a>(
    buf: &'a mut [u8; 400],
    chain: &[u8],
    vault: &[u8],
    to: &[u8],
    amount: u128,
    seq: u64,
) -> &'a [u8] {
    let mut w = Writer::new(buf);
    w.put(b"proven-vault-withdraw:v1|chain=");
    w.put(chain);
    w.put(b"|vault=");
    w.put(vault);
    w.put(b"|to=");
    w.put(to);
    w.put(b"|amount=");
    w.put_dec(amount);
    w.put(b"|seq=");
    w.put_dec(u128::from(seq));
    let len = w.len;
    &buf[..len]
}

#[no_mangle]
pub extern "C" fn withdraw() {
    let mut inp = [0u8; 160];
    let len = input(&mut inp);
    require(len >= 4, "bad arguments");
    let to_len = le_u32(&inp[0..4]) as usize;
    require(
        to_len <= 64 && len == 4 + to_len + 16 + 8 + 64,
        "bad arguments",
    );
    let to = &inp[4..4 + to_len];
    let amount = le_u128(&inp[4 + to_len..]);
    let seq = le_u64(&inp[20 + to_len..]);
    let sig = &inp[28 + to_len..92 + to_len];
    require(seq == read_u64(b"n"), "wrong withdrawal number");
    let mut key = [0u8; 33];
    require(
        read(b"k", &mut key) == Some(33) && key[0] == 0,
        "vault not initialized",
    );

    let mut chain = [0u8; 64];
    unsafe { sys::chain_id(REG) };
    let chain_len = take(&mut chain);
    let mut me = [0u8; 64];
    unsafe { sys::current_account_id(REG) };
    let me_len = take(&mut me);
    let mut mb = [0u8; 400];
    let msg = message(&mut mb, &chain[..chain_len], &me[..me_len], to, amount, seq);
    let mut payload = [0u8; 600];
    let mut w = Writer::new(&mut payload);
    w.put(&NEP413_TAG.to_le_bytes());
    w.put_str(msg);
    w.put(&[0u8; 24]);
    w.put(&seq.to_be_bytes());
    w.put_str(&me[..me_len]);
    w.put(&[0]);
    let plen = w.len;
    let mut hash = [0u8; 32];
    unsafe { sys::sha256(plen as u64, payload.as_ptr() as u64, REG) };
    take(&mut hash);
    let valid = unsafe {
        sys::ed25519_verify(
            64,
            sig.as_ptr() as u64,
            32,
            hash.as_ptr() as u64,
            32,
            key[1..].as_ptr() as u64,
        )
    };
    require(valid == 1, "bad signature");

    let available = balance_of(sys::account_balance).saturating_sub(read_u128(b"f"));
    require(
        amount > 0 && amount <= available,
        "more than the vault can pay",
    );
    write(b"n", &(seq + 1).to_le_bytes());
    transfer(to, amount);
    log(&[b"vault_withdraw to=", to]);
}

#[no_mangle]
pub extern "C" fn info() {
    let mut out = [0u8; 73];
    require(
        read(b"k", &mut out[..33]) == Some(33),
        "vault not initialized",
    );
    out[33..41].copy_from_slice(&read_u64(b"n").to_le_bytes());
    let fund = read_u128(b"f");
    out[41..57].copy_from_slice(&fund.to_le_bytes());
    let available = balance_of(sys::account_balance).saturating_sub(fund);
    out[57..73].copy_from_slice(&available.to_le_bytes());
    unsafe { sys::value_return(73, out.as_ptr() as u64) };
}

#[no_mangle]
pub extern "C" fn slot() {
    let mut inp = [0u8; 80];
    let len = input(&mut inp);
    require(len >= 4, "bad arguments");
    let who_len = le_u32(&inp[0..4]) as usize;
    require(who_len <= 64 && len == 4 + who_len + 9, "bad arguments");
    let mut kb = [0u8; 80];
    let key = slot_key(
        &mut kb,
        &inp[4..4 + who_len],
        &inp[4 + who_len..12 + who_len],
        inp[12 + who_len],
    );
    let s = read_slot(key);
    unsafe { sys::value_return(SLOT_LEN as u64, s.as_ptr() as u64) };
}
