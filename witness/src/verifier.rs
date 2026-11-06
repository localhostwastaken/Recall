use eyre::eyre;
use recall_witness::gates;
use std::future::Future;
use std::time::Duration;
use tlsn::{
    config::verifier::VerifierConfig,
    connection::{DnsName, ServerName, TlsVersion},
    transcript::PartialTranscript,
    verifier::{VerifierCommitStart, VerifierOutput},
    webpki::RootCertStore,
    Session, SessionHandle,
};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio_util::compat::TokioAsyncReadCompatExt;
use tracing::{debug, info, warn};

/// A Recall gate rejected the session. The message (`recall: …`) is sent to
/// the extension verbatim.
#[derive(Debug)]
pub struct Rejection(pub String);

impl std::fmt::Display for Rejection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Rejection {}

/// What a successful, gate-passing session yields.
pub struct VerifiedSession {
    pub server_name: DnsName,
    /// Fully revealed: `sent_unauthed()` and `received_unauthed()` are empty.
    pub transcript: PartialTranscript,
    /// TLS connection start time, Unix seconds (checked against the witness
    /// clock by the MPC-TLS handshake).
    pub conn_time: u64,
    pub tls_version: TlsVersion,
}

/// Closes the session after a rejection and gives the driver a moment to
/// flush the rejection message to the prover.
async fn shutdown<R>(handle: SessionHandle, driver_task: JoinHandle<R>) {
    handle.close();
    let abort = driver_task.abort_handle();
    if tokio::time::timeout(Duration::from_secs(5), driver_task)
        .await
        .is_err()
    {
        abort.abort();
    }
}

/// Core verifier logic that validates the TLS proof.
///
/// Recall patch: MPC mode only. Proxy mode, missing server identity,
/// transcript commitments and partial reveals are rejected (see
/// `recall_witness::gates`), so the upstream proxy-mode dialler and the
/// hash-commitment paths never run.
pub async fn verifier<T: AsyncWrite + AsyncRead + Send + Unpin + 'static>(
    socket: T,
    max_sent_data: usize,
    max_recv_data: usize,
    root_store: RootCertStore,
) -> Result<VerifiedSession, eyre::ErrReport> {
    info!(
        "Starting verification with maxSentData={}, maxRecvData={}",
        max_sent_data, max_recv_data
    );

    // Create a session with the prover
    let session = Session::new(socket.compat());
    let (driver, handle) = session.split();

    // Spawn the session driver to run in the background. Recall: if it fails
    // (the prover hung up), tlsn's protocol futures are not woken, so every
    // step that waits on the prover races this "lost" signal instead of
    // hanging until the 120 s timeout while holding a session slot.
    let (lost_tx, lost_rx) = watch::channel::<Option<String>>(None);
    let driver_task = tokio::spawn(async move {
        let result = driver.await;
        match &result {
            Ok(_) => tracing::info!("verifier session driver completed normally (mux closed)"),
            Err(e) => {
                tracing::error!("verifier session driver error: {e}");
                lost_tx.send_replace(Some(e.to_string()));
            }
        }
        result
    });

    run_protocol(handle, driver_task, lost_rx, max_sent_data, max_recv_data, root_store).await
}

/// Runs `fut` (a protocol step that needs the prover), or fails with
/// `prover connection lost` as soon as the session driver fails. `biased`: a
/// step that has already finished wins over a failure seen in the same poll.
async fn or_lost<T>(
    fut: impl Future<Output = Result<T, eyre::ErrReport>>,
    lost: &mut watch::Receiver<Option<String>>,
) -> Result<T, eyre::ErrReport> {
    let failed = async {
        lost.wait_for(Option::is_some)
            .await
            .map(|v| v.clone().unwrap_or_default())
    };
    tokio::select! {
        biased;
        result = fut => result,
        Ok(err) = failed => Err(eyre!("prover connection lost: {}", err)),
    }
}

/// Best-effort teardown after a rejection: the rejection message is already
/// decided, so a slow or broken connection must not replace or delay it.
async fn teardown<F: Future, R>(step: F, handle: SessionHandle, driver_task: JoinHandle<R>) {
    let _ = tokio::time::timeout(Duration::from_secs(5), step).await;
    shutdown(handle, driver_task).await;
}

