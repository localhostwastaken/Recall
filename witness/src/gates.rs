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
pub const METHOD_NOT_ALLOWED: &str = "recall: only GET requests allowed";
pub const PARTIAL_CONTENT: &str = "recall: partial content not allowed";
pub const MALFORMED_RESPONSE: &str = "recall: malformed response";
pub const COMPRESSED_RESPONSE: &str = "recall: compressed response not allowed";
pub const INTERIM_RESPONSE: &str = "recall: interim response not allowed";
pub const SERVER_NAME_CASE: &str = "recall: server name must be lowercase";
pub const REVEAL_TOO_LARGE: &str = "recall: reveal config too large";
pub const BUSY: &str = "recall: witness busy, try again shortly";
pub const REGISTER_TIMEOUT: &str = "recall: register timed out";
pub const TOO_MANY_FROM_CLIENT: &str = "recall: too many sessions from this client";
pub const PROVER_TIMEOUT: &str = "recall: prover did not connect in time";

/// Most reveal ranges a client may send per direction (a Recall capture
/// reveals everything, normally as one range).
pub const MAX_REVEAL_RANGES: usize = 8;

/// Extra bytes a `/proxy` relay may carry beyond the session's
/// `maxSentData` / `maxRecvData` (TLS handshake, certificates, record
/// overhead).
pub const RELAY_SLACK: usize = 64 * 1024;
pub const NONCE: &str = "recall: nonce missing or malformed";

/// Server-side caps on the transcript sizes a client may register.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    pub max_sent: usize,
    pub max_recv: usize,
}

/// Request headers a capture may carry (names compared ASCII
/// case-insensitively). Anything else is refused, so the signed request is a
/// plain anonymous page load: no cookies or credentials, no `Range`, no
/// `X-Original-URL`-style routing overrides, no compressed body.
pub const ALLOWED_REQUEST_HEADERS: [&str; 6] = [
    "host",
    "accept",
    "accept-encoding",
    "accept-language",
    "user-agent",
    "connection",
];

/// Message for a request header outside [`ALLOWED_REQUEST_HEADERS`] (or an
/// `Accept-Encoding` other than `identity`). `name` is echoed in lowercase;
/// it has already been checked to be an RFC 9110 token.
pub fn header_not_allowed(name: &str) -> String {
    format!("recall: header not allowed: {}", name.to_ascii_lowercase())
}

/// Checks the (fully revealed) HTTP request the prover sent. Structure is
/// checked first (any failure is `recall: malformed request`):
///
/// - the head ends with the first CRLFCRLF and is UTF-8; nothing follows it
///   (no body, no pipelined second request);
/// - request line exactly `GET SP origin-form SP HTTP/1.1` (a method other
///   than `GET` is `recall: only GET requests allowed`);
/// - every header line is CRLF-terminated, has a `:`, a token name (so no
///   whitespace before the colon), a value without control bytes other than
///   HTAB, and is not an obs-fold continuation.
///
/// Then the headers, in order:
///
/// - `Cookie` / `Authorization` -> `recall: cookies/auth not allowed`;
/// - a name outside [`ALLOWED_REQUEST_HEADERS`], or `Accept-Encoding` whose
///   value is not exactly `identity` -> `recall: header not allowed: <name>`;
///
/// and finally exactly one `Host`, equal to `server_name` (ASCII
/// case-insensitive, optional `:443` suffix), else `recall: host mismatch`.
pub fn check_request(sent: &[u8], server_name: &str) -> Result<(), String> {
    let malformed = || MALFORMED_REQUEST.to_string();
    let head_end = sent
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or_else(malformed)?;
    let head = std::str::from_utf8(&sent[..head_end]).map_err(|_| malformed())?;
    if sent.len() != head_end + 4 {
        return Err(malformed());
    }

    let mut lines = head.split("\r\n");
    let request_line = lines.next().unwrap_or_default();
    check_request_line(request_line)?;

    let mut fields = Vec::new();
    for line in lines {
        if line.contains(['\r', '\n']) || line.starts_with([' ', '\t']) {
            return Err(malformed());
        }
        let (name, value) = line.split_once(':').ok_or_else(malformed)?;
        if name.is_empty() || !name.bytes().all(is_tchar) {
            return Err(malformed());
        }
        // field-value: VCHAR / obs-text / SP / HTAB; no other control bytes.
        if value.bytes().any(|b| (b < 0x20 && b != b'\t') || b == 0x7f) {
            return Err(malformed());
        }
        fields.push((name, value.trim_matches([' ', '\t'])));
    }

    let mut hosts = Vec::new();
    for (name, value) in fields {
        if name.eq_ignore_ascii_case("cookie") || name.eq_ignore_ascii_case("authorization") {
            return Err(COOKIES_AUTH.to_string());
        }
        if !ALLOWED_REQUEST_HEADERS
            .iter()
            .any(|h| name.eq_ignore_ascii_case(h))
        {
            return Err(header_not_allowed(name));
        }
        if name.eq_ignore_ascii_case("accept-encoding") && value != "identity" {
            return Err(header_not_allowed(name));
        }
        if name.eq_ignore_ascii_case("host") {
            hosts.push(value);
        }
    }
    match hosts.as_slice() {
        [host]
            if host
                .strip_suffix(":443")
                .unwrap_or(host)
                .eq_ignore_ascii_case(server_name) =>
        {
            Ok(())
        }
        _ => Err(HOST_MISMATCH.to_string()),
    }
}

