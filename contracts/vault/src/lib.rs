//! Proven's NEP-616 settlement vault.
//!
//! Address: derived from this code (a global contract, by hash) and three initial entries:
//! `k` the withdrawal ed25519 public key (curve byte 0, then 32 bytes), `n` the next withdrawal
//! number (u64 LE, 0) and `f` the storage fund (u128 LE, 0). The key, not any account name, is
//! the recipient: a signature by it, and nothing else, moves the money. There is no second key,
//! no automatic forward to a wallet and no sweep: a lost key cannot be replaced.
//!
//! Money in the vault is the recipient's, except the storage fund `f`, which always equals the
//! vault's storage in bytes times 10^19 yoctoNEAR once anything is written. Every write that grows
//! the vault brings that growth's cost in its attached fee; the vault keeps exactly the shortfall
//! and sends the rest back to the receipt's refund account.
//!
//! - `deposit(bounty u64, kind u8, attempt u32, amount u128)` (borsh), payable `amount` + fee:
//!   records the issuer's (predecessor's) settlement once, for an attempt that is not sealed.
//! - `seal(bounty u64, kind u8, attempt u32)` (borsh), payable fee: with no deposit, seals every
//!   attempt up to `attempt`, so a later deposit for them fails; returns the 25-byte record.
//! - `withdraw({"to","amount","n","deadline","signature"})` (JSON): sends `amount` to `to` if the
//!   key signed exactly that (NEP-413, `logic::withdraw_message`) for this chain, vault, number
//!   and a deadline at most 15 minutes ahead. Anyone may submit it.
//! - views: `info` (73 bytes) and `slot(issuer, bounty, kind)` (borsh in, 25 bytes out).
//!
//! The vault has no access key and never deploys code, adds a key, deletes itself or pays anyone
//! except an accepted withdrawal or a fee refund.

#![cfg_attr(target_arch = "wasm32", no_std)]

pub mod logic;

#[cfg(target_arch = "wasm32")]
mod contract {
    use crate::logic::{self, Record, Writer};

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
            pub fn block_timestamp() -> u64;
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

    #[panic_handler]
    fn on_panic(_: &core::panic::PanicInfo) -> ! {
        unsafe { sys::panic() }
    }

    fn fail(msg: &str) -> ! {
        unsafe { sys::panic_utf8(msg.len() as u64, msg.as_ptr() as u64) }
    }

    fn ok<T>(r: Result<T, &'static str>) -> T {
        r.unwrap_or_else(|e| fail(e))
    }

    fn require(cond: bool, msg: &str) {
        if !cond {
            fail(msg)
        }
    }

    /// Copies register 0 into `buf`; returns its length.
    fn take(buf: &mut [u8]) -> usize {
        let len = unsafe { sys::register_len(REG) } as usize;
        require(len <= buf.len(), logic::E_ARGS);
        unsafe { sys::read_register(REG, buf.as_mut_ptr() as u64) };
        len
    }

    /// `b[..len]`, failing without panic formatting.
    fn head(b: &[u8], len: usize) -> &[u8] {
        ok(logic::sub(b, 0, len))
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
        require(read(key, &mut b) == Some(16), logic::E_INIT);
        u128::from_le_bytes(b)
    }

    fn read_u64(key: &[u8]) -> u64 {
        let mut b = [0u8; 8];
        require(read(key, &mut b) == Some(8), logic::E_INIT);
        u64::from_le_bytes(b)
    }

    fn read_key(key: &[u8]) -> [u8; 33] {
        let mut b = [0u8; 33];
        require(read(key, &mut b) == Some(33), logic::E_INIT);
        ok(logic::ed25519_key(&b));
        b
    }

    fn transfer(to: &[u8], amount: u128) {
        let bytes = amount.to_le_bytes();
        unsafe {
            let p = sys::promise_batch_create(to.len() as u64, to.as_ptr() as u64);
            sys::promise_batch_action_transfer(p, bytes.as_ptr() as u64);
        }
    }