/// The verifier protocol and the Recall gates (see [`verifier`]).
async fn run_protocol<O, E>(
    mut handle: SessionHandle,
    driver_task: JoinHandle<Result<O, E>>,
    mut lost: watch::Receiver<Option<String>>,
    max_sent_data: usize,
    max_recv_data: usize,
    root_store: RootCertStore,
) -> Result<VerifiedSession, eyre::ErrReport>
where
    E: std::fmt::Display,
{
    let verifier_config = VerifierConfig::builder()
        .root_store(root_store)
        .build()
        .map_err(|e| eyre!("Failed to build verifier config: {}", e))?;

    let verifier = handle
        .new_verifier(verifier_config)
        .map_err(|e| eyre!("Failed to create verifier: {}", e))?;

    info!("Starting TLS commitment protocol");

    // Run the commitment protocol — the prover's config tells us which mode.
    let commit = or_lost(
        async { verifier.commit().await.map_err(|e| eyre!("Commitment failed: {}", e)) },
        &mut lost,
    )
    .await?;
    let verifier = match commit {
        VerifierCommitStart::Mpc(verifier) => {
            let cfg = verifier.config();
            let over_limit = if cfg.max_sent_data() > max_sent_data {
                Some(format!(
                    "Prover requested max_sent_data {} exceeds limit {}",
                    cfg.max_sent_data(),
                    max_sent_data
                ))
            } else if cfg.max_recv_data() > max_recv_data {
                Some(format!(
                    "Prover requested max_recv_data {} exceeds limit {}",
                    cfg.max_recv_data(),
                    max_recv_data
                ))
            } else {
                None
            };
            if let Some(msg) = over_limit {
                teardown(verifier.reject(Some(&msg)), handle, driver_task).await;
                return Err(eyre!(msg));
            }
            info!(
                "Accepting MPC TLS commitment with max_sent={}, max_recv={}",
                cfg.max_sent_data(),
                cfg.max_recv_data()
            );

            or_lost(
                async {
                    verifier
                        .accept()
                        .await
                        .map_err(|e| eyre!("Accept failed: {}", e))?
                        .run()
                        .await
                        .map_err(|e| eyre!("Run failed: {}", e))
                },
                &mut lost,
            )
            .await?
        }
        VerifierCommitStart::Proxy(verifier) => {
            // Recall gate: in proxy mode the witness itself would dial the
            // prover-named host. Reject before accept(); the upstream dialler
            // is removed.
            warn!("Rejecting proxy-mode commitment");
            teardown(verifier.reject(Some(gates::PROXY_MODE)), handle, driver_task).await;
            return Err(Rejection(gates::PROXY_MODE.to_string()).into());
        }
    };

    // Recall: keep the connection time and TLS version (upstream discards them).
    let conn_time = verifier.tls_transcript().time();
    let tls_version = verifier.tls_transcript().version();

    info!("TLS connection complete, starting verification");

    // Receive the prover's proving request
    let verifier = or_lost(
        async { verifier.verify().await.map_err(|e| eyre!("Verification failed: {}", e)) },
        &mut lost,
    )
    .await?;

    // Recall gates before accept(): server identity proven, no transcript
    // commitments (this also keeps alpha.15's commitment code from running),
    // and a reveal requested.
    if let Err(msg) = gates::check_prove_request(verifier.request()) {
        warn!("Rejecting prove request: {}", msg);
        let reject = async {
            if let Ok(verifier) = verifier.reject(Some(&msg)).await {
                let _ = verifier.close().await;
            }
        };
        teardown(reject, handle, driver_task).await;
        return Err(Rejection(msg).into());
    }

    let (output, verifier) = or_lost(
        async {
            verifier
                .accept()
                .await
                .map_err(|e| eyre!("Accept verification failed: {}", e))
        },
        &mut lost,
    )
    .await?;

    // Recall gates after verification. accept() has authenticated the
    // output, so decide now: a rejection is final whatever happens while the
    // connection closes.
    let verified = match recall_gates(output, conn_time, tls_version) {
        Ok(verified) => verified,
        Err(rejection) => {
            warn!("Rejecting verified session: {}", rejection);
            teardown(verifier.close(), handle, driver_task).await;
            return Err(rejection.into());
        }
    };

    // Close the verifier
    or_lost(
        async { verifier.close().await.map_err(|e| eyre!("Failed to close verifier: {}", e)) },
        &mut lost,
    )
    .await?;

    // Close the session handle
    handle.close();

    // Wait for the driver to complete
    driver_task
        .await
        .map_err(|e| eyre!("Driver task failed: {}", e))?
        .map_err(|e| eyre!("Session driver error: {}", e))?;

    info!("verify() returned successfully");
    info!("============================================");
    info!("Verification successful!");
    info!("============================================");

    // Recall: the full transcript is DEBUG only (page content stays out of
    // INFO logs).
    debug!(
        "Sent data: {:?}",
        bytes_to_redacted_string(verified.transcript.sent_unsafe(), "\u{2588}")
    );
    debug!(
        "Received data: {:?}",
        bytes_to_redacted_string(verified.transcript.received_unsafe(), "\u{2588}")
    );

    Ok(verified)
}

/// The Recall gates on an accepted (authenticated) verifier output.
fn recall_gates(
    output: VerifierOutput,
    conn_time: u64,
    tls_version: TlsVersion,
) -> Result<VerifiedSession, Rejection> {
    let VerifierOutput {
        server_name,
        transcript,
        transcript_commitments,
        ..
    } = output;
    if !transcript_commitments.is_empty() {
        return Err(Rejection(gates::COMMITMENTS.to_string()));
    }
    let server_name = server_name.ok_or_else(|| Rejection(gates::SERVER_IDENTITY.to_string()))?;
    let transcript = transcript.ok_or_else(|| Rejection(gates::PARTIAL_REVEAL.to_string()))?;
    gates::check_full_reveal(&transcript).map_err(Rejection)?;

    debug!("transcript: {:?}", &transcript);
    let ServerName::Dns(dns_name) = server_name;
    info!("Server name verified: {:?}", dns_name);

    gates::check_server_name(dns_name.as_str()).map_err(Rejection)?;
    gates::check_request(transcript.sent_unsafe(), dns_name.as_str()).map_err(Rejection)?;
    gates::check_response(transcript.received_unsafe()).map_err(Rejection)?;

    Ok(VerifiedSession {
        server_name: dns_name,
        transcript,
        conn_time,
        tls_version,
    })
}

/// Compress long sequences of redacted emojis for better readability
#[allow(unused)]
fn compress_redacted_sequences(text: String) -> String {
    let re = regex::Regex::new(r"\u{2588}{5,}").unwrap();
    re.replace_all(&text, "\u{2588}\u{2026}\u{2588}").to_string()
}

/// Render redacted bytes as block characters.
///
/// Recall: lossy, so binary bodies (PDFs) no longer fail the session.
fn bytes_to_redacted_string(bytes: &[u8], to: &str) -> String {
    String::from_utf8_lossy(bytes).replace('\0', to)
}