/// Checks the (fully revealed) HTTP response: it must start with a status line
/// `HTTP/1.x SP 3DIGIT` that is not 1xx (an interim response before the final
/// one), and must not be partial content (status 206, or a `Content-Range`
/// header anywhere in the head) or compressed (`Content-Encoding` other than
/// `identity`, case-insensitive). The first offending header in order wins. Header lines are split on LF
/// with an optional CR, like the prover's HTTP parser, and the head ends at the
/// first empty line; a response with no end of head is malformed.
pub fn check_response(recv: &[u8]) -> Result<(), String> {
    let malformed = || MALFORMED_RESPONSE.to_string();
    let head_end = recv
        .windows(2)
        .position(|w| w == b"\n\n")
        .map(|i| i + 1)
        .into_iter()
        .chain(recv.windows(4).position(|w| w == b"\r\n\r\n").map(|i| i + 2))
        .min()
        .ok_or_else(malformed)?;
    let head = String::from_utf8_lossy(&recv[..head_end]);
    let mut lines = head.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l));

    let status_line = lines.next().unwrap_or_default();
    let mut parts = status_line.splitn(3, ' ');
    let version = parts.next().unwrap_or_default();
    let code = parts.next().unwrap_or_default();
    if !version.starts_with("HTTP/1.")
        || code.len() != 3
        || !code.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(malformed());
    }
    if code.starts_with('1') {
        return Err(INTERIM_RESPONSE.to_string());
    }
    if code == "206" {
        return Err(PARTIAL_CONTENT.to_string());
    }
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            let name = name.trim();
            if name.eq_ignore_ascii_case("content-range") {
                return Err(PARTIAL_CONTENT.to_string());
            }
            if name.eq_ignore_ascii_case("content-encoding")
                && !value.trim().eq_ignore_ascii_case("identity")
            {
                return Err(COMPRESSED_RESPONSE.to_string());
            }
        }
    }
    Ok(())
}

/// The proven server name must be lowercase with no trailing dot, so one site
/// has one spelling in the index (the extension sends `URL.hostname`).
pub fn check_server_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.ends_with('.') || name.bytes().any(|b| b.is_ascii_uppercase()) {
        Err(SERVER_NAME_CASE.to_string())
    } else {
        Ok(())
    }
}

/// Checks one direction of the client's `reveal_config`: at most
/// [`MAX_REVEAL_RANGES`] ranges, each `start <= end <= len`. A bounds check
/// is enough because [`check_full_reveal`] already requires every byte to be
/// revealed. (Empty ranges stay allowed as upstream allowed them; they map to
/// no bytes.)
pub fn check_reveal_ranges<I>(ranges: I, len: usize, direction: &str) -> Result<(), String>
where
    I: ExactSizeIterator<Item = (usize, usize)>,
{
    if ranges.len() > MAX_REVEAL_RANGES {
        return Err(REVEAL_TOO_LARGE.to_string());
    }
    for (start, end) in ranges {
        if !(start <= end && end <= len) {
            return Err(format!(
                "Invalid {direction} range [{start}, {end}) - outside the transcript ({len} bytes)"
            ));
        }
    }
    Ok(())
}

