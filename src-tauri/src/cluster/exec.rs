//! A shell inside a container.
//!
//! The point where the app previously stopped being sufficient: you
//! could find the failing pod, read why it failed and look at its
//! manifest, and then had to leave to run one command inside it.
//!
//! The Rust side owns the stream, as it owns every other cluster
//! interaction. The webview sends keystrokes and receives bytes; it
//! never holds a connection to the API server, and it never learns the
//! URL of one. That is the same rule the rest of the app follows, and it
//! matters more here than anywhere else — an exec session is the most
//! privileged thing this app can open.
//!
//! Sessions are registered against an id so they can be closed. A leaked
//! exec is a leaked connection *and* a process still running in
//! somebody's container.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};

use futures::SinkExt;
// kube's attached streams are tokio's, not futures'.
use k8s_openapi::api::core::v1::Pod;
use kube::api::{Api, AttachParams, TerminalSize};
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;
use tokio::task::AbortHandle;

use crate::cluster::Session;
use crate::error::{AppError, Result};

/// Shells tried, in order, when the caller does not name one.
///
/// bash first because it is what anyone typing into a terminal expects,
/// sh second because it is what almost every image actually has. A
/// distroless image has neither, which is a real answer and is reported
/// as one rather than as a stream that dies without explanation.
/// `/busybox/sh` is last because it only exists in the debug variants of
/// distroless images, where it is the only shell there is.
const SHELLS: [&str; 3] = ["/bin/bash", "/bin/sh", "/busybox/sh"];

/// Output from a running session.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ExecEvent {
    /// Raw bytes from the remote terminal, as UTF-8.
    Output {
        data: String,
    },
    /// The shell that was actually opened, so the UI can say which.
    Started {
        shell: String,
    },
    /// The remote process exited.
    Ended,
    Failed {
        message: String,
    },
}

pub trait ExecSink: Send + Sync + 'static {
    fn send(&self, event: ExecEvent) -> bool;
}

