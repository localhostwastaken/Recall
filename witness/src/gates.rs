//! Recall gates: what a session must satisfy before the witness signs.
//!
//! Every rejection message starts with `recall: ` and is sent verbatim to the
//! extension as `{"type":"error","message":…}`.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

use tlsn::{config::prove::ProveRequest, transcript::PartialTranscript};

pub const PROXY_MODE: &str = "recall: proxy mode not allowed";
pub const SERVER_IDENTITY: &str = "recall: server identity required";
pub const COMMITMENTS: &str = "recall: commitments not allowed";
pub const PARTIAL_REVEAL: &str = "recall: partial reveal not allowed";
pub const HOST_MISMATCH: &str = "recall: host mismatch";
pub const COOKIES_AUTH: &str = "recall: cookies/auth not allowed";
pub const PROXY_PORT: &str = "recall: proxy port must be 443";
pub const PROXY_TARGET: &str = "recall: proxy target not allowed";
pub const PROXY_SESSION: &str = "recall: proxy requires an active session";
pub const MALFORMED_REQUEST: &str = "recall: malformed request";
pub const NONCE: &str = "recall: nonce missing or malformed";

/// Server-side caps on the transcript sizes a client may register.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    pub max_sent: usize,
    pub max_recv: usize,
}

/// Checks the (fully revealed) HTTP request the prover sent:
///
/// - exactly one HTTP/1.x request: the head plus a body of `Content-Length`
///   bytes (no pipelined second request, no `Transfer-Encoding`);
/// - CRLF-only header lines, no obs-fold, no whitespace before the colon;
/// - no `Cookie` or `Authorization` header (case-insensitive);
/// - exactly one `Host` header, equal to `server_name` (ASCII case-insensitive).
pub fn check_request(sent: &[u8], server_name: &str) -> Result<(), String> {
    let malformed = || MALFORMED_REQUEST.to_string();
    let head_end = sent
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or_else(malformed)?;
    let head = std::str::from_utf8(&sent[..head_end]).map_err(|_| malformed())?;
    let body_len = sent.len() - (head_end + 4);

    let mut lines = head.split("\r\n");
    let request_line = lines.next().unwrap_or_default();
    if request_line.is_empty() || request_line.contains(['\r', '\n']) {
        return Err(malformed());
    }

    let mut hosts = Vec::new();
    let mut content_length: Option<usize> = None;
    for line in lines {
        if line.contains(['\r', '\n']) || line.starts_with([' ', '\t']) {
            return Err(malformed());
        }
        let (name, value) = line.split_once(':').ok_or_else(malformed)?;
        if name.is_empty()
            || name
                .bytes()
                .any(|b| b.is_ascii_whitespace() || b.is_ascii_control())
        {
            return Err(malformed());
        }
        let value = value.trim_matches([' ', '\t']);
        if name.eq_ignore_ascii_case("cookie") || name.eq_ignore_ascii_case("authorization") {
            return Err(COOKIES_AUTH.to_string());
        } else if name.eq_ignore_ascii_case("host") {
            hosts.push(value);
        } else if name.eq_ignore_ascii_case("transfer-encoding") {
            return Err(malformed());
        } else if name.eq_ignore_ascii_case("content-length") {
            if content_length.is_some()
                || value.is_empty()
                || !value.bytes().all(|b| b.is_ascii_digit())
            {
                return Err(malformed());
            }
            content_length = Some(value.parse().map_err(|_| malformed())?);
        }
    }

    if body_len != content_length.unwrap_or(0) {
        return Err(malformed());
    }
    match hosts.as_slice() {
        [host] if host.eq_ignore_ascii_case(server_name) => Ok(()),
        _ => Err(HOST_MISMATCH.to_string()),
    }
}

/// Parses the `/proxy?token=<host>[:<port>]` target. The port defaults to 443;
/// any other port (or an unparseable one) is rejected.
pub fn check_proxy_target(token: &str) -> Result<(String, u16), String> {
    let (host, port) = match token.split_once(':') {
        None => (token, 443),
        Some((host, port)) => {
            if port.contains(':') {
                return Err(PROXY_TARGET.to_string());
            }
            match port.parse::<u16>() {
                Ok(443) => (host, 443),
                _ => return Err(PROXY_PORT.to_string()),
            }
        }
    };
    if host.is_empty() {
        return Err(PROXY_TARGET.to_string());
    }
    Ok((host.to_string(), port))
}

