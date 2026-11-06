//! Recall witness integration tests (replace upstream's webhook test).
//!
//! The fast tests run an in-process witness and need no network.
//!
//! The `e2e_*` tests are `#[ignore]`d: they run a real MPC-TLS prover against
//! the devnet notice fixture (`pnpm devnet:up`, which publishes it on
//! localhost:443 with the fixture CA). Run them in release mode:
//!
//! ```sh
//! cargo test --release -- --ignored e2e_
//! WITNESS_E2E_ADDR=127.0.0.1:7047 cargo test --release -- --ignored e2e_  # the devnet container
//! ```

use std::collections::HashMap;
use std::future::IntoFuture;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use alloy_primitives::{Signature, B256};
use async_tungstenite::tungstenite::Message;
use futures_util::{SinkExt, StreamExt};
use http_body_util::Empty;
use hyper::{body::Bytes, Request};
use hyper_util::rt::TokioIo;
use recall_witness::{attest, gates};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio_util::compat::{FuturesAsyncReadCompatExt, TokioAsyncReadCompatExt};
use ws_stream_tungstenite::WsStream;

use tlsn::{
    config::{
        prove::ProveConfig,
        prover::ProverConfig,
        tls::TlsClientConfig,
        tls_commit::{mpc::MpcTlsConfig, proxy::ProxyTlsConfig},
    },
    connection::ServerName,
    transcript::TranscriptCommitConfig,
    webpki::{CertificateDer, RootCertStore},
    Session,
};

// Hardhat account #2: public, test-only (same as the devnet witness).
const TEST_KEY: &str = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
const TEST_SIGNER: &str = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const NOTICE_HOST: &str = "notice.recall.test";
const NONCE: &str = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const MAX_SENT: usize = 4096;
const MAX_RECV: usize = 16384;

type BoxError = Box<dyn std::error::Error + Send + Sync>;

fn dev_ca() -> RootCertStore {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../fixtures/notice/.certs/ca.der"
    );
    let der = std::fs::read(path).expect("fixture CA (run fixtures/notice/gen-certs.sh)");
    RootCertStore {
        roots: vec![CertificateDer(der)],
    }
}

/// Starts an in-process witness on an ephemeral port; returns its address.
async fn start_witness(root_store: RootCertStore, dev_allow_hosts: Vec<String>) -> SocketAddr {
    start_witness_with(root_store, dev_allow_hosts, 3).await
}

/// Like [`start_witness`], with `MAX_SESSIONS` = `max_sessions`.
async fn start_witness_with(
    root_store: RootCertStore,
    dev_allow_hosts: Vec<String>,
    max_sessions: usize,
) -> SocketAddr {
    let mut state = test_state(root_store, dev_allow_hosts);
    state.session_slots = Arc::new(tokio::sync::Semaphore::new(max_sessions));
    serve_state(state).await.0
}

/// The in-process witness configuration (MAX_SESSIONS 3, 2 per client,
/// CF-Connecting-IP not trusted, 10 s prover connect timeout).
fn test_state(root_store: RootCertStore, dev_allow_hosts: Vec<String>) -> crate::AppState {
    crate::AppState {
        sessions: Arc::new(Mutex::new(HashMap::new())),
        signer: Arc::new(attest::signer_from_env(TEST_KEY).unwrap()),
        root_store: Arc::new(root_store),
        dev_allow_hosts: Arc::new(dev_allow_hosts),
        limits: gates::Limits {
            max_sent: MAX_SENT,
            max_recv: MAX_RECV,
        },
        session_slots: Arc::new(tokio::sync::Semaphore::new(3)),
        per_ip: Arc::new(crate::PerIpLimiter::new(2)),
        trust_cf_header: false,
        prover_connect_timeout: Duration::from_secs(10),
    }
}