/// RFC 9110 `tchar`: the bytes a header field name may contain.
fn is_tchar(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b)
}

/// The request line must be exactly `GET SP origin-form SP HTTP/1.1`. The
/// origin-form target starts with one `/` and is printable ASCII without `\`
/// or `#`, so `https://` + server name + target is the URL that was fetched
/// (no absolute-form, authority-form, `*`, fragment, or `//host` / `/\host`
/// tricks).
fn check_request_line(line: &str) -> Result<(), String> {
    let malformed = || MALFORMED_REQUEST.to_string();
    let mut parts = line.split(' ');
    let (Some(method), Some(target), Some(version), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(malformed());
    };
    if method != "GET" {
        return Err(METHOD_NOT_ALLOWED.to_string());
    }
    if version != "HTTP/1.1"
        || !target.starts_with('/')
        || target.starts_with("//")
        || target.contains(['\\', '#'])
        || !target.bytes().all(|b| b.is_ascii_graphic())
    {
        return Err(malformed());
    }
    Ok(())
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

/// `true` only for public unicast space (an allowlist).
///
/// - IPv4: everything except 0/8, 10/8, 100.64/10, 127/8, 169.254/16 (incl.
///   cloud metadata 169.254.169.254), 172.16/12, 192.0.0/24, 192.0.2/24,
///   192.88.99/24, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24, 224/4,
///   240/4 and 255.255.255.255.
/// - IPv6: only global unicast 2000::/3, minus 2001::/23 (incl. Teredo
///   2001::/32), 2001:db8::/32, 2002::/16 (6to4) and 3fff::/20. Loopback,
///   ULA, link-local, multicast, NAT64 (64:ff9b::/96, 64:ff9b:1::/48) and
///   IPv4-compatible addresses all fall outside 2000::/3. IPv4-mapped
///   addresses (::ffff:a.b.c.d) are classified by their IPv4 address.
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
        || (a == 100 && (64..128).contains(&b)) // 100.64/10 CGNAT
        || a == 127                            // 127/8 loopback
        || (a == 169 && b == 254)              // 169.254/16 link-local, metadata
        || (a == 172 && (16..32).contains(&b)) // 172.16/12 private
        || (a == 192 && b == 0 && c == 0)      // 192.0.0/24 IETF protocol
        || (a == 192 && b == 0 && c == 2)      // 192.0.2/24 documentation
        || (a == 192 && b == 88 && c == 99)    // 192.88.99/24 6to4 relay anycast
        || (a == 192 && b == 168)              // 192.168/16 private
        || (a == 198 && (b == 18 || b == 19))  // 198.18/15 benchmarking
        || (a == 198 && b == 51 && c == 100)   // 198.51.100/24 documentation
        || (a == 203 && b == 0 && c == 113)    // 203.0.113/24 documentation
        || a >= 224) // 224/4 multicast, 240/4 reserved, 255.255.255.255
}