    fn log(parts: &[&[u8]]) {
        let mut buf = [0u8; 300];
        let mut w = Writer::new(&mut buf);
        for p in parts {
            if w.put(p).is_err() {
                break;
            }
        }
        let len = w.len();
        unsafe { sys::log_utf8(len as u64, buf.as_ptr() as u64) };
    }

    fn input(buf: &mut [u8]) -> usize {
        unsafe { sys::input(REG) };
        take(buf)
    }

    fn account(f: unsafe extern "C" fn(u64), buf: &mut [u8; 64]) -> usize {
        unsafe { f(REG) };
        take(buf)
    }

    /// Key of the issuer's record `(bounty, kind)`: `s` + issuer + bounty (LE) + kind.
    fn slot_key<'a>(buf: &'a mut [u8; 80], issuer: &[u8], bounty: u64, kind: u8) -> &'a [u8] {
        let mut w = Writer::new(buf);
        ok(w.put(b"s"));
        ok(w.put(issuer));
        ok(w.put(&bounty.to_le_bytes()));
        ok(w.put(&[kind]));
        let len = w.len();
        head(buf, len)
    }

    fn read_record(key: &[u8]) -> Record {
        let mut b = [0u8; logic::RECORD_LEN];
        match read(key, &mut b) {
            Some(_) => ok(Record::decode(&b)),
            None => Record::default(),
        }
    }

    /// Keeps exactly what the vault's storage now needs beyond its fund, out of `fee`, and
    /// returns the rest to the receipt's refund account.
    fn settle_fee(fee: u128) {
        let fund = read_u128(b"f");
        let short = logic::shortfall(unsafe { sys::storage_usage() }, fund);
        require(fee >= short, logic::E_FEE);
        if short > 0 {
            // fund + short equals the storage cost, which cannot overflow (see shortfall).
            write(b"f", &fund.wrapping_add(short).to_le_bytes());
        }
        let excess = fee.wrapping_sub(short); // fee >= short, checked above
        if excess > 0 {
            let mut who = [0u8; 64];
            let len = account(sys::refund_to_account_id, &mut who);
            transfer(head(&who, len), excess);
        }
    }

    #[no_mangle]
    pub extern "C" fn deposit() {
        let mut inp = [0u8; 29];
        let len = input(&mut inp);
        let (bounty, kind, attempt, amount) = ok(logic::decode_deposit(head(&inp, len)));
        let attached = balance_of(sys::attached_deposit);
        require(attached >= amount, logic::E_DEPOSIT_AMOUNT);
        let mut who = [0u8; 64];
        let who_len = account(sys::predecessor_account_id, &mut who);
        let mut kb = [0u8; 80];
        let key = slot_key(&mut kb, head(&who, who_len), bounty, kind);
        let record = ok(read_record(key).deposit(attempt, amount));
        write(key, &record.encode());
        settle_fee(attached.wrapping_sub(amount)); // attached >= amount, checked above
        log(&[b"vault_deposit issuer=", head(&who, who_len)]);
    }

    #[no_mangle]
    pub extern "C" fn seal() {
        let mut inp = [0u8; 13];
        let len = input(&mut inp);
        let (bounty, kind, attempt) = ok(logic::decode_seal(head(&inp, len)));
        let mut who = [0u8; 64];
        let who_len = account(sys::predecessor_account_id, &mut who);
        let mut kb = [0u8; 80];
        let key = slot_key(&mut kb, head(&who, who_len), bounty, kind);
        let before = read_record(key);
        let after = before.seal(attempt);
        if after != before {
            write(key, &after.encode());
        }
        settle_fee(balance_of(sys::attached_deposit));
        let out = after.encode();
        unsafe { sys::value_return(out.len() as u64, out.as_ptr() as u64) };
    }

    fn verifies(signature: &[u8; 64], hash: &[u8; 32], key: &[u8; 32]) -> bool {
        unsafe {
            sys::ed25519_verify(
                64,
                signature.as_ptr() as u64,
                32,
                hash.as_ptr() as u64,
                32,
                key.as_ptr() as u64,
            ) == 1
        }
    }

    #[no_mangle]
    pub extern "C" fn withdraw() {
        let mut inp = [0u8; 512];
        let len = input(&mut inp);
        let w = ok(logic::parse_withdraw(head(&inp, len)));
        let mut me = [0u8; 64];
        let me_len = account(sys::current_account_id, &mut me);
        let vault = head(&me, me_len);
        require(
            logic::is_account_id(w.to) && w.to != vault,
            logic::E_DESTINATION,
        );
        let key = read_key(b"k");
        require(w.n == read_u64(b"n"), logic::E_NUMBER);
        ok(logic::check_deadline(
            unsafe { sys::block_timestamp() },
            w.deadline,
        ));

        let mut chain = [0u8; 64];
        unsafe { sys::chain_id(REG) };
        let chain_len = take(&mut chain);
        let mut mb = [0u8; logic::MAX_MESSAGE];
        let msg = ok(logic::withdraw_message(
            &mut mb,
            head(&chain, chain_len),
            vault,
            w.to,
            w.amount,
            w.n,
            w.deadline,
        ));
        let mut pb = [0u8; logic::MAX_PAYLOAD];
        let payload = ok(logic::nep413_payload(
            &mut pb,
            msg,
            &logic::withdraw_nonce(w.n),
            vault,
        ));
        let mut hash = [0u8; 32];
        unsafe { sys::sha256(payload.len() as u64, payload.as_ptr() as u64, REG) };
        take(&mut hash);
        if !verifies(&w.signature, &hash, &ok(logic::ed25519_key(&key))) {
            fail(logic::E_SIGNATURE);
        }

        let available = balance_of(sys::account_balance).saturating_sub(read_u128(b"f"));
        require(w.amount > 0 && w.amount <= available, logic::E_BALANCE);
        let next = w.n.checked_add(1).unwrap_or_else(|| fail(logic::E_NUMBER));
        write(b"n", &next.to_le_bytes());
        transfer(w.to, w.amount);
        let mut nb = [0u8; 39];
        let mut nw = Writer::new(&mut nb);
        ok(nw.put_dec(u128::from(w.n)));
        let n_len = nw.len();
        log(&[
            b"vault_withdraw key=withdrawal",
            b" n=",
            head(&nb, n_len),
            b" to=",
            w.to,
        ]);
    }

    #[no_mangle]
    pub extern "C" fn info() {
        let key = read_key(b"k");
        let fund = read_u128(b"f");
        let available = balance_of(sys::account_balance).saturating_sub(fund);
        let out = logic::encode_info(&key, read_u64(b"n"), fund, available);
        unsafe { sys::value_return(out.len() as u64, out.as_ptr() as u64) };
    }

    #[no_mangle]
    pub extern "C" fn slot() {
        let mut inp = [0u8; 80];
        let len = input(&mut inp);
        require(len >= 4, logic::E_ARGS);
        let who_len = u32::from_le_bytes([inp[0], inp[1], inp[2], inp[3]]) as usize;
        require(
            who_len <= 64 && len == who_len.wrapping_add(13),
            logic::E_ARGS,
        );
        let issuer = ok(logic::sub(&inp, 4, 4 + who_len));
        let bounty = logic::le_u64(ok(logic::sub(&inp, 4 + who_len, 12 + who_len)));
        let kind = *ok(logic::sub(&inp, 12 + who_len, 13 + who_len))
            .first()
            .unwrap_or(&0);
        let mut kb = [0u8; 80];
        let key = slot_key(&mut kb, issuer, bounty, kind);
        let out = read_record(key).encode();
        unsafe { sys::value_return(out.len() as u64, out.as_ptr() as u64) };
    }
}