/// Serves `state` on an ephemeral port (with the peer address available to
/// handlers, like `main`); returns the address and the shared state.
async fn serve_state(state: crate::AppState) -> (SocketAddr, Arc<crate::AppState>) {
    let _ = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .try_init();
    let state = Arc::new(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = crate::app(state.clone()).into_make_service_with_connect_info::<SocketAddr>();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (addr, state)
}

type ClientWs = async_tungstenite::WebSocketStream<tokio_util::compat::Compat<TcpStream>>;

async fn connect_ws(url: &str) -> Result<ClientWs, BoxError> {
    let parsed = url.parse::<http::Uri>()?;
    let host = parsed.host().ok_or("Missing host in URL")?;
    let port = parsed.port_u16().unwrap_or(80);
    let tcp_stream = TcpStream::connect((host, port)).await?;
    let (ws, _) = async_tungstenite::client_async(url, tcp_stream.compat()).await?;
    Ok(ws)
}

/// Reads the next JSON text message from the session WebSocket.
async fn next_json(ws: &mut ClientWs) -> Result<Value, BoxError> {
    while let Some(msg) = ws.next().await {
        if let Message::Text(text) = msg? {
            return Ok(serde_json::from_str(&text)?);
        }
    }
    Err("session WebSocket closed".into())
}

async fn register(addr: SocketAddr, session_data: Value, max_recv: usize) -> (ClientWs, Value) {
    let ws = connect_ws(&format!("ws://{addr}/session")).await.unwrap();
    register_on(ws, session_data, max_recv).await
}

/// Registers with a `CF-Connecting-IP` header (what the tunnel adds).
async fn register_from(addr: SocketAddr, cf_ip: &str) -> (ClientWs, Value) {
    use async_tungstenite::tungstenite::client::IntoClientRequest;
    let mut req = format!("ws://{addr}/session").into_client_request().unwrap();
    req.headers_mut()
        .insert("CF-Connecting-IP", cf_ip.parse().unwrap());
    let tcp = TcpStream::connect(addr).await.unwrap();
    let (ws, _) = async_tungstenite::client_async(req, tcp.compat()).await.unwrap();
    register_on(ws, json!({"nonce": NONCE}), MAX_RECV).await
}

async fn register_on(mut ws: ClientWs, session_data: Value, max_recv: usize) -> (ClientWs, Value) {
    let msg = json!({
        "type": "register",
        "maxRecvData": max_recv,
        "maxSentData": MAX_SENT,
        "sessionData": session_data,
    });
    ws.send(Message::Text(msg.to_string().into()))
        .await
        .unwrap();
    let reply = next_json(&mut ws).await.unwrap();
    (ws, reply)
}

/// GET with WebSocket upgrade headers (so the WS extractor passes and the
/// handler's own checks decide); returns (status, body).
async fn ws_upgrade_get(url: &str) -> (u16, String) {
    let resp = reqwest::Client::new()
        .get(url)
        .header("Connection", "Upgrade")
        .header("Upgrade", "websocket")
        .header("Sec-WebSocket-Version", "13")
        .header("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
        .send()
        .await
        .unwrap();
    let status = resp.status().as_u16();
    (status, resp.text().await.unwrap_or_default())
}

// ============================================================================
// Fast tests (no network)
// ============================================================================

#[tokio::test]
async fn health() {
    let addr = start_witness(RootCertStore::empty(), vec![]).await;
    let body = reqwest::get(format!("http://{addr}/health"))
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert_eq!(body, "ok");
}

#[tokio::test]
async fn info_reports_signer() {
    let addr = start_witness(RootCertStore::empty(), vec![]).await;
    let info: Value = reqwest::get(format!("http://{addr}/info"))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(info["signer"], TEST_SIGNER);
    assert_eq!(info["tlsn_version"], "0.1.0-alpha.15");
}

#[tokio::test]
async fn register_without_nonce_rejected() {
    let addr = start_witness(RootCertStore::empty(), vec![]).await;
    let (_ws, reply) = register(addr, json!({}), MAX_RECV).await;
    assert_eq!(reply, json!({"type": "error", "message": gates::NONCE}));
    let (_ws, reply) = register(addr, json!({"nonce": "0x1234"}), MAX_RECV).await;
    assert_eq!(reply, json!({"type": "error", "message": gates::NONCE}));
}

#[tokio::test]
async fn register_over_limit_rejected() {
    let addr = start_witness(RootCertStore::empty(), vec![]).await;
    let (_ws, reply) = register(addr, json!({"nonce": NONCE}), MAX_RECV + 1).await;
    assert_eq!(reply["type"], "error");
    let msg = reply["message"].as_str().unwrap();
    assert!(msg.starts_with("recall: maxRecvData too large"), "{msg}");
}

#[tokio::test]
async fn busy_witness_rejects_then_frees_slot() {
    let addr = start_witness_with(RootCertStore::empty(), vec![], 1).await;
    let (_a, reply) = register(addr, json!({"nonce": NONCE}), MAX_RECV).await;
    let sid = reply["sessionId"].as_str().expect("first session registered").to_string();

    // The only slot is taken: the next client is told to come back later.
    let (_b, reply) = register(addr, json!({"nonce": NONCE}), MAX_RECV).await;
    assert_eq!(reply, json!({"type": "error", "message": gates::BUSY}));

    // A prover that connects and hangs up ends session A's verifier task,
    // which releases the slot.
    drop(connect_ws(&format!("ws://{addr}/verifier?sessionId={sid}")).await.unwrap());
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let (_c, reply) = register(addr, json!({"nonce": NONCE}), MAX_RECV).await;
        if reply["type"] == "session_registered" {
            break;
        }
        assert_eq!(reply["message"], gates::BUSY);
        assert!(tokio::time::Instant::now() < deadline, "slot never freed");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[tokio::test]
async fn prover_connect_timeout_releases_slot() {
    let mut state = test_state(RootCertStore::empty(), vec![]);
    state.session_slots = Arc::new(tokio::sync::Semaphore::new(1));
    state.prover_connect_timeout = Duration::from_millis(300);
    let (addr, state) = serve_state(state).await;

    let (mut a, reply) = register(addr, json!({"nonce": NONCE}), MAX_RECV).await;
    assert_eq!(reply["type"], "session_registered");
    // No prover connects: the session ends with an error...
    let reply = tokio::time::timeout(Duration::from_secs(5), next_json(&mut a))
        .await
        .expect("prover timeout reported")
        .unwrap();
    assert_eq!(reply, json!({"type": "error", "message": gates::PROVER_TIMEOUT}));
    // ...and its slots were freed before that error was sent.
    assert_eq!(state.per_ip.live(), 0);
    let (_b, reply) = register(addr, json!({"nonce": NONCE}), MAX_RECV).await;
    assert_eq!(reply["type"], "session_registered", "{reply}");
}

#[tokio::test]
async fn session_close_releases_slot() {
    let mut state = test_state(RootCertStore::empty(), vec![]);
    state.session_slots = Arc::new(tokio::sync::Semaphore::new(1));
    let (addr, state) = serve_state(state).await; // prover timeout stays 10 s

    let (a, reply) = register(addr, json!({"nonce": NONCE}), MAX_RECV).await;
    let sid = reply["sessionId"].as_str().expect("registered").to_string();
    let (_b, reply) = register(addr, json!({"nonce": NONCE}), MAX_RECV).await;
    assert_eq!(reply["message"], gates::BUSY);

    // The client hangs up before any prover connects: the verifier task is
    // cancelled and the slot comes back long before the 10 s timeout.
    drop(a);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    loop {
        let (_c, reply) = register(addr, json!({"nonce": NONCE}), MAX_RECV).await;
        if reply["type"] == "session_registered" {
            break;
        }
        assert_eq!(reply["message"], gates::BUSY);
        assert!(tokio::time::Instant::now() < deadline, "slot not freed on close");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    // The cancelled session is gone: its prover can no longer connect.
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!state.sessions.lock().await.contains_key(&sid));
}

#[tokio::test]
async fn per_client_cap() {
    let mut state = test_state(RootCertStore::empty(), vec![]);
    state.session_slots = Arc::new(tokio::sync::Semaphore::new(10));
    state.trust_cf_header = true;
    let (addr, _state) = serve_state(state).await;

    let (_a1, r) = register_from(addr, "203.0.113.7").await;
    assert_eq!(r["type"], "session_registered", "{r}");
    let (_a2, r) = register_from(addr, "203.0.113.7").await;
    assert_eq!(r["type"], "session_registered", "{r}");
    let (_a3, r) = register_from(addr, "203.0.113.7").await;
    assert_eq!(r, json!({"type": "error", "message": gates::TOO_MANY_FROM_CLIENT}));

    // A different client is unaffected.
    let (_b1, r) = register_from(addr, "198.51.100.9").await;
    assert_eq!(r["type"], "session_registered", "{r}");

    // IPv6 clients are counted per /64.
    let (_c1, r) = register_from(addr, "2001:db8:1:1::1").await;
    assert_eq!(r["type"], "session_registered", "{r}");
    let (_c2, r) = register_from(addr, "2001:db8:1:1::2").await;
    assert_eq!(r["type"], "session_registered", "{r}");
    let (_c3, r) = register_from(addr, "2001:db8:1:1:ffff::3").await;
    assert_eq!(r["message"], gates::TOO_MANY_FROM_CLIENT);
}

#[tokio::test]
async fn cf_header_ignored_unless_trusted() {
    let mut state = test_state(RootCertStore::empty(), vec![]);
    state.session_slots = Arc::new(tokio::sync::Semaphore::new(10));
    let (addr, _state) = serve_state(state).await; // TRUST_CF_HEADER off

    // All three come from 127.0.0.1, whatever the header says.
    let (_a, r) = register_from(addr, "203.0.113.1").await;
    assert_eq!(r["type"], "session_registered", "{r}");
    let (_b, r) = register_from(addr, "203.0.113.2").await;
    assert_eq!(r["type"], "session_registered", "{r}");
    let (_c, r) = register_from(addr, "203.0.113.3").await;
    assert_eq!(r["message"], gates::TOO_MANY_FROM_CLIENT);
}

#[tokio::test]
async fn silent_session_socket_times_out() {
    let addr = start_witness(RootCertStore::empty(), vec![]).await;
    let mut ws = connect_ws(&format!("ws://{addr}/session")).await.unwrap();
    let reply = tokio::time::timeout(Duration::from_secs(15), next_json(&mut ws))
        .await
        .expect("witness answers within REGISTER_TIMEOUT")
        .unwrap();
    assert_eq!(reply, json!({"type": "error", "message": gates::REGISTER_TIMEOUT}));
}

#[tokio::test]
async fn oversized_session_message_closes_socket() {
    let addr = start_witness(RootCertStore::empty(), vec![]).await;
    let mut ws = connect_ws(&format!("ws://{addr}/session")).await.unwrap();
    let msg = json!({
        "type": "register",
        "maxRecvData": MAX_RECV,
        "maxSentData": MAX_SENT,
        "sessionData": {"nonce": NONCE, "pad": "x".repeat(70 * 1024)},
    });
    let _ = ws.send(Message::Text(msg.to_string().into())).await;
    let reply = tokio::time::timeout(Duration::from_secs(5), next_json(&mut ws))
        .await
        .expect("socket closes promptly");
    assert!(reply.is_err(), "expected the socket to close, got {reply:?}");
}

#[tokio::test]
async fn proxy_without_session_forbidden() {
    let addr = start_witness(RootCertStore::empty(), vec![]).await;
    let (status, body) = ws_upgrade_get(&format!("http://{addr}/proxy?token=example.com")).await;
    assert_eq!((status, body.as_str()), (403, gates::PROXY_SESSION));
    let (status, body) = ws_upgrade_get(&format!(
        "http://{addr}/proxy?token=example.com&sessionId=nope"
    ))
    .await;
    assert_eq!((status, body.as_str()), (403, gates::PROXY_SESSION));
}

#[tokio::test]
async fn proxy_non_443_rejected() {
    let addr = start_witness(RootCertStore::empty(), vec![]).await;
    let (status, body) = ws_upgrade_get(&format!(
        "http://{addr}/proxy?token=example.com:22&sessionId=x"
    ))
    .await;
    assert_eq!((status, body.as_str()), (400, gates::PROXY_PORT));
}

#[tokio::test]
async fn proxy_private_target_forbidden_and_session_single_use() {
    let addr = start_witness(RootCertStore::empty(), vec![]).await;
    let (_ws, reply) = register(addr, json!({"nonce": NONCE}), MAX_RECV).await;
    let sid = reply["sessionId"]
        .as_str()
        .expect("session_registered")
        .to_string();
    let (status, body) = ws_upgrade_get(&format!(
        "http://{addr}/proxy?token=127.0.0.1&sessionId={sid}"
    ))
    .await;
    assert_eq!((status, body.as_str()), (403, gates::PROXY_TARGET));
    let (status, body) = ws_upgrade_get(&format!(
        "http://{addr}/proxy?token=127.0.0.1&sessionId={sid}"
    ))
    .await;
    assert_eq!((status, body.as_str()), (403, gates::PROXY_SESSION));
}

#[tokio::test]
async fn proxy_has_no_cors_but_info_does() {
    let addr = start_witness(RootCertStore::empty(), vec![]).await;
    let client = reqwest::Client::new();
    let info = client
        .get(format!("http://{addr}/info"))
        .header("Origin", "https://example.com")
        .send()
        .await
        .unwrap();
    assert!(info.headers().contains_key("access-control-allow-origin"));
    let proxy = client
        .get(format!("http://{addr}/proxy?token=example.com"))
        .header("Origin", "https://example.com")
        .send()
        .await
        .unwrap();
    assert!(!proxy.headers().contains_key("access-control-allow-origin"));
}

// ============================================================================
// End-to-end MPC-TLS against the devnet notice fixture (#[ignore])
// ============================================================================

/// How the test prover misbehaves (mirrors the extension's dev overrides).
#[derive(Clone, Copy, Default)]
struct Overrides {
    proxy_mode: bool,
    cookie: bool,
    extra_header: Option<(&'static str, &'static str)>,
    host_header: Option<&'static str>,
    recv_reveal_end: Option<usize>,
    commit: bool,
    no_identity: bool,
}

struct Outcome {
    /// Final session message (`session_completed` or `error`).
    message: Value,
    /// The prover's transcript (empty if the prover failed).
    sent: Vec<u8>,
    recv: Vec<u8>,
}

type SessionSink = futures_util::stream::SplitSink<ClientWs, Message>;

async fn run_capture(path: &str, o: Overrides) -> Outcome {
    // By default an in-process witness dials "localhost" (the notice fixture
    // published on :443); TLS still names notice.recall.test and checks the
    // fixture CA. With WITNESS_E2E_ADDR (e.g. 127.0.0.1:7047) the tests drive
    // the devnet witness container, which dials notice.recall.test itself.
    let (addr, proxy_host) = match std::env::var("WITNESS_E2E_ADDR") {
        Ok(external) => (external.parse().expect("WITNESS_E2E_ADDR"), NOTICE_HOST),
        Err(_) => (
            start_witness(dev_ca(), vec!["localhost".to_string()]).await,
            "localhost",
        ),
    };
    let (session_ws, reply) = register(addr, json!({"nonce": NONCE}), MAX_RECV).await;
    let sid = reply["sessionId"]
        .as_str()
        .expect("session_registered")
        .to_string();
    let (sink, mut stream) = session_ws.split();

    let prover = tokio::spawn(prove(
        format!("ws://{addr}/verifier?sessionId={sid}"),
        format!("ws://{addr}/proxy?token={proxy_host}&sessionId={sid}"),
        path.to_string(),
        o,
        sink,
    ));

    let message = tokio::time::timeout(Duration::from_secs(180), async {
        while let Some(msg) = stream.next().await {
            if let Ok(Message::Text(text)) = msg {
                let m: Value = serde_json::from_str(&text).unwrap();
                if m["type"] == "session_completed" || m["type"] == "error" {
                    return m;
                }
            }
        }
        panic!("session WebSocket closed without a result");
    })
    .await
    .expect("session result in time");

    let (sent, recv) = match tokio::time::timeout(Duration::from_secs(60), prover).await {
        Ok(Ok(Ok(t))) => t,
        Ok(Ok(Err(e))) => {
            eprintln!("prover error: {e}");
            (vec![], vec![])
        }
        _ => (vec![], vec![]),
    };
    Outcome {
        message,
        sent,
        recv,
    }
}

fn reveal_all(direction: &str, len: usize) -> Value {
    json!([{
        "start": 0,
        "end": len,
        "handler": {"type": direction, "part": "ALL", "action": {"kind": "REVEAL"}},
    }])
}

/// A test prover modelled on the extension's flow: MPC-TLS through the
/// witness /proxy, GET `path`, send reveal_config, then prove.
async fn prove(
    verifier_url: String,
    proxy_url: String,
    path: String,
    o: Overrides,
    mut session_sink: SessionSink,
) -> Result<(Vec<u8>, Vec<u8>), BoxError> {
    let verifier_ws = connect_ws(&verifier_url).await?;
    let session = Session::new(WsStream::new(verifier_ws));
    let (driver, mut handle) = session.split();
    let driver_task = tokio::spawn(driver);
    let prover = handle.new_prover(ProverConfig::builder().build()?)?;

    let result: Result<(Vec<u8>, Vec<u8>), BoxError> = async {
        if o.proxy_mode {
            let cfg = ProxyTlsConfig::builder()
                .server_name(NOTICE_HOST.try_into().unwrap())
                .build()?;
            prover.commit(cfg).await?;
            return Err("proxy-mode commitment was accepted".into());
        }

        let mpc = MpcTlsConfig::builder()
            .max_sent_data(MAX_SENT)
            .max_recv_data(MAX_RECV)
            .build()?;
        let prover = prover.commit(mpc).await?;
        let tls = TlsClientConfig::builder()
            .server_name(ServerName::Dns(NOTICE_HOST.try_into().unwrap()))
            .root_store(dev_ca())
            .build()?;
        let proxy_ws = connect_ws(&proxy_url).await?;
        let (conn, connected) = prover.connect(tls, WsStream::new(proxy_ws))?;
        let prover_task = tokio::spawn(connected.into_future());

        let (mut sender, connection) =
            hyper::client::conn::http1::handshake(TokioIo::new(conn.compat())).await?;
        tokio::spawn(connection);
        let mut req = Request::builder()
            .uri(path.as_str())
            .method("GET")
            .header("Host", o.host_header.unwrap_or(NOTICE_HOST))
            .header("Accept", "*/*")
            .header("Connection", "close");
        if o.cookie {
            req = req.header("Cookie", "a=1");
        }
        if let Some((name, value)) = o.extra_header {
            req = req.header(name, value);
        }
        let response = sender
            .send_request(req.body(Empty::<Bytes>::new())?)
            .await?;
        assert_eq!(response.status(), 200);
        http_body_util::BodyExt::collect(response.into_body()).await?;

        let mut prover = prover_task.await??;
        let sent = prover.transcript().sent().to_vec();
        let recv = prover.transcript().received().to_vec();

        let reveal_config = json!({
            "type": "reveal_config",
            "sent": reveal_all("SENT", sent.len()),
            "recv": reveal_all("RECV", recv.len()),
        });
        session_sink
            .send(Message::Text(reveal_config.to_string().into()))
            .await?;

        let mut cfg = ProveConfig::builder(prover.transcript());
        if !o.no_identity {
            cfg.server_identity();
        }
        cfg.reveal_sent(&(0..sent.len()))?;
        cfg.reveal_recv(&(0..o.recv_reveal_end.unwrap_or(recv.len())))?;
        if o.commit {
            let mut commit = TranscriptCommitConfig::builder(prover.transcript());
            commit.commit_recv(&(0..recv.len()))?;
            cfg.transcript_commit(commit.build()?);
        }
        let proved = prover.prove(&cfg.build()?).await;
        if proved.is_ok() {
            prover.close().await?;
        }
        proved?;
        Ok((sent, recv))
    }
    .await;

    handle.close();
    let _ = tokio::time::timeout(Duration::from_secs(10), driver_task).await;
    result
}

fn assert_rejected(outcome: &Outcome, message: &str) {
    assert_eq!(
        outcome.message,
        json!({"type": "error", "message": message}),
        "unexpected session result"
    );
}

/// Checks the signed statement against the prover's own transcript.
fn assert_signed_capture(outcome: &Outcome) {
    let m = &outcome.message;
    assert_eq!(m["type"], "session_completed", "{m}");
    let att = &m["attestation"];
    assert_eq!(att["signer"], TEST_SIGNER);
    let msg = &att["message"];
    let hex = |b: &[u8]| alloy_primitives::hex::encode_prefixed(Sha256::digest(b));
    assert_eq!(msg["serverName"], NOTICE_HOST);
    assert_eq!(msg["tlsVersion"], 12);
    assert_eq!(msg["nonce"], NONCE);
    assert_eq!(msg["sentLen"], outcome.sent.len());
    assert_eq!(msg["recvLen"], outcome.recv.len());
    assert_eq!(msg["sentSha256"], hex(&outcome.sent));
    assert_eq!(msg["recvSha256"], hex(&outcome.recv));
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let conn_time: u64 = msg["connTime"].as_str().unwrap().parse().unwrap();
    let signed_at: u64 = msg["signedAt"].as_str().unwrap().parse().unwrap();
    assert!(conn_time <= signed_at && signed_at <= now && now - conn_time < 300);

    // The signature recovers to the witness over the statement in `message`.
    let b32 = |k: &str| msg[k].as_str().unwrap().parse::<B256>().unwrap();
    let statement = attest::CaptureStatement {
        serverName: NOTICE_HOST.to_string(),
        connTime: conn_time,
        signedAt: signed_at,
        sentSha256: b32("sentSha256"),
        recvSha256: b32("recvSha256"),
        sentLen: outcome.sent.len() as u32,
        recvLen: outcome.recv.len() as u32,
        tlsVersion: 12,
        nonce: b32("nonce"),
    };
    let sig: Signature = att["signature"].as_str().unwrap().parse().unwrap();
    let signer = sig
        .recover_address_from_prehash(&B256::from(attest::eip712_digest(&statement)))
        .unwrap();
    assert_eq!(signer.to_checksum(None), TEST_SIGNER);

    // The same attestation is also a RECALL_ATTESTATION results entry.
    let results = m["results"].as_array().unwrap();
    let entry = results
        .iter()
        .find(|r| r["type"] == "RECALL_ATTESTATION")
        .expect("RECALL_ATTESTATION entry");
    let value: Value = serde_json::from_str(entry["value"].as_str().unwrap()).unwrap();
    assert_eq!(&value, att);
}

#[tokio::test]
#[ignore = "needs the devnet notice fixture on localhost:443 (pnpm devnet:up)"]
async fn e2e_capture_signs_statement() {
    let outcome = run_capture("/notice", Overrides::default()).await;
    assert_signed_capture(&outcome);
    let body = String::from_utf8_lossy(&outcome.recv);
    assert!(body.contains("Deadline:"), "{body}");
}

#[tokio::test]
#[ignore = "needs the devnet notice fixture on localhost:443 (pnpm devnet:up)"]
async fn e2e_pdf_capture_signs_statement() {
    let outcome = run_capture("/notice.pdf", Overrides::default()).await;
    assert_signed_capture(&outcome);
    assert!(outcome.recv.windows(4).any(|w| w == b"%PDF"));
}

#[tokio::test]
#[ignore = "needs the devnet notice fixture on localhost:443 (pnpm devnet:up)"]
async fn e2e_proxy_mode_rejected() {
    let o = Overrides {
        proxy_mode: true,
        ..Default::default()
    };
    assert_rejected(&run_capture("/notice", o).await, gates::PROXY_MODE);
}

#[tokio::test]
#[ignore = "needs the devnet notice fixture on localhost:443 (pnpm devnet:up)"]
async fn e2e_cookie_rejected() {
    let o = Overrides {
        cookie: true,
        ..Default::default()
    };
    assert_rejected(&run_capture("/notice", o).await, gates::COOKIES_AUTH);
}

#[tokio::test]
#[ignore = "needs the devnet notice fixture on localhost:443 (pnpm devnet:up)"]
async fn e2e_non_allowlisted_header_rejected() {
    let o = Overrides {
        extra_header: Some(("X-Original-URL", "/admin")),
        ..Default::default()
    };
    assert_rejected(
        &run_capture("/notice", o).await,
        "recall: header not allowed: x-original-url",
    );
}

#[tokio::test]
#[ignore = "needs the devnet notice fixture on localhost:443 (pnpm devnet:up)"]
async fn e2e_partial_reveal_rejected() {
    let o = Overrides {
        recv_reveal_end: Some(100),
        ..Default::default()
    };
    assert_rejected(&run_capture("/notice", o).await, gates::PARTIAL_REVEAL);
}

#[tokio::test]
#[ignore = "needs the devnet notice fixture on localhost:443 (pnpm devnet:up)"]
async fn e2e_commitments_rejected() {
    let o = Overrides {
        commit: true,
        ..Default::default()
    };
    assert_rejected(&run_capture("/notice", o).await, gates::COMMITMENTS);
}

#[tokio::test]
#[ignore = "needs the devnet notice fixture on localhost:443 (pnpm devnet:up)"]
async fn e2e_host_mismatch_rejected() {
    let o = Overrides {
        host_header: Some("evil.example"),
        ..Default::default()
    };
    assert_rejected(&run_capture("/notice", o).await, gates::HOST_MISMATCH);
}

#[tokio::test]
#[ignore = "needs the devnet notice fixture on localhost:443 (pnpm devnet:up)"]
async fn e2e_missing_server_identity_rejected() {
    let o = Overrides {
        no_identity: true,
        ..Default::default()
    };
    assert_rejected(&run_capture("/notice", o).await, gates::SERVER_IDENTITY);
}