impl ExecSink for tauri::ipc::Channel<ExecEvent> {
    fn send(&self, event: ExecEvent) -> bool {
        tauri::ipc::Channel::send(self, event).is_ok()
    }
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecOptions {
    pub namespace: String,
    pub pod: String,
    /// Required when the pod has more than one container.
    pub container: Option<String>,
    /// Overrides the shell probe. Set when the user picks one after the
    /// automatic choice turned out to be wrong.
    pub shell: Option<String>,
}

/// A session's writable end, plus the handles needed to shut it down.
struct Running {
    stdin: Mutex<Box<dyn tokio::io::AsyncWrite + Unpin + Send>>,
    resize: Mutex<futures::channel::mpsc::Sender<TerminalSize>>,
    task: AbortHandle,
}

#[derive(Default)]
pub struct ExecSessions {
    next_id: AtomicU64,
    active: Mutex<HashMap<u64, Running>>,
}

impl ExecSessions {
    fn allocate(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    /// Writes keystrokes to a session.
    pub async fn write(&self, id: u64, data: &str) -> Result<()> {
        let active = self.active.lock().await;
        let Some(running) = active.get(&id) else {
            return Err(AppError::Kube("that terminal is no longer open".into()));
        };
        let mut stdin = running.stdin.lock().await;
        stdin
            .write_all(data.as_bytes())
            .await
            .map_err(|e| AppError::Kube(format!("write to terminal: {e}")))?;
        // Flushed explicitly: a keystroke that sits in a buffer is a
        // terminal that appears to have frozen.
        stdin
            .flush()
            .await
            .map_err(|e| AppError::Kube(format!("write to terminal: {e}")))
    }

    /// Tells the remote TTY how big the window is.
    ///
    /// Without this every full-screen program in the container — top,
    /// vim, less — draws for an 80x24 terminal regardless of the window.
    pub async fn resize(&self, id: u64, width: u16, height: u16) -> Result<()> {
        let active = self.active.lock().await;
        let Some(running) = active.get(&id) else {
            return Ok(());
        };
        let _ = running
            .resize
            .lock()
            .await
            .send(TerminalSize { width, height })
            .await;
        Ok(())
    }

    /// Closes a session. False means it had already ended by itself.
    pub async fn close(&self, id: u64) -> bool {
        match self.active.lock().await.remove(&id) {
            Some(running) => {
                running.task.abort();
                true
            }
            None => false,
        }
    }

    pub async fn close_all(&self) {
        let mut active = self.active.lock().await;
        for (_, running) in active.drain() {
            running.task.abort();
        }
    }
}

/// Turns the API server's refusal into something a user can act on.
///
/// The raw message for a missing shell is about an OCI runtime and a
/// file path, which tells someone reading it nothing about what to do.
pub(crate) fn explain(error: &str, shell: &str) -> String {
    let lower = error.to_lowercase();

    // 127 is the shell's own "command not found", and it is what the
    // kubelet reports when the binary is missing — kubectl prints the
    // OCI runtime's wording instead, so the same failure reaches us
    // looking like two different things.
    if lower.contains("executable file not found")
        || lower.contains("no such file or directory")
        || lower.contains("oci runtime exec failed")
        || lower.contains("exit code 127")
        || lower.contains("command not found")
    {
        return format!(
            "{shell} is not in this image. Distroless and scratch images ship no shell at all, \
             so there is nothing to exec into — use an ephemeral debug container instead."
        );
    }
    if lower.contains("forbidden") {
        // Kept verbatim: the server names the verb and the resource, and
        // that is the whole answer for an RBAC problem.
        return error.to_string();
    }
    if lower.contains("not found") {
        return "that pod is gone — it may have been rescheduled while the terminal was opening."
            .to_string();
    }
    // Should not reach a user: a broken pipe here means Loupe dropped
    // one end of its own stream, not that the cluster refused anything.
    // Translated rather than passed through, because "failed to write to
    // stdout" reads as a problem with the container and sends whoever
    // sees it looking in the wrong place entirely.
    if lower.contains("broken pipe") {
        return "the terminal connection dropped before the shell was ready. Try again — \
                if it keeps happening, please report it."
            .to_string();
    }
    error.to_string()
}

/// Opens a shell and starts streaming it.
///
/// The shell is probed before the interactive session is opened, so
/// "this image has no shell" is a clear message rather than a terminal
/// that appears and immediately dies.
pub async fn start(
    session: &Session,
    sessions: &'static ExecSessions,
    opts: ExecOptions,
    sink: impl ExecSink,
) -> Result<u64> {
    let client = session.client().await?;
    let api: Api<Pod> = Api::namespaced(client, &opts.namespace);

    let shell = match &opts.shell {
        Some(named) => named.clone(),
        None => probe_shell(&api, &opts).await?,
    };

    let params = AttachParams {
        container: opts.container.clone(),
        stdin: true,
        stdout: true,
        // With a TTY the remote multiplexes both streams onto stdout;
        // asking for stderr as well is an error the API server rejects.
        stderr: false,
        tty: true,
        ..Default::default()
    };

    let mut attached = api
        .exec(&opts.pod, vec![shell.clone()], &params)
        .await
        .map_err(|e| AppError::Kube(explain(&e.to_string(), &shell)))?;

    let stdin = attached
        .stdin()
        .ok_or_else(|| AppError::Kube("the terminal has no input stream".into()))?;
    let mut stdout = attached
        .stdout()
        .ok_or_else(|| AppError::Kube("the terminal has no output stream".into()))?;
    let resize = attached
        .terminal_size()
        .ok_or_else(|| AppError::Kube("the terminal cannot be resized".into()))?;

    let id = sessions.allocate();
    sink.send(ExecEvent::Started {
        shell: shell.clone(),
    });

    let task = tokio::spawn(async move {
        let mut buffer = [0u8; 8192];
        loop {
            match stdout.read(&mut buffer).await {
                Ok(0) => {
                    sink.send(ExecEvent::Ended);
                    break;
                }
                Ok(read) => {
                    // Lossy on purpose: a terminal emits arbitrary bytes
                    // and a partial UTF-8 sequence at a buffer boundary
                    // must not kill the session.
                    let text = String::from_utf8_lossy(&buffer[..read]).into_owned();
                    if !sink.send(ExecEvent::Output { data: text }) {
                        break;
                    }
                }
                Err(e) => {
                    sink.send(ExecEvent::Failed {
                        message: e.to_string(),
                    });
                    break;
                }
            }
        }
        // Dropped before joining. Holding a reader that nobody is
        // draining any more would block the background task on a full
        // buffer while `join` waits for that same task — the deadlock
        // kube's own documentation warns about. Dropping it lets the
        // task finish, and joining then tears the websocket down rather
        // than leaving it half-closed.
        drop(stdout);
        let _ = attached.join().await;
    });

    sessions.active.lock().await.insert(
        id,
        Running {
            stdin: Mutex::new(Box::new(stdin)),
            resize: Mutex::new(resize),
            task: task.abort_handle(),
        },
    );

    Ok(id)
}

/// Finds a shell the image actually has.
///
/// Runs each candidate non-interactively and keeps the first that
/// exits cleanly. One extra round trip per candidate, which is cheap
/// next to opening a terminal that turns out to be dead.
async fn probe_shell(api: &Api<Pod>, opts: &ExecOptions) -> Result<String> {
    let params = AttachParams {
        container: opts.container.clone(),
        stdin: false,
        stdout: true,
        // Asked for so a shell that writes its complaint to stderr can be
        // drained too. An undrained stream is the whole hazard here.
        stderr: true,
        tty: false,
        ..Default::default()
    };

    let mut last = String::new();
    for shell in SHELLS {
        let command = vec![shell.to_string(), "-c".to_string(), "exit 0".to_string()];

        let mut process = match api.exec(&opts.pod, command, &params).await {
            Ok(process) => process,
            Err(e) => {
                last = e.to_string();
                continue;
            }
        };

        // Taken before anything else: `join` drops the status receiver,
        // and the status is the only thing that says whether the command
        // actually succeeded. `join` returning Ok means the *transport*
        // was fine, which a missing shell also manages.
        let status = process.take_status();

        // Drained before joining, and this is the important part.
        //
        // `join` drops any reader still held by the process and then
        // waits for the background task — which is writing into the
        // stream it just dropped. That write fails, and kube reports it
        // as "failed to write to stdout: broken pipe": a message about
        // our own plumbing, surfaced to the user as though the cluster
        // had refused them a shell. Draining first also avoids the
        // converse deadlock, where a full buffer blocks the task while
        // `join` waits for that same task.
        // Concurrently, not one after the other. Draining stdout to EOF
        // first would deadlock a shell that fills the stderr buffer
        // while doing it: the task blocks writing stderr, so it never
        // closes stdout, so the first drain never finishes.
        tokio::join!(drain(process.stdout()), drain(process.stderr()));

        let outcome = match status {
            Some(status) => status.await,
            None => None,
        };

        let joined = process.join().await;
        if succeeded(outcome.as_ref()) {
            return Ok(shell.to_string());
        }

        // The status message is preferred over the join error. kube
        // summarises a failed command as "terminated with non-zero exit
        // code", while the kubelet's own message says *why* — and it is
        // the why that turns into something the user can act on.
        last = match outcome.as_ref().and_then(|s| s.message.clone()) {
            Some(message) => message,
            None => joined
                .err()
                .map(|e| e.to_string())
                .unwrap_or_else(|| describe(outcome.as_ref())),
        };
    }

    // Every candidate was tried, so the answer is about the image rather
    // than about one path — and naming what was tried is what turns this
    // from a refusal into information.
    Err(AppError::Kube(no_shell(&last)))
}

/// The message for an image that has no shell at all.
pub(crate) fn no_shell(last: &str) -> String {
    let explained = explain(last, "a shell");
    if !explained.contains("Distroless") {
        // Something else went wrong — a denial, a vanished pod — and
        // that reason is better than a guess about the image.
        return explained;
    }
    format!(
        "No shell in this image (tried {}). Distroless and scratch images ship none, so there \
         is nothing to exec into — attach an ephemeral debug container with `kubectl debug` \
         instead.",
        SHELLS.join(", ")
    )
}

/// Reads a stream to the end and throws it away.
///
/// The probe does not care what a shell printed, only whether it ran —
/// but an undrained stream either deadlocks `join` or makes it report a
/// broken pipe, so the bytes have to go somewhere.
async fn drain(reader: Option<impl tokio::io::AsyncRead + Unpin>) {
    if let Some(mut reader) = reader {
        let _ = tokio::io::copy(&mut reader, &mut tokio::io::sink()).await;
    }
}

/// Whether the remote command actually ran.
///
/// The kubelet reports this out of band. A missing shell still opens a
/// working websocket and still closes it cleanly, so the transport says
/// nothing useful — only the status distinguishes "ran and exited 0"
/// from "there was nothing to run".
pub(crate) fn succeeded(
    status: Option<&k8s_openapi::apimachinery::pkg::apis::meta::v1::Status>,
) -> bool {
    status.is_some_and(|s| s.status.as_deref() == Some("Success"))
}

/// The reason a probe failed, in the kubelet's own words where it gave
/// any. Falls back to something honest rather than inventing a cause.
pub(crate) fn describe(
    status: Option<&k8s_openapi::apimachinery::pkg::apis::meta::v1::Status>,
) -> String {
    status
        .and_then(|s| s.message.clone())
        .unwrap_or_else(|| "the container did not run it".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_shell_explains_itself_rather_than_quoting_the_runtime() {
        // The raw message is about an OCI runtime and a file path, which
        // tells whoever reads it nothing about what to do next.
        let explained = explain(
            r#"OCI runtime exec failed: exec failed: unable to start container process: exec: "/bin/bash": executable file not found in $PATH"#,
            "/bin/bash",
        );
        assert!(explained.contains("Distroless"), "got {explained}");
        assert!(explained.contains("ephemeral debug container"));
    }

    #[test]
    fn no_such_file_is_treated_as_a_missing_shell_too() {
        let explained = explain("no such file or directory", "/bin/sh");
        assert!(explained.contains("no shell"), "got {explained}");
    }

    #[test]
    fn an_rbac_denial_keeps_the_servers_own_wording() {
        // The server names the verb and the resource, and that is the
        // whole answer for a permissions problem.
        let raw = r#"pods "api-7d9" is forbidden: User "dev" cannot create resource "pods/exec""#;
        assert_eq!(explain(raw, "/bin/sh"), raw);
    }

    #[test]
    fn a_vanished_pod_says_so_plainly() {
        let explained = explain(r#"pods "api-7d9" not found"#, "/bin/sh");
        assert!(explained.contains("rescheduled"), "got {explained}");
    }

    /// A kubelet status, in the shape the exec endpoint returns one.
    fn status(
        state: &str,
        message: Option<&str>,
    ) -> k8s_openapi::apimachinery::pkg::apis::meta::v1::Status {
        k8s_openapi::apimachinery::pkg::apis::meta::v1::Status {
            status: Some(state.to_string()),
            message: message.map(|m| m.to_string()),
            ..Default::default()
        }
    }

    #[test]
    fn only_a_success_status_counts_as_a_working_shell() {
        // The transport says nothing useful: a missing shell still opens
        // a working websocket and still closes it cleanly. Judging the
        // probe on `join` alone is what made every terminal report a
        // broken pipe instead of opening.
        assert!(succeeded(Some(&status("Success", None))));
        assert!(!succeeded(Some(&status("Failure", Some("no such file")))));
    }

    #[test]
    fn a_missing_status_is_not_taken_as_success() {
        // The sender is dropped without a status when something went
        // wrong early. Reading that as "it worked" would open a terminal
        // onto nothing.
        assert!(!succeeded(None));
    }

    #[test]
    fn a_failed_probe_reports_the_kubelets_own_words() {
        let reason = describe(Some(&status(
            "Failure",
            Some(r#"exec: "/bin/bash": executable file not found in $PATH"#),
        )));
        assert!(reason.contains("executable file not found"));
        // And that wording is what `explain` turns into the distroless
        // message, so the two have to stay compatible.
        assert!(explain(&reason, "/bin/bash").contains("Distroless"));
    }

    #[test]
    fn a_probe_with_no_status_still_says_something() {
        // Better a vague true statement than an empty error box.
        assert!(!describe(None).is_empty());
    }

    #[test]
    fn a_broken_pipe_is_not_reported_as_a_cluster_problem() {
        // Regression. `join` drops any stream the process still holds and
        // then waits for the task writing into it, so an undrained reader
        // surfaced as "failed to write to stdout: broken pipe" — a message
        // about Loupe's own plumbing, shown to the user as though the
        // container had refused them a shell. The cause is fixed by
        // draining; this makes sure the wording could never mislead again.
        let explained = explain("failed to write to stdout: broken pipe", "/bin/sh");
        assert!(!explained.contains("stdout"), "got {explained}");
        assert!(explained.contains("connection dropped"), "got {explained}");
    }

    #[test]
    fn an_unrecognised_failure_is_passed_through_unchanged() {
        // Better to show a message nobody wrote for this case than to
        // replace it with a guess that is wrong.
        let raw = "connection reset by peer";
        assert_eq!(explain(raw, "/bin/sh"), raw);
    }

    #[test]
    fn bash_is_tried_before_sh() {
        // bash is what anyone typing into a terminal expects; sh is what
        // almost every image actually has.
        assert_eq!(SHELLS[0], "/bin/bash");
        assert_eq!(SHELLS[1], "/bin/sh");
    }

    #[tokio::test]
    async fn writing_to_an_unknown_session_is_an_error_not_a_panic() {
        // The frontend can send a keystroke into a session that ended a
        // moment ago; that race is normal.
        let sessions = ExecSessions::default();
        assert!(sessions.write(4242, "ls\n").await.is_err());
    }

    #[tokio::test]
    async fn resizing_an_unknown_session_is_silently_fine() {
        // Resize arrives on every window change, including after close.
        // Reporting it would be noise, not information.
        let sessions = ExecSessions::default();
        assert!(sessions.resize(4242, 120, 40).await.is_ok());
    }

    #[tokio::test]
    async fn closing_an_unknown_session_reports_that_it_was_already_gone() {
        let sessions = ExecSessions::default();
        assert!(!sessions.close(4242).await);
    }

    #[tokio::test]
    async fn session_ids_are_unique() {
        let sessions = ExecSessions::default();
        assert_ne!(sessions.allocate(), sessions.allocate());
    }

    /// Opens a real shell in a real pod.
    ///
    /// Exists because the bug this replaced could not be caught without a
    /// cluster: every unit test passed while every terminal in the app
    /// failed with a broken pipe. What is asserted is the actual
    /// requirement — the terminal either works, or says plainly why it
    /// cannot — because a distroless pod has no shell and that is a
    /// correct outcome rather than a failure.
    ///
    /// Ignored by default; run with
    ///   LOUPE_TEST_CONTEXT=orbstack cargo test -- --ignored --nocapture
    #[tokio::test]
    #[ignore = "requires a reachable cluster; set LOUPE_TEST_CONTEXT"]
    async fn opens_a_shell_in_a_live_pod_or_says_why_not() {
        use std::sync::Mutex as StdMutex;

        #[derive(Clone)]
        struct Collect(std::sync::Arc<StdMutex<Vec<ExecEvent>>>);
        impl ExecSink for Collect {
            fn send(&self, event: ExecEvent) -> bool {
                self.0.lock().unwrap().push(event);
                true
            }
        }

        let session = crate::cluster::live::session().await;
        let namespace = std::env::var("LOUPE_TEST_NAMESPACE").unwrap_or("kube-system".into());
        let pods = crate::cluster::resources::list_pods(&session, Some(namespace.clone()))
            .await
            .expect("list pods");

        let sessions: &'static ExecSessions = Box::leak(Box::new(ExecSessions::default()));
        let mut opened = 0;

        for pod in pods.iter().filter(|p| p.phase == "Running") {
            let events = std::sync::Arc::new(StdMutex::new(Vec::new()));
            let result = start(
                &session,
                sessions,
                ExecOptions {
                    namespace: namespace.clone(),
                    pod: pod.name.clone(),
                    container: None,
                    // None, so the probe runs — the probe is what broke.
                    shell: None,
                },
                Collect(events.clone()),
            )
            .await;

            let id = match result {
                Err(e) => {
                    let message = e.to_string();
                    println!("{}: no shell — {message}", pod.name);
                    // The failure has to be actionable. Neither of these
                    // ever should have reached a user, and both did.
                    assert!(
                        !message.contains("broken pipe"),
                        "{}: reported our own plumbing: {message}",
                        pod.name
                    );
                    assert!(
                        !message.contains("non-zero exit code"),
                        "{}: reported an exit code instead of a reason: {message}",
                        pod.name
                    );
                    assert!(
                        message.contains("No shell in this image") || message.contains("forbidden"),
                        "{}: unexplained refusal: {message}",
                        pod.name
                    );
                    continue;
                }
                Ok(id) => id,
            };

            // Idle first, the way a real terminal sits while someone
            // reads the prompt. A shell that quietly exits here is a
            // terminal you can see output in and cannot type into.
            tokio::time::sleep(std::time::Duration::from_secs(6)).await;
            let ended_early = events
                .lock()
                .unwrap()
                .iter()
                .any(|e| matches!(e, ExecEvent::Ended));
            assert!(
                !ended_early,
                "{}: the shell exited while idle, which disables input",
                pod.name
            );

            sessions
                .write(id, "echo loupe-exec-works\n")
                .await
                .expect("write to the shell");
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;

            let seen = events.lock().unwrap().clone();
            sessions.close(id).await;

            let output: String = seen
                .iter()
                .filter_map(|e| match e {
                    ExecEvent::Output { data } => Some(data.as_str()),
                    _ => None,
                })
                .collect();

            let failures: Vec<&String> = seen
                .iter()
                .filter_map(|e| match e {
                    ExecEvent::Failed { message } => Some(message),
                    _ => None,
                })
                .collect();
            assert!(
                failures.is_empty(),
                "{}: shell reported {failures:?}",
                pod.name
            );
            assert!(
                output.contains("loupe-exec-works"),
                "{}: the shell did not run the command; got {output:?}",
                pod.name
            );

            println!("{}: shell works", pod.name);
            opened += 1;
        }

        println!("opened {opened} shell(s) across {} pods", pods.len());
    }

    #[tokio::test]
    async fn opening_a_terminal_requires_a_connection() {
        struct Discard;
        impl ExecSink for Discard {
            fn send(&self, _: ExecEvent) -> bool {
                true
            }
        }

        let session = Session::default();
        let sessions: &'static ExecSessions = Box::leak(Box::new(ExecSessions::default()));
        let opts = ExecOptions {
            namespace: "default".into(),
            pod: "api".into(),
            container: None,
            shell: Some("/bin/sh".into()),
        };

        assert!(matches!(
            start(&session, sessions, opts, Discard).await,
            Err(AppError::NotConnected)
        ));
    }
}