fn is_public_v6(ip: Ipv6Addr) -> bool {
    let seg = ip.segments();
    if let Some(v4) = ip.to_ipv4_mapped() {
        return is_public_v4(v4); // ::ffff:a.b.c.d
    }
    if seg[0] & 0xe000 != 0x2000 {
        return false; // outside 2000::/3 global unicast
    }
    !((seg[0] == 0x2001 && seg[1] < 0x0200)            // 2001::/23 incl. Teredo
        || (seg[0] == 0x2001 && seg[1] == 0x0db8)      // 2001:db8::/32 documentation
        || seg[0] == 0x2002                            // 2002::/16 6to4
        || (seg[0] == 0x3fff && seg[1] & 0xf000 == 0)) // 3fff::/20 documentation
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
        let sent = req("Host: notice.recall.test\r\nAccept: b\nCookie: a=1\r\n");
        assert_eq!(
            check_request(&sent, HOST),
            Err(MALFORMED_REQUEST.to_string())
        );
    }

    #[test]
    fn obs_fold_and_space_before_colon_rejected() {
        let sent = req("Host: notice.recall.test\r\nAccept: b\r\n Cookie: a=1\r\n");
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

    fn raw(request_line: &str, headers: &str) -> Vec<u8> {
        format!("{request_line}\r\n{headers}\r\n").into_bytes()
    }

    #[test]
    fn absolute_form_target_rejected() {
        let h = "Host: notice.recall.test\r\n";
        for line in [
            "GET https://evil.example/notice HTTP/1.1",
            "GET http://notice.recall.test/notice HTTP/1.1",
            "GET notice.recall.test:443 HTTP/1.1",
            "GET * HTTP/1.1",
            "GET notice HTTP/1.1",
            "GET //evil.example/notice HTTP/1.1",
            "GET /\\evil.example/notice HTTP/1.1",
            "GET /notice\u{e9} HTTP/1.1",
            "GET /notice#frag HTTP/1.1",
            "GET /notice\r HTTP/1.1",
        ] {
            assert_eq!(
                check_request(&raw(line, h), HOST),
                Err(MALFORMED_REQUEST.to_string()),
                "{line}"
            );
        }
    }

    #[test]
    fn non_get_method_rejected() {
        let h = "Host: notice.recall.test\r\n";
        for line in [
            "POST /notice HTTP/1.1",
            "HEAD /notice HTTP/1.1",
            "get /notice HTTP/1.1",
            "CONNECT notice.recall.test:443 HTTP/1.1",
        ] {
            assert_eq!(
                check_request(&raw(line, h), HOST),
                Err(METHOD_NOT_ALLOWED.to_string()),
                "{line}"
            );
        }
    }

    #[test]
    fn request_line_must_be_exactly_get_target_http11() {
        let h = "Host: notice.recall.test\r\n";
        for line in [
            "GET /notice HTTP/1.0",
            "GET /notice HTTP/2",
            "GET  /notice HTTP/1.1",
            "GET /notice  HTTP/1.1",
            "GET /notice HTTP/1.1 extra",
            "GET /no tice HTTP/1.1",
            "GET /notice\tHTTP/1.1",
            "GET /notice",
        ] {
            assert_eq!(
                check_request(&raw(line, h), HOST),
                Err(MALFORMED_REQUEST.to_string()),
                "{line:?}"
            );
        }
        let ok = raw("GET /notice?a=1&b=%20 HTTP/1.1", h);
        assert_eq!(check_request(&ok, HOST), Ok(()));
    }

    #[test]
    fn duplicate_host_rejected() {
        let sent = req("Host: notice.recall.test\r\nHost: notice.recall.test\r\n");
        assert_eq!(check_request(&sent, HOST), Err(HOST_MISMATCH.to_string()));
    }

    #[test]
    fn host_with_443_port_ok() {
        let sent = req("Host: notice.recall.test:443\r\n");
        assert_eq!(check_request(&sent, HOST), Ok(()));
        let sent = req("Host: Notice.Recall.Test:443\r\n");
        assert_eq!(check_request(&sent, HOST), Ok(()));
        let sent = req("Host: notice.recall.test:\r\n");
        assert_eq!(check_request(&sent, HOST), Err(HOST_MISMATCH.to_string()));
    }

    #[test]
    fn host_with_other_port_rejected() {
        for h in [
            "Host: notice.recall.test:80\r\n",
            "Host: notice.recall.test:0443\r\n",
            "Host: notice.recall.test:443:443\r\n",
            "Host: notice.recall.test :443\r\n",
        ] {
            assert_eq!(
                check_request(&req(h), HOST),
                Err(HOST_MISMATCH.to_string()),
                "{h:?}"
            );
        }
    }

    #[test]
    fn header_line_without_colon_rejected() {
        let sent = req("Host: notice.recall.test\r\nX-Broken\r\n");
        assert_eq!(
            check_request(&sent, HOST),
            Err(MALFORMED_REQUEST.to_string())
        );
    }

    #[test]
    fn header_name_must_be_token() {
        for h in [
            "Host: notice.recall.test\r\nX(A): b\r\n",
            "Host: notice.recall.test\r\nX\u{e9}: b\r\n",
            "Host: notice.recall.test\r\n\0Cookie: a=1\r\n",
            "Host: notice.recall.test\r\n: b\r\n",
        ] {
            assert_eq!(
                check_request(&req(h), HOST),
                Err(MALFORMED_REQUEST.to_string()),
                "{h:?}"
            );
        }
        // A well-formed token name gets past the structure check and is then
        // refused by the allowlist.
        let sent = req("Host: notice.recall.test\r\nX-Custom_1.a~: b\r\n");
        assert_eq!(
            check_request(&sent, HOST),
            Err("recall: header not allowed: x-custom_1.a~".to_string())
        );
    }

    #[test]
    fn header_value_control_bytes_rejected() {
        for h in [
            "Host: notice.recall.test\r\nX-A: b\0c\r\n",
            "Host: notice.recall.test\r\nX-A: b\rCookie: a=1\r\n",
            "Host: notice.recall.test\u{7f}\r\n",
        ] {
            assert_eq!(
                check_request(&req(h), HOST),
                Err(MALFORMED_REQUEST.to_string()),
                "{h:?}"
            );
        }
        let ok = req("Host: notice.recall.test\r\nUser-Agent: b\tc \u{e9}\r\n");
        assert_eq!(check_request(&ok, HOST), Ok(()));
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
    fn request_body_rejected() {
        // Any byte after the head is malformed (no body on a GET capture).
        let mut sent = req("Host: notice.recall.test\r\n");
        sent.extend_from_slice(b"abc");
        assert_eq!(
            check_request(&sent, HOST),
            Err(MALFORMED_REQUEST.to_string())
        );
        // Body-framing headers are outside the allowlist.
        let sent = req("Host: notice.recall.test\r\nContent-Length: 0\r\n");
        assert_eq!(
            check_request(&sent, HOST),
            Err(header_not_allowed("content-length"))
        );
        let sent = req("Host: notice.recall.test\r\nTransfer-Encoding: chunked\r\n");
        assert_eq!(
            check_request(&sent, HOST),
            Err(header_not_allowed("transfer-encoding"))
        );
    }

    // --- header allowlist (R20) -------------------------------------------

    #[test]
    fn allowlisted_headers_ok() {
        let sent = req(concat!(
            "Host: notice.recall.test:443\r\n",
            "User-Agent: Mozilla/5.0 (X11; Linux x86_64)\r\n",
            "Accept: text/html,application/xhtml+xml;q=0.9,*/*;q=0.8\r\n",
            "Accept-Language: en-US,en;q=0.5\r\n",
            "Accept-Encoding: identity\r\n",
            "Connection: close\r\n",
        ));
        assert_eq!(check_request(&sent, HOST), Ok(()));
        let sent = req(concat!(
            "HOST: notice.recall.test\r\n",
            "user-agent: x\r\n",
            "ACCEPT: */*\r\n",
            "accept-LANGUAGE: en\r\n",
            "Accept-Encoding:identity\r\n",
            "CONNECTION: keep-alive\r\n",
        ));
        assert_eq!(check_request(&sent, HOST), Ok(()));
        assert_eq!(check_request(&req("Host: notice.recall.test\r\n"), HOST), Ok(()));
    }

    #[test]
    fn range_header_rejected() {
        let sent = req("Host: notice.recall.test\r\nRange: bytes=0-99\r\n");
        assert_eq!(
            check_request(&sent, HOST),
            Err("recall: header not allowed: range".to_string())
        );
        let sent = req("Host: notice.recall.test\r\nIf-Range: \"x\"\r\n");
        assert_eq!(check_request(&sent, HOST), Err(header_not_allowed("if-range")));
    }

    #[test]
    fn x_original_url_rejected() {
        let sent = req("Host: notice.recall.test\r\nX-Original-URL: /admin\r\n");
        assert_eq!(
            check_request(&sent, HOST),
            Err("recall: header not allowed: x-original-url".to_string())
        );
        for h in ["X-Rewrite-URL: /admin", "X-Forwarded-Host: evil.example", "Forwarded: host=evil.example"] {
            let sent = req(&format!("Host: notice.recall.test\r\n{h}\r\n"));
            let name = h.split(':').next().unwrap();
            assert_eq!(check_request(&sent, HOST), Err(header_not_allowed(name)), "{h}");
        }
    }

    #[test]
    fn gzip_accept_encoding_rejected() {
        for v in ["gzip", "gzip, deflate, br", "identity, gzip", "Identity", "identity;q=1", "*", ""] {
            let sent = req(&format!("Host: notice.recall.test\r\nAccept-Encoding: {v}\r\n"));
            assert_eq!(
                check_request(&sent, HOST),
                Err("recall: header not allowed: accept-encoding".to_string()),
                "{v:?}"
            );
        }
    }

    #[test]
    fn cookie_and_auth_keep_their_own_message() {
        // First offending header wins, in request order.
        let sent = req("Host: notice.recall.test\r\nCookie: a=1\r\nRange: bytes=0-1\r\n");
        assert_eq!(check_request(&sent, HOST), Err(COOKIES_AUTH.to_string()));
        let sent = req("Host: notice.recall.test\r\nRange: bytes=0-1\r\nCookie: a=1\r\n");
        assert_eq!(check_request(&sent, HOST), Err(header_not_allowed("range")));
    }

    // --- check_response (R20) ---------------------------------------------

    #[test]
    fn partial_content_206_rejected() {
        let r = b"HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 0-1/10\r\nContent-Length: 2\r\n\r\nab";
        assert_eq!(check_response(r), Err(PARTIAL_CONTENT.to_string()));
        let r = b"HTTP/1.1 206 Partial Content\r\nContent-Length: 2\r\n\r\nab";
        assert_eq!(check_response(r), Err(PARTIAL_CONTENT.to_string()));
    }

    #[test]
    fn content_range_header_rejected() {
        for r in [
            &b"HTTP/1.1 200 OK\r\nContent-Range: bytes 0-1/10\r\n\r\nab"[..],
            b"HTTP/1.1 200 OK\r\nX-A: b\r\ncontent-RANGE: bytes */10\r\n\r\n",
            b"HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */10\r\n\r\n",
            b"HTTP/1.1 200 OK\nContent-Range: bytes 0-1/10\n\nab",
        ] {
            assert_eq!(
                check_response(r),
                Err(PARTIAL_CONTENT.to_string()),
                "{}",
                String::from_utf8_lossy(r)
            );
        }
    }

    #[test]
    fn full_response_ok() {
        let r = b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 2\r\n\r\nok";
        assert_eq!(check_response(r), Ok(()));
        // A Content-Range inside the body is not a header.
        let r = b"HTTP/1.1 200 OK\r\nContent-Length: 23\r\n\r\nContent-Range: bytes 0-1";
        assert_eq!(check_response(r), Ok(()));
        let r = b"HTTP/1.1 404 Not Found\r\n\r\n";
        assert_eq!(check_response(r), Ok(()));
        let mut pdf = b"HTTP/1.1 200 OK\r\nContent-Type: application/pdf\r\n\r\n".to_vec();
        pdf.extend_from_slice(&[0x25, 0x50, 0xff, 0x00, 0xd0]);
        assert_eq!(check_response(&pdf), Ok(()));
    }

    #[test]
    fn interim_response_rejected() {
        for r in [
            &b"HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"[..],
            b"HTTP/1.1 103 Early Hints\r\nLink: </a.css>; rel=preload\r\n\r\nHTTP/1.1 200 OK\r\n\r\n",
        ] {
            assert_eq!(check_response(r), Err(INTERIM_RESPONSE.to_string()));
        }
    }

    #[test]
    fn compressed_response_rejected() {
        for enc in ["gzip", "br", "identity, gzip", "deflate", ""] {
            let r = format!("HTTP/1.1 200 OK\r\nContent-Encoding: {enc}\r\n\r\nxx");
            assert_eq!(
                check_response(r.as_bytes()),
                Err(COMPRESSED_RESPONSE.to_string()),
                "{enc:?}"
            );
        }
        for enc in ["identity", "Identity", " identity "] {
            let r = format!("HTTP/1.1 200 OK\r\nContent-Encoding: {enc}\r\n\r\nok");
            assert_eq!(check_response(r.as_bytes()), Ok(()), "{enc:?}");
        }
    }

    #[test]
    fn malformed_response_rejected() {
        for r in [
            &b""[..],
            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n",
            b"HTTP/2 200\r\n\r\n",
            b"HTTP/1.1 20 OK\r\n\r\n",
            b"garbage\r\n\r\n",
        ] {
            assert_eq!(
                check_response(r),
                Err(MALFORMED_RESPONSE.to_string()),
                "{}",
                String::from_utf8_lossy(r)
            );
        }
    }

    // --- server name -------------------------------------------------------

    #[test]
    fn server_name_must_be_lowercase() {
        assert_eq!(check_server_name("notice.recall.test"), Ok(()));
        assert_eq!(check_server_name("xn--bcher-kva.example"), Ok(()));
        for n in ["Notice.recall.test", "NOTICE.RECALL.TEST", "notice.recall.test.", ""] {
            assert_eq!(check_server_name(n), Err(SERVER_NAME_CASE.to_string()), "{n:?}");
        }
    }

    // --- reveal config ----------------------------------------------------

    #[test]
    fn oversized_reveal_config_rejected() {
        let many: Vec<(usize, usize)> = (0..MAX_REVEAL_RANGES + 1).map(|_| (0, 10)).collect();
        assert_eq!(
            check_reveal_ranges(many.into_iter(), 10, "recv"),
            Err(REVEAL_TOO_LARGE.to_string())
        );
        // The amplification shape: a huge range is refused in O(1), not walked.
        let huge = vec![(0, usize::MAX)];
        let e = check_reveal_ranges(huge.into_iter(), 10, "recv").unwrap_err();
        assert!(e.contains("outside the transcript"), "{e}");
        let ok: Vec<(usize, usize)> = (0..MAX_REVEAL_RANGES).map(|_| (0, 10)).collect();
        assert_eq!(check_reveal_ranges(ok.into_iter(), 10, "recv"), Ok(()));
    }

    #[test]
    fn reveal_range_bounds() {
        assert_eq!(check_reveal_ranges([(0, 10)].into_iter(), 10, "sent"), Ok(()));
        assert_eq!(check_reveal_ranges([(4, 4)].into_iter(), 10, "sent"), Ok(()));
        assert!(check_reveal_ranges([(0, 11)].into_iter(), 10, "sent").is_err());
        assert!(check_reveal_ranges([(5, 4)].into_iter(), 10, "sent").is_err());
        assert!(check_reveal_ranges([(11, 11)].into_iter(), 10, "sent").is_err());
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
    fn teredo_rejected() {
        assert!(!is_public_ip(ip("2001:0:4136:e378:8000:63bf:3fff:fdd2")));
        assert!(!is_public_ip(ip("2001::1")));
        assert!(!is_public_ip(ip("2001:1ff::1"))); // rest of 2001::/23
    }

    #[test]
    fn nat64_rejected() {
        // Even when the embedded IPv4 address is public.
        assert!(!is_public_ip(ip("64:ff9b::808:808")));
        assert!(!is_public_ip(ip("64:ff9b::a00:1")));
        assert!(!is_public_ip(ip("64:ff9b:1::808:808")));
    }

    #[test]
    fn six_to_four_rejected() {
        assert!(!is_public_ip(ip("2002:808:808::1")));
        assert!(!is_public_ip(ip("192.88.99.1")));
    }

    #[test]
    fn v4_mapped_private_rejected() {
        for s in [
            "::ffff:192.168.1.1",
            "::ffff:10.0.0.1",
            "::ffff:100.64.0.1",
            "::ffff:198.18.0.1",
        ] {
            assert!(!is_public_ip(ip(s)), "{s} must be rejected");
        }
    }

    #[test]
    fn benchmark_198_18_rejected() {
        assert!(!is_public_ip(ip("198.18.0.1")));
        assert!(!is_public_ip(ip("198.19.255.255")));
        assert!(is_public_ip(ip("198.20.0.1")));
    }

    #[test]
    fn ipv6_outside_global_unicast_rejected() {
        for s in [
            "::a00:1",
            "::808:808",
            "100::1",
            "4000::1",
            "e000::1",
            "fec0::1",
            "3fff::1",
        ] {
            // 3fff::/20 is documentation space (RFC 9637); the rest is outside 2000::/3.
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
            "2001:4860:4860::8888",
            "2001:200::1",
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