/// Gates on the prover's request, checked before `accept()`: server identity
/// must be proven, no transcript commitments, and data must be revealed.
pub fn check_prove_request(req: &ProveRequest) -> Result<(), String> {
    if !req.server_identity() {
        return Err(SERVER_IDENTITY.to_string());
    }
    if req.transcript_commit().is_some() {
        return Err(COMMITMENTS.to_string());
    }
    if req.reveal().is_none() {
        return Err(PARTIAL_REVEAL.to_string());
    }
    Ok(())
}

/// After verification: every sent and received byte must be authenticated.
pub fn check_full_reveal(t: &PartialTranscript) -> Result<(), String> {
    if t.sent_unauthed().is_empty() && t.received_unauthed().is_empty() {
        Ok(())
    } else {
        Err(PARTIAL_REVEAL.to_string())
    }
}

/// Parses `sessionData.nonce`: 32 bytes as 64 hex chars, `0x` optional.
pub fn parse_nonce(v: Option<&str>) -> Result<[u8; 32], String> {
    let v = v.ok_or_else(|| NONCE.to_string())?;
    let digits = v
        .strip_prefix("0x")
        .or_else(|| v.strip_prefix("0X"))
        .unwrap_or(v);
    if digits.len() != 64 || !digits.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(NONCE.to_string());
    }
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&digits[2 * i..2 * i + 2], 16).map_err(|_| NONCE.to_string())?;
    }
    Ok(out)
}

/// The client's `maxSentData`/`maxRecvData` may not exceed the server caps.
pub fn check_limits(max_sent: usize, max_recv: usize, limits: Limits) -> Result<(), String> {
    if max_recv > limits.max_recv {
        return Err(format!(
            "recall: maxRecvData too large (limit {})",
            limits.max_recv
        ));
    }
    if max_sent > limits.max_sent {
        return Err(format!(
            "recall: maxSentData too large (limit {})",
            limits.max_sent
        ));
    }
    Ok(())
}

/// `true` only for globally routable unicast addresses. Rejects loopback,
/// private, link-local (incl. cloud metadata 169.254.169.254), CGNAT,
/// unique-local, unspecified, multicast, broadcast, documentation,
/// benchmarking and reserved ranges, and IPv6 forms that embed such an IPv4
/// address (IPv4-mapped, IPv4-compatible, NAT64, 6to4).
pub fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_public_v4(v4),
        IpAddr::V6(v6) => is_public_v6(v6),
    }
}

fn is_public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(a == 0                                   // 0.0.0.0/8 "this network"
        || a == 10                             // 10/8 private
        || a == 127                            // 127/8 loopback
        || (a == 100 && (64..128).contains(&b)) // 100.64/10 CGNAT
        || (a == 169 && b == 254)              // 169.254/16 link-local, metadata
        || (a == 172 && (16..32).contains(&b)) // 172.16/12 private
        || (a == 192 && b == 0 && c == 0)      // 192.0.0/24 IETF protocol
        || (a == 192 && b == 0 && c == 2)      // 192.0.2/24 documentation
        || (a == 192 && b == 168)              // 192.168/16 private
        || (a == 198 && (b == 18 || b == 19))  // 198.18/15 benchmarking
        || (a == 198 && b == 51 && c == 100)   // 198.51.100/24 documentation
        || (a == 203 && b == 0 && c == 113)    // 203.0.113/24 documentation
        || a >= 224) // 224/4 multicast, 240/4 reserved, 255.255.255.255
}

fn is_public_v6(ip: Ipv6Addr) -> bool {
    let seg = ip.segments();
    let embedded_v4 =
        |hi: u16, lo: u16| Ipv4Addr::new((hi >> 8) as u8, hi as u8, (lo >> 8) as u8, lo as u8);
    if ip.is_unspecified() || ip.is_loopback() {
        return false;
    }
    // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (deprecated compatible)
    if seg[..5] == [0; 5] && (seg[5] == 0xffff || seg[5] == 0) {
        return is_public_v4(embedded_v4(seg[6], seg[7]));
    }
    // 64:ff9b::/96 NAT64 well-known prefix
    if seg[..6] == [0x64, 0xff9b, 0, 0, 0, 0] {
        return is_public_v4(embedded_v4(seg[6], seg[7]));
    }
    // 2002::/16 6to4
    if seg[0] == 0x2002 {
        return is_public_v4(embedded_v4(seg[1], seg[2]));
    }
    !((seg[0] & 0xfe00) == 0xfc00          // fc00::/7 unique local
        || (seg[0] & 0xffc0) == 0xfe80     // fe80::/10 link-local
        || (seg[0] & 0xffc0) == 0xfec0     // fec0::/10 site-local (deprecated)
        || (seg[0] & 0xff00) == 0xff00     // ff00::/8 multicast
        || (seg[0] == 0x2001 && seg[1] == 0x0db8) // 2001:db8::/32 documentation
        || (seg[0] == 0x0100 && seg[1..4] == [0, 0, 0])) // 100::/64 discard
}

