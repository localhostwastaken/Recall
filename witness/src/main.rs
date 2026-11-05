mod verifier;
mod ws;

#[cfg(test)]
mod tests;

use async_tungstenite::tungstenite::Message;
use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::IntoResponse,
    routing::get,
    serve::ListenerExt,
    Router,
};
use bytes::BytesMut;
use futures_util::SinkExt;
use rangeset::prelude::RangeSet;
use serde::{Deserialize, Serialize};
use alloy_signer_local::PrivateKeySigner;
use recall_witness::{attest, gates};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tlsn::transcript::PartialTranscript;
use tlsn::webpki::{CertificateDer, RootCertStore};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{oneshot, Mutex};
use tokio::time::timeout;
use tokio_util::compat::FuturesAsyncReadCompatExt;
use tower_http::cors::CorsLayer;
use tracing::{debug, error, info, warn};
use uuid::Uuid;
use verifier::{verifier, Rejection};
use ws::{TungsteniteStream, WsUpgrade};
use ws_stream_tungstenite::WsStream;

/// Recall: how long a registered session (and its single /proxy relay) may
/// live: 30 s to connect the prover + 120 s verification + 30 s reveal config.
const SESSION_TTL: Duration = Duration::from_secs(180);

/// Reads an env var, treating an empty value as unset.
fn env_var(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

fn env_usize(name: &str, default: usize) -> usize {
    match env_var(name) {
        None => default,
        Some(v) => v.trim().parse().unwrap_or_else(|_| {
            error!("{} must be a positive integer", name);
            std::process::exit(1);
        }),
    }
}

/// Recall: root certificates for server identity. `WITNESS_DEV_CA_DER` (dev
/// only) replaces the Mozilla roots with that single CA certificate.
fn load_root_store() -> (RootCertStore, Vec<String>) {
    let Some(path) = env_var("WITNESS_DEV_CA_DER") else {
        if env_var("WITNESS_DEV_ALLOW_HOSTS").is_some() {
            warn!("WITNESS_DEV_ALLOW_HOSTS is ignored without WITNESS_DEV_CA_DER");
        }
        info!("Root store: Mozilla roots");
        return (RootCertStore::mozilla(), Vec::new());
    };
    let bytes = std::fs::read(&path).unwrap_or_else(|e| {
        error!("Cannot read WITNESS_DEV_CA_DER {}: {}", path, e);
        std::process::exit(1);
    });
    let cert = if bytes.starts_with(b"-----BEGIN") {
        CertificateDer::from_pem_slice(&bytes).unwrap_or_else(|_| {
            error!("WITNESS_DEV_CA_DER {} is not a valid certificate", path);
            std::process::exit(1);
        })
    } else {
        CertificateDer(bytes)
    };
    let allow: Vec<String> = env_var("WITNESS_DEV_ALLOW_HOSTS")
        .map(|v| {
            v.split(',')
                .map(|h| h.trim().to_ascii_lowercase())
                .filter(|h| !h.is_empty())
                .collect()
        })
        .unwrap_or_default();
    warn!("================================================================");
    warn!("DEV CA MODE: trusting ONLY {} (WITNESS_DEV_CA_DER)", path);
    warn!("DEV CA MODE: Mozilla roots are OFF; never use this witness for real captures");
    if !allow.is_empty() {
        warn!("DEV CA MODE: /proxy may dial private addresses of {:?}", allow);
    }
    warn!("================================================================");
    (RootCertStore { roots: vec![cert] }, allow)
}

#[tokio::main]
async fn main() {
    // Initialize tracing
    tracing_subscriber::fmt()
        .with_target(true)
        .with_max_level(tracing::Level::INFO)
        .with_thread_ids(true)
        .with_line_number(true)
        .init();

    // Recall: the witness signing key. Only the address is ever logged.
    let signer = attest::signer_from_env(&std::env::var("WITNESS_PRIVATE_KEY").unwrap_or_default())
        .unwrap_or_else(|e| {
            error!("{}", e);
            std::process::exit(1);
        });
    info!("Witness signer: {}", signer.address().to_checksum(None));

    let (root_store, dev_allow_hosts) = load_root_store();
    let limits = gates::Limits {
        max_sent: env_usize("MAX_SENT_DATA", 4096),
        max_recv: env_usize("MAX_RECV_DATA", 65536),
    };
    info!(
        "Limits: maxSentData <= {}, maxRecvData <= {}",
        limits.max_sent, limits.max_recv
    );

    // Create application state with session storage and the witness config
    let app_state = Arc::new(AppState {
        sessions: Arc::new(Mutex::new(HashMap::new())),
        signer: Arc::new(signer),
        root_store: Arc::new(root_store),
        dev_allow_hosts: Arc::new(dev_allow_hosts),
        limits,
    });

    // Build router with routes
    let app = app(app_state);

    // Start server
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(7047);
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    info!("TLSNotary Verifier Server starting on {}", addr);

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("Failed to bind to address");
    let listener = listener.tap_io(|tcp_stream| {
        if let Err(err) = tcp_stream.set_nodelay(true) {
            warn!("failed to set TCP_NODELAY on incoming connection: {err}");
        }
    });

    info!("Server listening on http://{}", addr);
    info!("Health endpoint: http://{}/health", addr);
    info!("Info endpoint: http://{}/info", addr);
    info!("Session WebSocket endpoint: ws://{}/session", addr);
    info!(
        "Verifier WebSocket endpoint: ws://{}/verifier?sessionId=<id>",
        addr
    );
    info!(
        "Proxy WebSocket endpoint: ws://{}/proxy?token=<host>&sessionId=<id>",
        addr
    );

    axum::serve(listener, app)
        .await
        .expect("Server error");
}

/// Router with all routes. Recall: CORS stays on the routes the web app and
/// extension use, but not on /proxy (added after the layer).
pub(crate) fn app(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/health", get(health_handler))
        .route("/info", get(info_handler))
        .route("/session", get(session_ws_handler))
        .route("/verifier", get(verifier_ws_handler))
        .layer(CorsLayer::permissive())
        .route("/proxy", get(proxy_ws_handler))
        .with_state(state)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub(crate) enum HandlerType {
    Sent,
    Recv,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(crate) enum HandlerPart {
    StartLine,
    Protocol,
    Method,
    RequestTarget,
    StatusCode,
    Headers,
    Body,
    All,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub(crate) enum HashAlgorithm {
    Blake3,
    Sha256,
    Keccak256,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "UPPERCASE")]
pub(crate) enum HandlerAction {
    Reveal,
    Hash {
        algorithm: HashAlgorithm,
    },
}

impl Default for HandlerAction {
    fn default() -> Self {
        Self::Reveal
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct Handler {
    #[serde(rename = "type")]
    pub(crate) handler_type: HandlerType,
    pub(crate) part: HandlerPart,
    #[serde(default)]
    pub(crate) action: HandlerAction,
}

// Session data structure (without handlers - they come later with ranges)
#[derive(Debug, Clone, Serialize, Deserialize)]
struct SessionConfig {
    #[serde(rename = "maxRecvData")]
    max_recv_data: usize,
    #[serde(rename = "maxSentData")]
    max_sent_data: usize,
}

// Range with handler metadata
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct RangeWithHandler {
    pub(crate) start: usize,
    pub(crate) end: usize,
    pub(crate) handler: Handler,
}

// Reveal configuration sent before prover.reveal()
#[derive(Debug, Clone, Serialize, Deserialize)]
struct RevealConfig {
    sent: Vec<RangeWithHandler>,
    recv: Vec<RangeWithHandler>,
}

// Handler result with revealed value
#[derive(Debug, Clone, Serialize)]
struct HandlerResult {
    #[serde(flatten)]
    handler: Handler,
    value: String,
}

// Verification result containing handler results and the signed statement,
// or an error
#[derive(Debug, Clone)]
struct VerificationResult {
    results: Vec<HandlerResult>,
    attestation: Option<attest::Attestation>,
    error: Option<String>,
}

impl VerificationResult {
    fn error(message: impl Into<String>) -> Self {
        Self {
            results: vec![],
            attestation: None,
            error: Some(message.into()),
        }
    }
}

// Type aliases for WebSocket senders
type ProverSocketSender = oneshot::Sender<TungsteniteStream>;

// Session data stored in AppState
pub(crate) struct SessionData {
    pub(crate) prover_socket_tx: Option<ProverSocketSender>,
    /// Recall: when the session was registered (sessions expire after SESSION_TTL).
    pub(crate) created_at: Instant,
    /// Recall: a session may open exactly one /proxy relay.
    pub(crate) proxy_used: bool,
}

// Application state for sharing data between handlers
#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) sessions: Arc<Mutex<HashMap<String, SessionData>>>,
    /// Recall: the witness key that signs the statement.
    pub(crate) signer: Arc<PrivateKeySigner>,
    /// Recall: roots for server identity (Mozilla, or the dev CA).
    pub(crate) root_store: Arc<RootCertStore>,
    /// Recall: dev CA mode only, hosts /proxy may dial at private addresses.
    pub(crate) dev_allow_hosts: Arc<Vec<String>>,
    /// Recall: server caps on maxSentData/maxRecvData.
    pub(crate) limits: gates::Limits,
}

// Query parameters for verifier WebSocket connection
#[derive(Debug, Deserialize)]
struct VerifierQuery {
    #[serde(rename = "sessionId")]
    session_id: String,
}

// Query parameters for proxy WebSocket connection
// Supports both `token` (notary.pse.dev compatible) and `host` (legacy)
// Recall: `sessionId` is required and must name an active session.
#[derive(Debug, Deserialize)]
struct ProxyQuery {
    #[serde(alias = "host")]
    token: String,
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
}

// ============================================================================
// WebSocket Message Protocol (Typed Messages)
// ============================================================================

/// Incoming messages from client (extension)
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientMessage {
    /// Registration message - sent first to establish session
    Register {
        #[serde(rename = "maxRecvData")]
        max_recv_data: usize,
        #[serde(rename = "maxSentData")]
        max_sent_data: usize,
        #[serde(rename = "sessionData", default)]
        session_data: HashMap<String, String>,
    },
    /// Reveal configuration - sent with ranges and handlers
    RevealConfig {
        sent: Vec<RangeWithHandler>,
        recv: Vec<RangeWithHandler>,
    },
}

/// Outgoing messages to client (extension)
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ServerMessage {
    /// Session registered successfully
    SessionRegistered {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    /// Session completed with results.
    /// Recall: `attestation` is the signed statement; `results` also carries
    /// it as a `RECALL_ATTESTATION` entry for clients that only keep results.
    SessionCompleted {
        results: Vec<serde_json::Value>,
        attestation: attest::Attestation,
    },
    /// Error occurred
    Error {
        message: String,
    },
}

// Health check endpoint handler
async fn health_handler() -> impl IntoResponse {
    "ok"
}

/// Info response structure
#[derive(Debug, Serialize)]
struct InfoResponse {
    /// Package version from Cargo.toml
    version: &'static str,
    /// Git commit hash (from GIT_HASH env var, set by CI)
    git_hash: String,
    /// TLSNotary library version
    tlsn_version: &'static str,
    /// Recall: the witness signer address (EIP-55)
    signer: String,
}

/// Info endpoint handler - returns server information as JSON
pub(crate) async fn info_handler(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let git_hash = std::env::var("GIT_HASH").unwrap_or_else(|_| "dev".to_string());

    axum::Json(InfoResponse {
        version: env!("CARGO_PKG_VERSION"),
        git_hash,
        tlsn_version: "0.1.0-alpha.15",
        signer: state.signer.address().to_checksum(None),
    })
}

// WebSocket session handler for extension
pub(crate) async fn session_ws_handler(
    ws: WsUpgrade,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_session_websocket(socket, state))
}

/// Helper to send typed server messages
async fn send_server_message(socket: &mut TungsteniteStream, message: &ServerMessage) -> bool {
    match socket
        .send(Message::Text(serde_json::to_string(message).unwrap().into()))
        .await
    {
        Ok(_) => true,
        Err(e) => {
            error!("Failed to send message: {}", e);
            false
        }
    }
}

/// Helper to send error message
async fn send_error(socket: &mut TungsteniteStream, message: &str) {
    let _ = send_server_message(socket, &ServerMessage::Error {
        message: message.to_string(),
    })
    .await;
}

// Handle the session WebSocket connection with typed message protocol
async fn handle_session_websocket(mut socket: TungsteniteStream, state: Arc<AppState>) {
    use futures_util::StreamExt;

    // Generate session ID upfront (but don't send yet - wait for register)
    let session_id = Uuid::new_v4().to_string();
    info!("[{}] New session WebSocket connected", session_id);

    // Wait for "register" message first
    let register_msg = match socket.next().await {
        Some(Ok(Message::Text(text))) => text,
        Some(Ok(msg)) => {
            error!("[{}] Expected text message, got: {:?}", session_id, msg);
            send_error(&mut socket, "Expected text message").await;
            return;
        }
        Some(Err(e)) => {
            error!("[{}] Error receiving message: {}", session_id, e);
            return;
        }
        None => {
            error!("[{}] Connection closed before registration", session_id);
            return;
        }
    };

    // Parse as ClientMessage
    let client_msg: ClientMessage = match serde_json::from_str(&register_msg) {
        Ok(msg) => msg,
        Err(e) => {
            error!("[{}] Failed to parse message: {}", session_id, e);
            send_error(&mut socket, &format!("Invalid message format: {}", e)).await;
            return;
        }
    };

    // Expect "register" message type
    let (max_recv_data, max_sent_data, session_data) = match client_msg {
        ClientMessage::Register {
            max_recv_data,
            max_sent_data,
            session_data,
        } => (max_recv_data, max_sent_data, session_data),
        _ => {
            error!("[{}] Expected 'register' message type", session_id);
            send_error(&mut socket, "Expected 'register' message type").await;
            return;
        }
    };

    info!(
        "[{}] Received registration: maxRecvData={}, maxSentData={}, sessionData keys: {:?}",
        session_id,
        max_recv_data,
        max_sent_data,
        session_data.keys().collect::<Vec<_>>()
    );

    // Recall gates at registration: server caps on the transcript sizes, and a
    // 32-byte nonce from the extension to bind into the statement.
    let nonce = match gates::check_limits(max_sent_data, max_recv_data, state.limits)
        .and_then(|_| gates::parse_nonce(session_data.get("nonce").map(String::as_str)))
    {
        Ok(nonce) => nonce,
        Err(msg) => {
            warn!("[{}] Registration rejected: {}", session_id, msg);
            send_error(&mut socket, &msg).await;
            let _ = socket.close(None).await;
            return;
        }
    };

    // Send session_registered response
    if !send_server_message(
        &mut socket,
        &ServerMessage::SessionRegistered {
            session_id: session_id.clone(),
        },
    )
    .await
    {
        error!("[{}] Failed to send session_registered", session_id);
        return;
    }

    info!("[{}] Sent session_registered to client", session_id);

    // Create channels for prover socket, reveal config, and results
    let (prover_socket_tx, prover_socket_rx) = oneshot::channel::<TungsteniteStream>();
    let (reveal_config_tx, reveal_config_rx) = oneshot::channel::<RevealConfig>();
    let (result_tx, result_rx) = oneshot::channel::<VerificationResult>();

    let session_config = SessionConfig {
        max_recv_data,
        max_sent_data,
    };

    // Store session data (so prover can connect)
    {
        let mut sessions = state.sessions.lock().await;
        sessions.insert(
            session_id.clone(),
            SessionData {
                prover_socket_tx: Some(prover_socket_tx),
                created_at: Instant::now(),
                proxy_used: false,
            },
        );
    }

    info!(
        "[{}] Session stored, prover can now connect to /verifier",
        session_id
    );

    // Spawn the verifier task with the result sender
    let session_id_clone = session_id.clone();
    let state_clone = state.clone();
    tokio::spawn(async move {
        run_verifier_task(
            session_id_clone,
            session_config,
            nonce,
            reveal_config_rx,
            prover_socket_rx,
            result_tx,
            state_clone,
        )
        .await;
    });

    info!(
        "[{}] Verifier task spawned, waiting for prover connection and reveal config",
        session_id
    );

    // Wait for reveal_config message. Recall: if the verifier task finishes
    // first (a gate rejected the session before the prover got that far),
    // send its error right away instead of waiting for a reveal_config that
    // will never come.
    let mut result_rx = result_rx;
    let next = tokio::select! {
        msg = socket.next() => msg,
        early = &mut result_rx => {
            let msg = match early {
                Ok(result) => result.error.unwrap_or_else(|| "Verification failed".to_string()),
                Err(_) => "Verification failed".to_string(),
            };
            error!("[{}] ❌ {}", session_id, msg);
            send_error(&mut socket, &msg).await;
            let _ = socket.close(None).await;
            return;
        }
    };
    let reveal_msg = match next {
        Some(Ok(Message::Text(text))) => text,
        Some(Ok(msg)) => {
            error!(
                "[{}] Expected text message for reveal_config, got: {:?}",
                session_id, msg
            );
            send_error(&mut socket, "Expected text message").await;
            return;
        }
        Some(Err(e)) => {
            error!("[{}] Error receiving reveal_config: {}", session_id, e);
            return;
        }
        None => {
            error!(
                "[{}] Connection closed before receiving reveal_config",
                session_id
            );
            return;
        }
    };

    // Parse as ClientMessage
    let client_msg: ClientMessage = match serde_json::from_str(&reveal_msg) {
        Ok(msg) => msg,
        Err(e) => {
            error!("[{}] Failed to parse reveal_config: {}", session_id, e);
            send_error(&mut socket, &format!("Invalid message format: {}", e)).await;
            return;
        }
    };

    // Expect "reveal_config" message type
    let reveal_config = match client_msg {
        ClientMessage::RevealConfig { sent, recv } => RevealConfig { sent, recv },
        _ => {
            error!("[{}] Expected 'reveal_config' message type", session_id);
            send_error(&mut socket, "Expected 'reveal_config' message type").await;
            return;
        }
    };

    info!(
        "[{}] Received reveal_config: {} sent ranges, {} recv ranges",
        session_id,
        reveal_config.sent.len(),
        reveal_config.recv.len()
    );

    // Forward reveal config to verifier task. Recall: if the task already
    // finished, fall through so its result (an error) still reaches the client.
    if reveal_config_tx.send(reveal_config).is_err() {
        error!(
            "[{}] ❌ Verifier task dropped reveal config receiver",
            session_id
        );
    } else {
        info!(
            "[{}] ✅ Reveal config sent, verifier task can now proceed",
            session_id
        );
    }

    // Wait for verification result
    match result_rx.await {
        Ok(result) if result.error.is_some() => {
            let err_msg = result.error.as_deref().unwrap_or("Unknown error");
            error!("[{}] ❌ {}", session_id, err_msg);
            send_error(&mut socket, err_msg).await;
        }
        Ok(result) => {
            info!(
                "[{}] Received verification result, sending to extension",
                session_id
            );

            // Send session_completed to extension
            let Some(attestation) = result.attestation else {
                send_error(&mut socket, "Verification failed").await;
                let _ = socket.close(None).await;
                return;
            };
            let mut results: Vec<serde_json::Value> = result
                .results
                .iter()
                .map(|r| serde_json::to_value(r).expect("handler result serialises"))
                .collect();
            results.push(serde_json::json!({
                "type": "RECALL_ATTESTATION",
                "value": serde_json::to_string(&attestation).expect("attestation serialises"),
            }));
            if send_server_message(
                &mut socket,
                &ServerMessage::SessionCompleted {
                    results,
                    attestation,
                },
            )
            .await
            {
                info!("[{}] ✅ Sent session_completed to extension", session_id);
            } else {
                error!("[{}] Failed to send session_completed", session_id);
            }
        }
        Err(_) => {
            error!(
                "[{}] ❌ Verifier task closed without sending result",
                session_id
            );
            send_error(&mut socket, "Verification failed").await;
        }
    }

    // Close the WebSocket
    let _ = socket.close(None).await;
    info!("[{}] Session WebSocket closed", session_id);
}

// WebSocket handler for verifier (prover connection)
pub(crate) async fn verifier_ws_handler(
    ws: WsUpgrade,
    State(state): State<Arc<AppState>>,
    Query(query): Query<VerifierQuery>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let session_id = query.session_id;

    // Look up the session and extract the prover socket sender.
    // Don't remove the session — proxy mode needs it for the proxy WS routing.
    let prover_socket_tx = {
        let mut sessions = state.sessions.lock().await;
        sessions
            .get_mut(&session_id)
            .and_then(|s| s.prover_socket_tx.take())
    };

    match prover_socket_tx {
        Some(sender) => {
            info!(
                "[{}] Prover WebSocket connection established, passing to verifier",
                session_id
            );
            Ok(ws.on_upgrade(move |socket| async move {
                // Send the WebSocket to the waiting verifier
                if sender.send(socket).is_err() {
                    error!(
                        "[{}] Failed to send socket to verifier - channel closed",
                        session_id
                    );
                } else {
                    info!(
                        "[{}] Prover socket passed to verifier successfully",
                        session_id
                    );
                }
            }))
        }
        None => {
            error!("[{}] Session not found or already connected", session_id);
            Err((
                StatusCode::NOT_FOUND,
                format!("Session not found or already connected: {}", session_id),
            ))
        }
    }
}

// WebSocket proxy handler - bridges WebSocket to TCP
// Compatible with notary.pse.dev: /proxy?token=<host> or legacy /proxy?host=<host>
//
// Recall: no longer an open relay. The target must be port 443, the request
// must name an active session (one relay per session), and the host must
// resolve to public addresses (dev CA mode may allow listed hosts). The relay
// dials the checked addresses, so a DNS rebind cannot swap them.
pub(crate) async fn proxy_ws_handler(
    ws: WsUpgrade,
    Query(query): Query<ProxyQuery>,
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let (host, port) =
        gates::check_proxy_target(&query.token).map_err(|e| (StatusCode::BAD_REQUEST, e))?;

    let forbidden = |msg: &str| {
        warn!("[Proxy] Refused {}:{}: {}", host, port, msg);
        (StatusCode::FORBIDDEN, msg.to_string())
    };

    let Some(session_id) = query.session_id else {
        return Err(forbidden(gates::PROXY_SESSION));
    };
    {
        let mut sessions = state.sessions.lock().await;
        match sessions.get_mut(&session_id) {
            Some(s) if !s.proxy_used && s.created_at.elapsed() < SESSION_TTL => s.proxy_used = true,
            _ => return Err(forbidden(gates::PROXY_SESSION)),
        }
    }

    let resolved: Vec<SocketAddr> = match tokio::net::lookup_host((host.as_str(), port)).await {
        Ok(addrs) => addrs.collect(),
        Err(_) => return Err(forbidden(gates::PROXY_TARGET)),
    };
    let addrs = gates::select_proxy_addrs(&host, &resolved, &state.dev_allow_hosts)
        .map_err(|e| forbidden(&e))?;

    info!(
        "[Proxy] Session {} relaying to {}:{} via {:?}",
        session_id, host, port, addrs
    );
    Ok(ws.on_upgrade(move |socket| handle_proxy_connection(socket, host, addrs)))
}

// Handle the proxy WebSocket connection by bridging to TCP
// Recall: dials only the pre-checked `addrs` (port 443) and the relay lives at
// most SESSION_TTL.
async fn handle_proxy_connection(ws: TungsteniteStream, host: String, addrs: Vec<SocketAddr>) {
    use futures_util::StreamExt;

    let proxy_id = Uuid::new_v4().to_string();
    info!(
        "[{}] Proxy WebSocket connected for host: {}",
        proxy_id, host
    );

    info!("[{}] Connecting to {} at {:?}", proxy_id, host, addrs);

    // Connect to the remote TCP host
    let tcp_stream = match timeout(
        Duration::from_secs(10),
        tokio::net::TcpStream::connect(&addrs[..]),
    )
    .await
    {
        Ok(Ok(stream)) => {
            info!(
                "[{}] TCP connection established to {} at {:?}",
                proxy_id,
                host,
                stream.peer_addr().ok()
            );
            stream
        }
        Ok(Err(e)) => {
            error!("[{}] Failed to connect to {} - {}", proxy_id, host, e);
            return;
        }
        Err(_) => {
            error!("[{}] Timed out connecting to {}", proxy_id, host);
            return;
        }
    };
    if let Err(err) = tcp_stream.set_nodelay(true) {
        warn!(
            "[{}] failed to set TCP_NODELAY on outbound proxy connection: {}",
            proxy_id, err
        );
    }

    // Split WebSocket into sink and stream
    let (mut ws_sink, mut ws_stream) = ws.split();

    // Split the TCP stream into read and write halves
    let (mut tcp_read, mut tcp_write) = tokio::io::split(tcp_stream);

    // Spawn task to forward WebSocket -> TCP
    // Read WebSocket Binary messages and write payload to TCP
    let proxy_id_clone = proxy_id.clone();
    let ws_to_tcp = tokio::spawn(async move {
        let mut total_bytes = 0u64;

        loop {
            match ws_stream.next().await {
                Some(Ok(msg)) => {
                    match msg {
                        Message::Binary(data) => {
                            let len = data.len();
                            total_bytes += len as u64;

                            if let Err(e) = tcp_write.write_all(&data).await {
                                error!("[{}] Failed to write to TCP: {}", proxy_id_clone, e);
                                break;
                            }
                        }
                        Message::Close(_) => {
                            info!(
                                "[{}] WebSocket close frame received, forwarded {} bytes total",
                                proxy_id_clone, total_bytes
                            );
                            break;
                        }
                        _ => {
                            // Ignore Text, Ping, Pong messages for now
                        }
                    }
                }
                Some(Err(e)) => {
                    error!("[{}] WebSocket read error: {}", proxy_id_clone, e);
                    break;
                }
                None => {
                    info!(
                        "[{}] WebSocket stream ended, forwarded {} bytes total",
                        proxy_id_clone, total_bytes
                    );
                    break;
                }
            }
        }

        total_bytes
    });

    // Spawn task to forward TCP -> WebSocket
    // Read from TCP and wrap in WebSocket Binary messages
    let proxy_id_clone = proxy_id.clone();
    let tcp_to_ws = tokio::spawn(async move {
        const CHUNK: usize = 8192;
        let mut buf = BytesMut::with_capacity(CHUNK);
        let mut total_bytes = 0u64;

        loop {
            buf.reserve(CHUNK);
            match tcp_read.read_buf(&mut buf).await {
                Ok(0) => {
                    info!(
                        "[{}] TCP read EOF (server closed), forwarded {} bytes to WebSocket",
                        proxy_id_clone, total_bytes
                    );
                    // Send WebSocket close frame to signal EOF to client
                    if let Err(e) = ws_sink.send(Message::Close(None)).await {
                        error!("[{}] Failed to send WebSocket close frame: {}", proxy_id_clone, e);
                    }
                    break;
                }
                Ok(n) => {
                    total_bytes += n as u64;
                    let chunk = buf.split().freeze();

                    if let Err(e) = ws_sink.send(Message::Binary(chunk)).await {
                        error!("[{}] Failed to send to WebSocket: {}", proxy_id_clone, e);
                        break;
                    }
                }
                Err(e) => {
                    error!("[{}] TCP read error: {}", proxy_id_clone, e);
                    // Send close frame on error too
                    let _ = ws_sink.send(Message::Close(None)).await;
                    break;
                }
            }
        }

        total_bytes
    });

    // Wait for both tasks to complete (Recall: at most SESSION_TTL)
    let aborts = [ws_to_tcp.abort_handle(), tcp_to_ws.abort_handle()];
    let (ws_total, tcp_total) =
        match timeout(SESSION_TTL, async { tokio::join!(ws_to_tcp, tcp_to_ws) }).await {
            Ok((ws_result, tcp_result)) => (ws_result.unwrap_or(0), tcp_result.unwrap_or(0)),
            Err(_) => {
                warn!("[{}] Proxy relay exceeded {:?}, closing", proxy_id, SESSION_TTL);
                aborts.iter().for_each(|a| a.abort());
                (0, 0)
            }
        };

    info!(
        "[{}] Proxy closed: WS→TCP {} bytes, TCP→WS {} bytes",
        proxy_id, ws_total, tcp_total
    );
}

// Verifier task that waits for WebSocket and runs verification
async fn run_verifier_task(
    session_id: String,
    config: SessionConfig,
    nonce: [u8; 32],
    reveal_config_rx: oneshot::Receiver<RevealConfig>,
    socket_rx: oneshot::Receiver<TungsteniteStream>,
    result_tx: oneshot::Sender<VerificationResult>,
    state: Arc<AppState>,
) {
    info!(
        "[{}] Verifier task started, waiting for WebSocket connection...",
        session_id
    );
    info!(
        "[{}] Configuration: maxRecvData={}, maxSentData={}",
        session_id, config.max_recv_data, config.max_sent_data
    );

    // Wait for WebSocket connection with timeout
    let connection_timeout = Duration::from_secs(30);
    let socket_result = timeout(connection_timeout, socket_rx).await;

    let socket = match socket_result {
        Ok(Ok(socket)) => {
            info!(
                "[{}] ✅ WebSocket received, starting verification",
                session_id
            );
            socket
        }
        Ok(Err(_)) => {
            error!(
                "[{}] ❌ Socket channel closed before connection",
                session_id
            );
            cleanup_session(&state, &session_id).await;
            return;
        }
        Err(_) => {
            error!(
                "[{}] ⏱️  Timed out waiting for WebSocket connection after {:?}",
                session_id, connection_timeout
            );
            let _ = result_tx.send(VerificationResult::error(
                "Timed out waiting for the prover to connect",
            ));
            cleanup_session(&state, &session_id).await;
            return;
        }
    };

    // Wrap the WebSocket stream in WsStream for AsyncRead/AsyncWrite compatibility
    let stream = WsStream::new(socket);
    info!("[{}] WebSocket converted to stream", session_id);

    // Convert from futures AsyncRead/AsyncWrite to tokio AsyncRead/AsyncWrite
    let stream = stream.compat();

    // Run the verifier with timeout
    let verification_timeout = Duration::from_secs(120);
    info!(
        "[{}] Starting verification with timeout of {:?}",
        session_id, verification_timeout
    );

    let verification_result = timeout(
        verification_timeout,
        verifier(
            stream,
            config.max_sent_data,
            config.max_recv_data,
            (*state.root_store).clone(),
        ),
    )
    .await;

    // Handle the verification result
    let result = match verification_result {
        Ok(Ok(session)) => {
            info!("[{}] ✅ Verification completed successfully!", session_id);
            complete_session(&session_id, session, nonce, reveal_config_rx, &state).await
        }
        Ok(Err(e)) => {
            // Recall: gate rejections go to the extension verbatim.
            let msg = match e.downcast_ref::<Rejection>() {
                Some(rejection) => rejection.0.clone(),
                None => format!("Verification failed: {}", e),
            };
            VerificationResult::error(msg)
        }
        Err(_) => VerificationResult::error(format!(
            "Verification timed out after {:?}",
            verification_timeout
        )),
    };

    if let Some(msg) = &result.error {
        error!("[{}] ❌ {}", session_id, msg);
    }
    if result_tx.send(result).is_err() {
        error!(
            "[{}] ❌ Failed to send result to extension - channel closed",
            session_id
        );
    } else {
        info!("[{}] ✅ Result sent to extension", session_id);
    }

    // Clean up session (if it still exists in the map)
    cleanup_session(&state, &session_id).await;

    info!("[{}] Verifier task completed and cleaned up", session_id);
}

/// After a verified, gate-passing session: map the reveal config to handler
/// results and sign the Recall statement.
async fn complete_session(
    session_id: &str,
    session: verifier::VerifiedSession,
    nonce: [u8; 32],
    reveal_config_rx: oneshot::Receiver<RevealConfig>,
    state: &Arc<AppState>,
) -> VerificationResult {
    let transcript = &session.transcript;

    // Extract sent and received data
    let sent_bytes = transcript.sent_unsafe();
    let recv_bytes = transcript.received_unsafe();

    info!(
        "[{}] Sent data length: {} bytes (authed: {} bytes)",
        session_id,
        sent_bytes.len(),
        transcript.sent_authed().len(),
    );
    info!(
        "[{}] Received data length: {} bytes (authed: {} bytes)",
        session_id,
        recv_bytes.len(),
        transcript.received_authed().len()
    );

    // Wait for RevealConfig from the session handler (with timeout)
    let reveal_config_wait_timeout = Duration::from_secs(30);
    let reveal_config = match timeout(reveal_config_wait_timeout, reveal_config_rx).await {
        Ok(Ok(config)) => {
            info!("[{}] ✅ RevealConfig received, mapping results", session_id);
            config
        }
        Ok(Err(_)) => {
            return VerificationResult::error("RevealConfig channel closed before delivery");
        }
        Err(_) => {
            return VerificationResult::error(
                "Timed out waiting for RevealConfig after verification",
            );
        }
    };

    // Validate that reveal_config ranges match authenticated transcript ranges.
    if let Err(msg) = verify_reveal_config(&reveal_config, transcript) {
        return VerificationResult::error(msg);
    }

    info!(
        "[{}] ✅ All reveal_config ranges validated against authenticated transcript",
        session_id
    );

    // Map revealed ranges to handler results using raw transcript bytes.
    let mut handler_results = Vec::new();
    handler_results.extend(process_ranges(
        &reveal_config.sent,
        sent_bytes,
        "SENT",
        session_id,
    ));
    handler_results.extend(process_ranges(
        &reveal_config.recv,
        recv_bytes,
        "RECV",
        session_id,
    ));

    // Recall: sign the statement. signedAt is the witness clock.
    let signed_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let statement = match attest::build_statement(
        session.server_name.as_str(),
        session.conn_time,
        signed_at,
        sent_bytes,
        recv_bytes,
        attest::tls_version_code(session.tls_version),
        nonce,
    ) {
        Ok(statement) => statement,
        Err(msg) => return VerificationResult::error(format!("Verification failed: {}", msg)),
    };
    let attestation = attest::attestation(&statement, &state.signer);
    info!(
        "[{}] ✅ Signed statement for {} (digest 0x{}, signer {})",
        session_id,
        statement.serverName,
        statement_digest_hex(&statement),
        attestation.signer
    );

    VerificationResult {
        results: handler_results,
        attestation: Some(attestation),
        error: None,
    }
}

fn statement_digest_hex(statement: &attest::CaptureStatement) -> String {
    use std::fmt::Write;
    attest::eip712_digest(statement)
        .iter()
        .fold(String::with_capacity(64), |mut out, b| {
            let _ = write!(out, "{:02x}", b);
            out
        })
}

/// Validates that all ranges in reveal config are fully within authenticated transcript ranges.
///
/// Recall: transcript commitments are rejected before `accept()`, so HASH
/// handlers can never be satisfied and are refused here; "authenticated"
/// means revealed as plaintext.
fn verify_reveal_config(
    reveal_config: &RevealConfig,
    transcript: &PartialTranscript,
) -> Result<(), String> {
    fn validate_ranges_against_auth_set(
        ranges: &[RangeWithHandler],
        auth_set: &RangeSet<usize>,
        direction: &str,
    ) -> Result<(), String> {
        for range in ranges {
            if let HandlerAction::Hash { .. } = range.handler.action {
                return Err(gates::COMMITMENTS.to_string());
            }
            if !(range.start..range.end).all(|i| auth_set.contains(&i)) {
                return Err(format!(
                    "Invalid {} range [{}, {}) - not fully within authenticated ranges",
                    direction, range.start, range.end
                ));
            }

            debug!(
                "✅ {} range [{}, {}) validated - fully within authenticated ranges",
                direction, range.start, range.end
            );
        }
        Ok(())
    }

    validate_ranges_against_auth_set(&reveal_config.sent, transcript.sent_authed(), "sent")?;
    validate_ranges_against_auth_set(&reveal_config.recv, transcript.received_authed(), "recv")?;

    Ok(())
}

// Helper function to clean up session from state
async fn cleanup_session(state: &Arc<AppState>, session_id: &str) {
    let mut sessions = state.sessions.lock().await;
    if sessions.remove(session_id).is_some() {
        info!("[{}] Session removed from state", session_id);
    }
}

/// Processes ranges and extracts values from the transcript.
///
/// Returns the revealed plaintext bytes as (lossy) UTF-8. Recall: HASH
/// handlers are refused by `verify_reveal_config`.
fn process_ranges(
    ranges: &[RangeWithHandler],
    bytes: &[u8],
    direction_label: &str,
    session_id: &str,
) -> Vec<HandlerResult> {
    ranges
        .iter()
        .map(|range_with_handler| {
            let value = if range_with_handler.start < bytes.len()
                && range_with_handler.end <= bytes.len()
                && range_with_handler.start < range_with_handler.end
            {
                let extracted_bytes = &bytes[range_with_handler.start..range_with_handler.end];
                String::from_utf8_lossy(extracted_bytes).to_string()
            } else {
                format!(
                    "ERROR: Invalid range [{}, {})",
                    range_with_handler.start, range_with_handler.end
                )
            };

            debug!(
                "[{}] Mapped {} range [{}, {}) to handler {:?}: {} bytes",
                session_id,
                direction_label,
                range_with_handler.start,
                range_with_handler.end,
                range_with_handler.handler.part,
                value.len()
            );

            HandlerResult {
                handler: range_with_handler.handler.clone(),
                value,
            }
        })
        .collect()
}
