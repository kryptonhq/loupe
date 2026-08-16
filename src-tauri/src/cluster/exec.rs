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
const SHELLS: [&str; 2] = ["/bin/bash", "/bin/sh"];

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

    if lower.contains("executable file not found")
        || lower.contains("no such file or directory")
        || lower.contains("oci runtime exec failed")
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
        // The process is finished with; joining lets kube tear the
        // websocket down rather than leaving it half-closed.
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
        stderr: false,
        tty: false,
        ..Default::default()
    };

    let mut last = String::new();
    for shell in SHELLS {
        let command = vec![shell.to_string(), "-c".to_string(), "exit 0".to_string()];
        match api.exec(&opts.pod, command, &params).await {
            Ok(process) => {
                // `join` is what surfaces a non-zero exit; a shell that
                // is not there fails here rather than at attach time.
                match process.join().await {
                    Ok(_) => return Ok(shell.to_string()),
                    Err(e) => last = e.to_string(),
                }
            }
            Err(e) => last = e.to_string(),
        }
    }

    Err(AppError::Kube(explain(&last, "a shell")))
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