/// Picks the resolved addresses `/proxy` may dial: only public ones, unless
/// `host` is in the dev allow-list (only passed in dev CA mode). The caller
/// connects to these exact addresses, so a DNS rebind cannot swap them.
pub fn select_proxy_addrs(
    host: &str,
    resolved: &[SocketAddr],
    dev_allow_hosts: &[String],
) -> Result<Vec<SocketAddr>, String> {
    let dev_allowed = dev_allow_hosts.iter().any(|h| h.eq_ignore_ascii_case(host));
    let addrs: Vec<SocketAddr> = resolved
        .iter()
        .copied()
        .filter(|a| dev_allowed || is_public_ip(a.ip()))
        .collect();
    if addrs.is_empty() {
        Err(PROXY_TARGET.to_string())
    } else {
        Ok(addrs)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tlsn::{
        config::prove::ProveConfig,
        transcript::{Transcript, TranscriptCommitConfig},
    };

    const HOST: &str = "notice.recall.test";

    fn req(headers: &str) -> Vec<u8> {
        format!("GET /notice HTTP/1.1\r\n{headers}\r\n").into_bytes()
    }

    // --- check_request ---------------------------------------------------

    #[test]
    fn clean_request_ok() {
        let sent = req("Host: notice.recall.test\r\nAccept: */*\r\nConnection: close\r\n");
        assert_eq!(check_request(&sent, HOST), Ok(()));
    }

    #[test]
    fn host_mismatch_rejected() {
        let sent = req("Host: evil.example\r\nAccept: */*\r\n");
        assert_eq!(check_request(&sent, HOST), Err(HOST_MISMATCH.to_string()));
    }

    #[test]
    fn cookie_rejected() {
        let sent = req("Host: notice.recall.test\r\nCookie: a=1\r\n");
        assert_eq!(check_request(&sent, HOST), Err(COOKIES_AUTH.to_string()));
    }

    #[test]
    fn authorization_rejected_case_insensitive() {
        let sent = req("host: notice.recall.test\r\naUtHoRiZaTiOn: Bearer x\r\n");
        assert_eq!(check_request(&sent, HOST), Err(COOKIES_AUTH.to_string()));
        let sent = req("Host: notice.recall.test\r\nCOOKIE: a=1\r\n");
        assert_eq!(check_request(&sent, HOST), Err(COOKIES_AUTH.to_string()));
    }

    #[test]
    fn host_compared_case_insensitively_and_trimmed() {
        let sent = req("HOST:   Notice.Recall.Test  \r\n");
        assert_eq!(check_request(&sent, HOST), Ok(()));
    }

    #[test]
    fn missing_or_duplicate_host_rejected() {
        let sent = req("Accept: */*\r\n");
        assert_eq!(check_request(&sent, HOST), Err(HOST_MISMATCH.to_string()));
        let sent = req("Host: notice.recall.test\r\nHost: evil.example\r\n");
        assert_eq!(check_request(&sent, HOST), Err(HOST_MISMATCH.to_string()));
    }

    #[test]
    fn host_with_port_rejected() {
        let sent = req("Host: notice.recall.test:8443\r\n");
        assert_eq!(check_request(&sent, HOST), Err(HOST_MISMATCH.to_string()));
    }

    #[test]
    fn bare_lf_header_smuggling_rejected() {
        let sent = req("Host: notice.recall.test\r\nX-A: b\nCookie: a=1\r\n");
        assert_eq!(
            check_request(&sent, HOST),
            Err(MALFORMED_REQUEST.to_string())
        );
    }

    #[test]
    fn obs_fold_and_space_before_colon_rejected() {
        let sent = req("Host: notice.recall.test\r\nX-A: b\r\n Cookie: a=1\r\n");
        assert_eq!(
            check_request(&sent, HOST),
            Err(MALFORMED_REQUEST.to_string())
        );
        let sent = req("Host: notice.recall.test\r\nCookie : a=1\r\n");
        assert_eq!(
            check_request(&sent, HOST),
            Err(MALFORMED_REQUEST.to_string())
        );
    }

    #[test]
    fn unterminated_head_rejected() {
        let sent = b"GET / HTTP/1.1\r\nHost: notice.recall.test\r\n".to_vec();
        assert_eq!(
            check_request(&sent, HOST),
            Err(MALFORMED_REQUEST.to_string())
        );
    }

    #[test]
    fn pipelined_second_request_rejected() {
        let mut sent = req("Host: notice.recall.test\r\n");
        sent.extend_from_slice(&req("Host: notice.recall.test\r\nCookie: a=1\r\n"));
        assert_eq!(
            check_request(&sent, HOST),
            Err(MALFORMED_REQUEST.to_string())
        );
    }

    #[test]
    fn request_body_must_match_content_length() {
        let mut sent = req("Host: notice.recall.test\r\nContent-Length: 3\r\n");
        sent.extend_from_slice(b"abc");
        assert_eq!(check_request(&sent, HOST), Ok(()));
        sent.extend_from_slice(b"d");
        assert_eq!(
            check_request(&sent, HOST),
            Err(MALFORMED_REQUEST.to_string())
        );
        let sent = req("Host: notice.recall.test\r\nTransfer-Encoding: chunked\r\n");
        assert_eq!(
            check_request(&sent, HOST),
            Err(MALFORMED_REQUEST.to_string())
        );
    }

    // --- check_proxy_target --------------------------------------------

    #[test]
    fn proxy_default_port_is_443() {
        assert_eq!(check_proxy_target(HOST), Ok((HOST.to_string(), 443)));
    }

    #[test]
    fn proxy_explicit_443_ok() {
        assert_eq!(
            check_proxy_target("notice.recall.test:443"),
            Ok((HOST.to_string(), 443))
        );
    }

    #[test]
    fn proxy_port_non_443_rejected() {
        assert_eq!(
            check_proxy_target("notice.recall.test:8443"),
            Err(PROXY_PORT.to_string())
        );
        assert_eq!(
            check_proxy_target("notice.recall.test:22"),
            Err(PROXY_PORT.to_string())
        );
    }

    #[test]
    fn proxy_unparseable_port_rejected() {
        assert_eq!(
            check_proxy_target("notice.recall.test:abc"),
            Err(PROXY_PORT.to_string())
        );
        assert_eq!(
            check_proxy_target("notice.recall.test:"),
            Err(PROXY_PORT.to_string())
        );
        assert_eq!(
            check_proxy_target("a:443:22"),
            Err(PROXY_TARGET.to_string())
        );
    }

    #[test]
    fn proxy_empty_host_rejected() {
        assert_eq!(check_proxy_target(""), Err(PROXY_TARGET.to_string()));
        assert_eq!(check_proxy_target(":443"), Err(PROXY_TARGET.to_string()));
    }

    // --- IP classifier and proxy address selection ----------------------

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn private_ip_rejected() {
        for s in [
            "10.0.0.1",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.1",
            "127.0.0.1",
            "127.8.8.8",
            "100.64.0.1",
            "100.127.255.254",
            "0.0.0.0",
            "0.1.2.3",
            "169.254.1.1",
            "224.0.0.1",
            "255.255.255.255",
            "240.0.0.1",
            "192.0.0.8",
            "192.0.2.1",
            "198.18.0.1",
            "198.51.100.1",
            "203.0.113.1",
            "::1",
            "::",
            "fe80::1",
            "fc00::1",
            "fd12:3456::1",
            "ff02::1",
            "::ffff:10.0.0.1",
            "::ffff:127.0.0.1",
            "64:ff9b::a00:1",
            "2002:a00:1::1",
            "2001:db8::1",
        ] {
            assert!(!is_public_ip(ip(s)), "{s} must be rejected");
        }
    }

    #[test]
    fn metadata_ip_rejected() {
        assert!(!is_public_ip(ip("169.254.169.254")));
        assert!(!is_public_ip(ip("::ffff:169.254.169.254")));
        assert!(!is_public_ip(ip("fd00:ec2::254")));
    }

    #[test]
    fn public_ip_allowed() {
        for s in [
            "1.1.1.1",
            "8.8.8.8",
            "185.199.108.153",
            "172.15.0.1",
            "172.32.0.1",
            "100.63.0.1",
            "100.128.0.1",
            "2606:4700:4700::1111",
            "2a00:1450:4001::200e",
            "::ffff:8.8.8.8",
        ] {
            assert!(is_public_ip(ip(s)), "{s} must be allowed");
        }
    }

    fn sa(s: &str) -> SocketAddr {
        s.parse().unwrap()
    }

    #[test]
    fn proxy_addrs_keep_only_public() {
        let got = select_proxy_addrs(
            "example.com",
            &[sa("10.0.0.1:443"), sa("93.184.216.34:443")],
            &[],
        );
        assert_eq!(got, Ok(vec![sa("93.184.216.34:443")]));
    }

    #[test]
    fn proxy_addrs_all_private_rejected() {
        let got = select_proxy_addrs("evil.example", &[sa("127.0.0.1:443")], &[]);
        assert_eq!(got, Err(PROXY_TARGET.to_string()));
        assert_eq!(
            select_proxy_addrs("x.example", &[], &[]),
            Err(PROXY_TARGET.to_string())
        );
    }

    #[test]
    fn proxy_dev_allow_host_may_be_private() {
        let allow = vec!["notice.recall.test".to_string()];
        let got = select_proxy_addrs("Notice.Recall.Test", &[sa("172.20.0.5:443")], &allow);
        assert_eq!(got, Ok(vec![sa("172.20.0.5:443")]));
        let got = select_proxy_addrs("other.test", &[sa("172.20.0.6:443")], &allow);
        assert_eq!(got, Err(PROXY_TARGET.to_string()));
    }

    // --- prove request / transcript -------------------------------------

    fn transcript() -> Transcript {
        Transcript::new(
            req("Host: notice.recall.test\r\n"),
            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok".to_vec(),
        )
    }

    fn prove_request(identity: bool, reveal: bool, commit: bool) -> ProveRequest {
        let t = transcript();
        let mut b = ProveConfig::builder(&t);
        if identity {
            b.server_identity();
        }
        if reveal {
            b.reveal_sent_all().unwrap();
            b.reveal_recv_all().unwrap();
        }
        if commit {
            let mut c = TranscriptCommitConfig::builder(&t);
            c.commit_recv(&(0..4)).unwrap();
            b.transcript_commit(c.build().unwrap());
        }
        b.build().unwrap().to_request()
    }

    #[test]
    fn full_reveal_with_identity_ok() {
        assert_eq!(
            check_prove_request(&prove_request(true, true, false)),
            Ok(())
        );
    }

    #[test]
    fn missing_server_identity_rejected() {
        assert_eq!(
            check_prove_request(&prove_request(false, true, false)),
            Err(SERVER_IDENTITY.to_string())
        );
    }

    #[test]
    fn commitments_rejected() {
        assert_eq!(
            check_prove_request(&prove_request(true, true, true)),
            Err(COMMITMENTS.to_string())
        );
    }

    #[test]
    fn no_reveal_rejected() {
        assert_eq!(
            check_prove_request(&prove_request(true, false, false)),
            Err(PARTIAL_REVEAL.to_string())
        );
    }

    #[test]
    fn partial_transcript_rejected() {
        let t = transcript();
        let (ls, lr) = (t.sent().len(), t.received().len());
        let full = t.to_partial((0..ls).into(), (0..lr).into());
        assert_eq!(check_full_reveal(&full), Ok(()));
        let part = t.to_partial((0..ls).into(), (0..lr - 1).into());
        assert_eq!(check_full_reveal(&part), Err(PARTIAL_REVEAL.to_string()));
        let part = t.to_partial((1..ls).into(), (0..lr).into());
        assert_eq!(check_full_reveal(&part), Err(PARTIAL_REVEAL.to_string()));
    }

    // --- nonce and limits ------------------------------------------------

    #[test]
    fn nonce_parsed_with_or_without_0x() {
        let hex = "0123456789abcdef".repeat(4);
        let mut want = [0u8; 32];
        for (i, b) in want.iter_mut().enumerate() {
            *b = u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).unwrap();
        }
        assert_eq!(parse_nonce(Some(&format!("0x{hex}"))), Ok(want));
        assert_eq!(parse_nonce(Some(&hex)), Ok(want));
        assert_eq!(
            parse_nonce(Some(&format!("0X{}", hex.to_uppercase()))),
            Ok(want)
        );
    }

    #[test]
    fn nonce_missing_or_malformed_rejected() {
        let e = Err(NONCE.to_string());
        assert_eq!(parse_nonce(None), e);
        assert_eq!(parse_nonce(Some("")), e);
        assert_eq!(parse_nonce(Some("0x1234")), e);
        assert_eq!(parse_nonce(Some(&format!("0x{}", "g".repeat(64)))), e);
        assert_eq!(parse_nonce(Some(&format!("0x{}", "a".repeat(66)))), e);
    }

    #[test]
    fn limits_within_caps_ok_and_above_rejected() {
        let caps = Limits {
            max_sent: 4096,
            max_recv: 65536,
        };
        assert_eq!(check_limits(4096, 65536, caps), Ok(()));
        assert_eq!(check_limits(1024, 16384, caps), Ok(()));
        let e = check_limits(4096, 65537, caps).unwrap_err();
        assert!(e.starts_with("recall: maxRecvData too large"), "{e}");
        let e = check_limits(4097, 1, caps).unwrap_err();
        assert!(e.starts_with("recall: maxSentData too large"), "{e}");
    }
}
