//! Host tests of the vault's pure logic: JSON withdrawal arguments, the deadline rule, account id
//! rules, settlement records, decimal printing and the NEP-413 payload. Seeded random loops stand
//! in for property tests (no proptest crate is available offline).

use ed25519_dalek::{Signer, SigningKey, Verifier};
use proven_vault::logic::*;
use rand_chacha::rand_core::{RngCore, SeedableRng};
use rand_chacha::ChaCha20Rng;
use sha2::{Digest, Sha256};

const SIG: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

fn json(to: &str, amount: &str, n: &str, deadline: &str, sig: &str) -> String {
    format!(
        r#"{{"to":"{to}","amount":"{amount}","n":"{n}","deadline":"{deadline}","signature":"{sig}"}}"#
    )
}

#[test]
fn json_withdrawal_arguments_decode_in_any_order_with_whitespace() {
    let a = json(
        "payee.testnet",
        "10000000000000000000000",
        "0",
        "1794300000",
        SIG,
    );
    let w = parse_withdraw(a.as_bytes()).unwrap();
    assert_eq!(w.to, b"payee.testnet");
    assert_eq!(w.amount, 10_000_000_000_000_000_000_000);
    assert_eq!((w.n, w.deadline), (0, 1_794_300_000));
    assert_eq!(w.signature[0..2], [0x00, 0x11]);
    let reordered = format!(
        " {{ \"signature\" : \"{SIG}\",\n\t\"deadline\":\"7\" , \"n\":\"340282366920938463463374607431768211455\"}}"
    );
    assert!(
        parse_withdraw(reordered.as_bytes()).is_err(),
        "n above u64 and members missing"
    );
    let reordered = format!(
        " {{ \"signature\" : \"{SIG}\",\n\t\"deadline\":\"7\" , \"n\":\"18446744073709551615\",\"amount\":\"340282366920938463463374607431768211455\",\r\"to\":\"ab\" }} "
    );
    let w = parse_withdraw(reordered.as_bytes()).unwrap();
    assert_eq!(
        (w.n, w.amount, w.deadline, w.to),
        (u64::MAX, u128::MAX, 7, &b"ab"[..])
    );
}

