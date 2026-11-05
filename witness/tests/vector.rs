//! Cross-language test: the Rust witness must hash, sign and serialise the
//! statement exactly like the TypeScript side (packages/evidence, viem).

use alloy_primitives::{hex, B256};
use alloy_signer_local::PrivateKeySigner;
use recall_witness::attest::{
    attestation, eip712_digest, sign, signer_from_env, statement_json, CaptureStatement,
};
use serde_json::Value;

fn vector() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../packages/evidence/test/vectors/statement-v1.json"
    );
    let raw = std::fs::read_to_string(path).expect("read statement-v1.json");
    serde_json::from_str(&raw).expect("parse statement-v1.json")
}

fn str_field<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str()
        .unwrap_or_else(|| panic!("{k} must be a string"))
}

fn statement(v: &Value) -> CaptureStatement {
    let s = &v["statement"];
    let b32 = |k: &str| str_field(s, k).parse::<B256>().expect(k);
    CaptureStatement {
        serverName: str_field(s, "serverName").to_string(),
        connTime: str_field(s, "connTime").parse().unwrap(),
        signedAt: str_field(s, "signedAt").parse().unwrap(),
        sentSha256: b32("sentSha256"),
        recvSha256: b32("recvSha256"),
        sentLen: s["sentLen"].as_u64().unwrap() as u32,
        recvLen: s["recvLen"].as_u64().unwrap() as u32,
        tlsVersion: s["tlsVersion"].as_u64().unwrap() as u8,
        nonce: b32("nonce"),
    }
}

fn key(v: &Value) -> PrivateKeySigner {
    str_field(v, "privateKey").parse().unwrap()
}

#[test]
fn digest_matches_ts_vector() {
    let v = vector();
    let digest = eip712_digest(&statement(&v));
    assert_eq!(hex::encode_prefixed(digest), str_field(&v, "digest"));
}

#[test]
fn signature_matches_ts_vector() {
    let v = vector();
    let sig = sign(&statement(&v), &key(&v));
    assert_eq!(
        hex::encode_prefixed(sig.as_bytes()),
        str_field(&v, "signature")
    );
    let v_byte = sig.as_bytes()[64];
    assert!(
        v_byte == 27 || v_byte == 28,
        "v must be 27/28, got {v_byte}"
    );
}

#[test]
fn signer_address_matches_ts_vector() {
    let v = vector();
    assert_eq!(key(&v).address().to_checksum(None), str_field(&v, "signer"));
}

#[test]
fn message_json_matches_ts_vector() {
    let v = vector();
    let json = serde_json::to_value(statement_json(&statement(&v))).unwrap();
    assert_eq!(json, v["statement"]);
}

#[test]
fn message_json_key_order_matches_ts() {
    let v = vector();
    let text = serde_json::to_string(&statement_json(&statement(&v))).unwrap();
    let keys = [
        "serverName",
        "connTime",
        "signedAt",
        "sentSha256",
        "recvSha256",
        "sentLen",
        "recvLen",
        "tlsVersion",
        "nonce",
    ];
    let mut last = 0;
    for k in keys {
        let at = text
            .find(&format!("\"{k}\":"))
            .unwrap_or_else(|| panic!("missing {k}"));
        assert!(at >= last, "{k} out of order in {text}");
        last = at;
    }
}

#[test]
fn attestation_carries_message_signature_and_signer() {
    let v = vector();
    let s = statement(&v);
    let k = key(&v);
    let att = serde_json::to_value(attestation(&s, &k)).unwrap();
    assert_eq!(att["message"], v["statement"]);
    assert_eq!(att["signature"], v["signature"]);
    assert_eq!(att["signer"], v["signer"]);
}

#[test]
fn env_key_accepted_with_or_without_0x() {
    let v = vector();
    let with = str_field(&v, "privateKey");
    let without = with.trim_start_matches("0x");
    let a = signer_from_env(with).unwrap().address();
    let b = signer_from_env(without).unwrap().address();
    assert_eq!(a, b);
    assert_eq!(a.to_checksum(None), str_field(&v, "signer"));
}

#[test]
fn env_key_error_never_echoes_the_key() {
    let bad = "0xzz59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b7869";
    let err = signer_from_env(bad).unwrap_err();
    assert!(!err.contains("59c6995e"), "error leaks key material: {err}");
    let err = signer_from_env("").unwrap_err();
    assert!(err.contains("WITNESS_PRIVATE_KEY"));
}
