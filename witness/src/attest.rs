//! EIP-712 statement the witness signs (contract shared with
//! packages/evidence/src/statement.ts).

use std::str::FromStr;

use alloy_primitives::{hex, Signature, B256};
use alloy_signer::SignerSync;
use alloy_signer_local::PrivateKeySigner;
use alloy_sol_types::{eip712_domain, Eip712Domain, SolStruct};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tlsn::connection::TlsVersion;

alloy_sol_types::sol! {
    /// EIP-712 `Capture` struct.
    #[derive(Debug, PartialEq, Eq)]
    struct Capture {
        string serverName;
        uint64 connTime;
        uint64 signedAt;
        bytes32 sentSha256;
        bytes32 recvSha256;
        uint32 sentLen;
        uint32 recvLen;
        uint8 tlsVersion;
        bytes32 nonce;
    }
}

pub type CaptureStatement = Capture;

/// `attestation.message`: the statement as JSON, exactly like the TypeScript
/// `statementToJson` (uint64 as decimal strings, bytes32 as lowercase 0x hex).
/// Field order matches the TypeScript side.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatementJson {
    pub server_name: String,
    pub conn_time: String,
    pub signed_at: String,
    pub sent_sha256: String,
    pub recv_sha256: String,
    pub sent_len: u32,
    pub recv_len: u32,
    pub tls_version: u8,
    pub nonce: String,
}

/// `session_completed.attestation`: the statement, its 65-byte r||s||v
/// signature (v = 27/28) as 0x hex, and the EIP-55 signer address.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Attestation {
    pub message: StatementJson,
    pub signature: String,
    pub signer: String,
}

/// EIP-712 domain: name and version only (no chainId, no verifyingContract).
pub const DOMAIN: Eip712Domain = eip712_domain! {
    name: "Recall Witness",
    version: "1",
};

/// `keccak256(0x1901 || domainSeparator || hashStruct(Capture))`.
pub fn eip712_digest(s: &CaptureStatement) -> [u8; 32] {
    s.eip712_signing_hash(&DOMAIN).0
}

/// Deterministic (RFC 6979) secp256k1 signature over the EIP-712 digest.
pub fn sign(s: &CaptureStatement, key: &PrivateKeySigner) -> Signature {
    key.sign_hash_sync(&B256::from(eip712_digest(s)))
        .expect("secp256k1 signing of a 32-byte digest cannot fail")
}

pub fn statement_json(s: &CaptureStatement) -> StatementJson {
    StatementJson {
        server_name: s.serverName.clone(),
        conn_time: s.connTime.to_string(),
        signed_at: s.signedAt.to_string(),
        sent_sha256: hex::encode_prefixed(s.sentSha256),
        recv_sha256: hex::encode_prefixed(s.recvSha256),
        sent_len: s.sentLen,
        recv_len: s.recvLen,
        tls_version: s.tlsVersion,
        nonce: hex::encode_prefixed(s.nonce),
    }
}

pub fn attestation(s: &CaptureStatement, key: &PrivateKeySigner) -> Attestation {
    Attestation {
        message: statement_json(s),
        signature: hex::encode_prefixed(sign(s, key).as_bytes()),
        signer: key.address().to_checksum(None),
    }
}

/// Parses `WITNESS_PRIVATE_KEY` (32-byte hex, with or without `0x`). Errors
/// never include the input, so the key cannot end up in logs.
pub fn signer_from_env(raw: &str) -> Result<PrivateKeySigner, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("WITNESS_PRIVATE_KEY is required".to_string());
    }
    let digits = raw
        .strip_prefix("0x")
        .or_else(|| raw.strip_prefix("0X"))
        .unwrap_or(raw);
    let invalid = || "WITNESS_PRIVATE_KEY must be 32 bytes of hex (with or without 0x)".to_string();
    if digits.len() != 64 || !digits.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(invalid());
    }
    let bytes = B256::from_str(digits).map_err(|_| invalid())?;
    PrivateKeySigner::from_bytes(&bytes).map_err(|_| invalid())
}

/// Statement `tlsVersion`: 12 for TLS 1.2, 13 for TLS 1.3.
pub fn tls_version_code(v: TlsVersion) -> u8 {
    match v {
        TlsVersion::V1_2 => 12,
        TlsVersion::V1_3 => 13,
    }
}

/// Builds the statement from a fully revealed transcript. `conn_time` and
/// `signed_at` are Unix seconds.
pub fn build_statement(
    server_name: &str,
    conn_time: u64,
    signed_at: u64,
    sent: &[u8],
    recv: &[u8],
    tls_version: u8,
    nonce: [u8; 32],
) -> Result<CaptureStatement, String> {
    let len = |b: &[u8]| u32::try_from(b.len()).map_err(|_| "transcript too large".to_string());
    Ok(CaptureStatement {
        serverName: server_name.to_string(),
        connTime: conn_time,
        signedAt: signed_at,
        sentSha256: B256::from(<[u8; 32]>::from(Sha256::digest(sent))),
        recvSha256: B256::from(<[u8; 32]>::from(Sha256::digest(recv))),
        sentLen: len(sent)?,
        recvLen: len(recv)?,
        tlsVersion: tls_version,
        nonce: B256::from(nonce),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHA256_ABC: &str = "0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    const SHA256_EMPTY: &str = "0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

    #[test]
    fn tls_version_codes() {
        assert_eq!(tls_version_code(TlsVersion::V1_2), 12);
        assert_eq!(tls_version_code(TlsVersion::V1_3), 13);
    }

    #[test]
    fn build_statement_hashes_and_measures_transcripts() {
        let s = build_statement(
            "notice.recall.test",
            1_793_000_000,
            1_793_000_042,
            b"abc",
            b"",
            12,
            [7u8; 32],
        )
        .unwrap();
        assert_eq!(s.serverName, "notice.recall.test");
        assert_eq!(s.connTime, 1_793_000_000);
        assert_eq!(s.signedAt, 1_793_000_042);
        assert_eq!(s.sentSha256, SHA256_ABC.parse::<B256>().unwrap());
        assert_eq!(s.recvSha256, SHA256_EMPTY.parse::<B256>().unwrap());
        assert_eq!((s.sentLen, s.recvLen), (3, 0));
        assert_eq!(s.tlsVersion, 12);
        assert_eq!(s.nonce, B256::from([7u8; 32]));
    }

    #[test]
    fn statement_json_uses_decimal_strings_and_lowercase_hex() {
        let s = build_statement("notice.recall.test", 1, 2, b"abc", b"", 12, [0xAB; 32]).unwrap();
        let j = statement_json(&s);
        assert_eq!(j.conn_time, "1");
        assert_eq!(j.signed_at, "2");
        assert_eq!(j.sent_sha256, SHA256_ABC);
        assert_eq!(j.nonce, format!("0x{}", "ab".repeat(32)));
        assert_eq!(j.sent_sha256, j.sent_sha256.to_lowercase());
    }

    #[test]
    fn signature_recovers_to_signer() {
        let key = PrivateKeySigner::random();
        let s = build_statement("notice.recall.test", 1, 2, b"abc", b"xyz", 12, [1; 32]).unwrap();
        let sig = sign(&s, &key);
        let recovered = sig
            .recover_address_from_prehash(&B256::from(eip712_digest(&s)))
            .unwrap();
        assert_eq!(recovered, key.address());
        let att = attestation(&s, &key);
        assert_eq!(att.signer, key.address().to_checksum(None));
        assert_eq!(att.signature, hex::encode_prefixed(sig.as_bytes()));
    }
}