#[test]
fn malformed_json_withdrawal_arguments_are_refused() {
    let good = json("payee.testnet", "1", "0", "9", SIG);
    assert!(parse_withdraw(good.as_bytes()).is_ok());
    let bad = [
        String::new(),
        "{}".into(),
        "[]".into(),
        json("payee.testnet", "01", "0", "9", SIG),
        json("payee.testnet", "-1", "0", "9", SIG),
        json("payee.testnet", "1.0", "0", "9", SIG),
        json("payee.testnet", "", "0", "9", SIG),
        json(
            "payee.testnet",
            "340282366920938463463374607431768211456",
            "0",
            "9",
            SIG,
        ),
        json("payee.testnet", "1", "18446744073709551616", "9", SIG),
        json("payee.testnet", "1", "0", "18446744073709551616", SIG),
        json("pay\\u0065e.testnet", "1", "0", "9", SIG),
        json("payee.testnet", "1", "0", "9", &SIG.to_uppercase()),
        json("payee.testnet", "1", "0", "9", &SIG[..126]),
        json("payee.testnet", "1", "0", "9", &format!("{SIG}00")),
        good.replace(r#""n":"0""#, r#""n":0"#),
        good.replace(r#","signature""#, r#","n":"0","signature""#),
        good.replace(r#""to""#, r#""destination""#),
        good.replace(r#","signature":"#, r#","extra":"x","signature":"#),
        good.replace(r#","deadline":"9""#, ""),
        format!("{good} x"),
        format!("{good},"),
        good.replace('}', ""),
        good.replace(r#""to":"payee.testnet""#, "\"to\":\"pay\nee\""),
    ];
    for b in bad {
        assert_eq!(parse_withdraw(b.as_bytes()), Err(E_ARGS), "{b}");
    }
}

#[test]
fn the_deadline_is_refused_at_or_after_it_and_more_than_15_minutes_ahead() {
    let now = 1_794_300_000_000_000_000u64;
    let s = now / 1_000_000_000;
    assert_eq!(check_deadline(now, s), Err(E_PASSED), "at the deadline");
    assert_eq!(check_deadline(now + 1, s), Err(E_PASSED), "after it");
    assert_eq!(check_deadline(now - 1, s), Ok(()), "1 ns before it");
    assert_eq!(check_deadline(now, s + 900), Ok(()), "exactly 900 s ahead");
    assert_eq!(
        check_deadline(now - 1, s + 900),
        Err(E_TOO_FAR),
        "900 s + 1 ns ahead"
    );
    assert_eq!(check_deadline(now, u64::MAX), Err(E_TOO_FAR), "overflow");
}

#[test]
fn account_ids_follow_near_rules() {
    for ok in [
        "ab",
        "a-b",
        "a_b.c",
        "payee.testnet",
        "0s1234",
        &"a".repeat(64),
    ] {
        assert!(is_account_id(ok.as_bytes()), "{ok}");
    }
    for bad in [
        "",
        "a",
        "-ab",
        "ab-",
        "a..b",
        "a-.b",
        "A.testnet",
        "a b",
        "ab!",
        &"a".repeat(65),
    ] {
        assert!(!is_account_id(bad.as_bytes()), "{bad}");
    }
}

#[test]
fn records_accept_one_deposit_and_seals_only_rise() {
    let r = Record::default();
    assert_eq!(r.deposit(0, 1), Err(E_DEPOSIT_AMOUNT));
    assert_eq!(r.deposit(1, 0), Err(E_DEPOSIT_AMOUNT));
    let sealed = r.seal(2);
    assert_eq!(sealed.sealed_through, 2);
    assert_eq!(sealed.seal(1).sealed_through, 2, "never lowered");
    assert_eq!(sealed.deposit(2, 5), Err(E_SEALED));
    let d = sealed.deposit(3, 5).unwrap();
    assert_eq!(
        (d.deposited, d.attempt, d.amount, d.sealed_through),
        (true, 3, 5, 2)
    );
    assert_eq!(d.deposit(4, 5), Err(E_HAS_DEPOSIT));
    assert_eq!(d.seal(9), d, "a deposited record is never sealed");
    let mut rng = ChaCha20Rng::seed_from_u64(1);
    for _ in 0..500 {
        let rec = Record {
            deposited: rng.next_u32() % 2 == 0,
            attempt: rng.next_u32(),
            amount: (u128::from(rng.next_u64()) << 64) | u128::from(rng.next_u64()),
            sealed_through: rng.next_u32(),
        };
        assert_eq!(Record::decode(&rec.encode()).unwrap(), rec, "round trip");
    }
    assert!(Record::decode(&[2u8; RECORD_LEN]).is_err());
    assert!(Record::decode(&[0u8; 24]).is_err());
}

#[test]
fn decimal_printing_and_division_match_native() {
    let mut rng = ChaCha20Rng::seed_from_u64(2);
    let mut cases = vec![
        0u128,
        9,
        10,
        99,
        u128::MAX,
        u128::from(u64::MAX),
        10u128.pow(38),
    ];
    for _ in 0..1000 {
        cases.push((u128::from(rng.next_u64()) << 64) | u128::from(rng.next_u64()));
        cases.push(u128::from(rng.next_u64()));
    }
    for v in cases {
        assert_eq!(div10(v), (v / 10, (v % 10) as u8));
        let mut buf = [0u8; 40];
        let mut w = Writer::new(&mut buf);
        w.put_dec(v).unwrap();
        let len = w.len();
        assert_eq!(&buf[..len], v.to_string().as_bytes());
        assert_eq!(decimal(v.to_string().as_bytes(), u128::MAX), Ok(v));
    }
}

#[test]
fn the_withdrawal_payload_is_nep413_and_verifies_with_either_key() {
    let primary = SigningKey::from_bytes(&[1; 32]);
    let backup = SigningKey::from_bytes(&[2; 32]);
    let vault = b"0sabcdef0123456789abcdef0123456789abcdef01";
    let mut mb = [0u8; MAX_MESSAGE];
    let msg = withdraw_message(
        &mut mb,
        b"testnet",
        vault,
        b"payee.testnet",
        5,
        3,
        1_794_300_000,
    )
    .unwrap()
    .to_vec();
    assert_eq!(
        String::from_utf8(msg.clone()).unwrap(),
        format!(
            "proven-vault-withdraw:v2|chain=testnet|vault={}|to=payee.testnet|amount=5|n=3|deadline=1794300000",
            std::str::from_utf8(vault).unwrap()
        )
    );
    let nonce = withdraw_nonce(3);
    assert_eq!(nonce[31], 3);
    assert!(nonce[..24].iter().all(|b| *b == 0));
    let mut pb = [0u8; MAX_PAYLOAD];
    let payload = nep413_payload(&mut pb, &msg, &nonce, vault)
        .unwrap()
        .to_vec();
    // Independent NEP-413 encoding.
    let mut expect = 2_147_484_061u32.to_le_bytes().to_vec();
    expect.extend((msg.len() as u32).to_le_bytes());
    expect.extend(&msg);
    expect.extend(nonce);
    expect.extend((vault.len() as u32).to_le_bytes());
    expect.extend(vault);
    expect.push(0);
    assert_eq!(payload, expect);
    let hash: [u8; 32] = Sha256::digest(&payload).into();
    for key in [&primary, &backup] {
        let sig = key.sign(&hash);
        assert!(key.verifying_key().verify(&hash, &sig).is_ok());
    }
}

#[test]
fn info_and_keys_encode_at_fixed_offsets() {
    let mut p = [0u8; 33];
    p[1..].copy_from_slice(&[7; 32]);
    let mut b = [0u8; 33];
    b[1..].copy_from_slice(&[8; 32]);
    let out = encode_info(&p, &b, 4, 5, 6);
    assert_eq!(out.len(), INFO_LEN);
    assert_eq!(&out[0..33], &p);
    assert_eq!(&out[33..66], &b);
    assert_eq!(le_u64(&out[66..74]), 4);
    assert_eq!(le_u128(&out[74..90]), 5);
    assert_eq!(le_u128(&out[90..106]), 6);
    assert_eq!(ed25519_key(&p), Ok([7; 32]));
    let mut not_ed = p;
    not_ed[0] = 1;
    assert_eq!(ed25519_key(&not_ed), Err(E_INIT));
    assert_eq!(shortfall(100, 0), 100 * BYTE_COST);
    assert_eq!(shortfall(100, 100 * BYTE_COST + 1), 0);
    assert_eq!(decode_deposit(&[0u8; 28]), Err(E_ARGS));
    assert_eq!(decode_seal(&[0u8; 13]), Ok((0, 0, 0)));
}
