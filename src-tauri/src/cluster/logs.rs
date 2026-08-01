//! Pod log streaming.
//!
//! Logs are pushed to the frontend over a Tauri channel rather than
//! returned from a command, because `follow` mode has no end: the
//! command would never return and the webview would see a hung promise.
//!
//! Every stream is registered against an id so it can be cancelled. That
//! is not optional bookkeeping — a followed stream holds an open HTTP
//! connection to the API server, and without cancellation, closing a log
//! tab would leak one per view for the lifetime of the process.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};

// kube's log_stream yields futures-io's AsyncBufRead, not tokio's, so
// the line-splitting extension trait has to come from futures too.
use futures::{AsyncBufReadExt, TryStreamExt};
use k8s_openapi::api::core::v1::Pod;
use kube::api::{Api, LogParams};
use serde::Serialize;
use tauri::ipc::Channel;
use tokio::sync::Mutex;
use tokio::task::AbortHandle;

use crate::cluster::Session;
use crate::error::Result;

/// One message on the log channel.
///
/// Tagged so the frontend can distinguish a line from the stream ending,
/// including when it ends because of an error — a log view that simply
/// stops producing lines is indistinguishable from a quiet pod.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum LogEvent {
    Line {
        text: String,
    },
    /// The stream finished normally: the container exited, or a
    /// non-following read reached the end of the buffer.
    Ended,
    /// The stream stopped because something went wrong.
    Failed {
        message: String,
    },
}

#[derive(Default)]
pub struct LogStreams {
    next_id: AtomicU64,
    active: Mutex<HashMap<u64, AbortHandle>>,
}

impl LogStreams {
    fn allocate(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    async fn register(&self, id: u64, handle: AbortHandle) {
        self.active.lock().await.insert(id, handle);
    }

    async fn finish(&self, id: u64) {
        self.active.lock().await.remove(&id);
    }

    /// Aborts a stream. Returns false when the id is unknown, which is
    /// normal: the stream may have ended on its own before the frontend
    /// got round to cancelling it.
    pub async fn cancel(&self, id: u64) -> bool {
        match self.active.lock().await.remove(&id) {
            Some(handle) => {
                handle.abort();
                true
            }
            None => false,
        }
    }

    pub async fn cancel_all(&self) {
        let mut active = self.active.lock().await;
        for (_, handle) in active.drain() {
            handle.abort();
        }
    }
}

/// Options mirroring the subset of `kubectl logs` that a UI needs.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogOptions {
    pub namespace: String,
    pub pod: String,
    /// Required when the pod has more than one container; the API
    /// rejects an ambiguous request rather than guessing.
    pub container: Option<String>,
    /// Keep the connection open and push new lines as they arrive.
    pub follow: bool,
    /// How far back to start. Without a bound, attaching to a
    /// long-running pod would dump its entire retained buffer.
    pub tail_lines: Option<i64>,
    pub timestamps: bool,
    /// Read the previous container instance instead of the current one —
    /// the only way to see why a CrashLoopBackOff pod died.
    pub previous: bool,
}

/// Where streamed events go.
///
/// Abstracted over Tauri's channel so the streaming logic can be tested
/// without an app handle — the alternative is that the one feature with
/// real concurrency in it is also the one feature with no test.
pub trait LogSink: Send + Sync + 'static {
    /// Returns false when the receiver is gone and streaming should stop.
    fn send(&self, event: LogEvent) -> bool;
}

impl LogSink for Channel<LogEvent> {
    fn send(&self, event: LogEvent) -> bool {
        Channel::send(self, event).is_ok()
    }
}

/// Starts streaming and returns the id needed to cancel it.
///
/// The stream runs on a detached task so the command returns
/// immediately; lines arrive on `sink` afterwards.
pub async fn stream(
    session: &Session,
    streams: &'static LogStreams,
    opts: LogOptions,
    sink: impl LogSink,
) -> Result<u64> {
    let client = session.client().await?;
    let api: Api<Pod> = Api::namespaced(client, &opts.namespace);

    let params = LogParams {
        container: opts.container.clone(),
        follow: opts.follow,
        tail_lines: opts.tail_lines,
        timestamps: opts.timestamps,
        previous: opts.previous,
        ..Default::default()
    };

    // Opened before spawning so an immediate failure — no such
    // container, RBAC denial — surfaces as a command error the user can
    // see, rather than as a channel that silently never produces a line.
    let reader = api.log_stream(&opts.pod, &params).await?;

    let id = streams.allocate();
    let task = tokio::spawn(async move {
        let mut lines = reader.lines();
        loop {
            match lines.try_next().await {
                Ok(Some(text)) => {
                    // A failed send means the receiver is gone; there is
                    // nothing left to stream to.
                    if !sink.send(LogEvent::Line { text }) {
                        break;
                    }
                }
                Ok(None) => {
                    sink.send(LogEvent::Ended);
                    break;
                }
                Err(e) => {
                    sink.send(LogEvent::Failed {
                        message: e.to_string(),
                    });
                    break;
                }
            }
        }
        streams.finish(id).await;
    });

    streams.register(id, task.abort_handle()).await;
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    /// Collects events in memory, standing in for the webview.
    struct Collector {
        events: std::sync::Arc<StdMutex<Vec<LogEvent>>>,
        /// Simulates a receiver that has gone away.
        open: std::sync::atomic::AtomicBool,
    }

    impl LogSink for Collector {
        fn send(&self, event: LogEvent) -> bool {
            if !self.open.load(Ordering::Relaxed) {
                return false;
            }
            self.events.lock().unwrap().push(event);
            true
        }
    }

    fn streams() -> &'static LogStreams {
        // Leaked deliberately: `stream` needs a 'static registry, and a
        // test process is short-lived.
        Box::leak(Box::new(LogStreams::default()))
    }

    #[tokio::test]
    async fn ids_are_unique() {
        let s = LogStreams::default();
        let a = s.allocate();
        let b = s.allocate();
        assert_ne!(a, b, "two streams must not share a cancellation id");
    }

    #[tokio::test]
    async fn cancelling_an_unknown_id_is_not_an_error() {
        let s = LogStreams::default();
        // The frontend may cancel a stream that already ended on its
        // own; that race is normal and must not surface as a failure.
        assert!(!s.cancel(4242).await);
    }

    #[tokio::test]
    async fn cancel_aborts_a_registered_stream() {
        let s = LogStreams::default();
        let id = s.allocate();
        let task = tokio::spawn(async {
            // Long enough that it cannot finish on its own.
            tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
        });
        let handle = task.abort_handle();
        s.register(id, handle).await;

        assert!(s.cancel(id).await, "registered stream should cancel");
        assert!(task.await.unwrap_err().is_cancelled());
        // Cancelling twice must not panic or double-abort.
        assert!(!s.cancel(id).await);
    }

    #[tokio::test]
    async fn cancel_all_clears_the_registry() {
        let s = LogStreams::default();
        let mut tasks = Vec::new();
        for _ in 0..3 {
            let id = s.allocate();
            let task = tokio::spawn(async {
                tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
            });
            s.register(id, task.abort_handle()).await;
            tasks.push((id, task));
        }

        s.cancel_all().await;

        for (id, task) in tasks {
            assert!(task.await.unwrap_err().is_cancelled());
            assert!(!s.cancel(id).await, "registry should be empty");
        }
    }

    #[tokio::test]
    async fn streaming_requires_a_connection() {
        let session = Session::default();
        let collector = Collector {
            events: Default::default(),
            open: std::sync::atomic::AtomicBool::new(true),
        };
        let opts = LogOptions {
            namespace: "default".into(),
            pod: "whatever".into(),
            container: None,
            follow: false,
            tail_lines: Some(10),
            timestamps: false,
            previous: false,
        };
        assert!(matches!(
            stream(&session, streams(), opts, collector).await,
            Err(crate::error::AppError::NotConnected)
        ));
    }

    /// Streams real logs from a real pod.
    ///
    /// Ignored by default; needs a reachable cluster. Run with:
    ///   LOUPE_TEST_CONTEXT=orbstack cargo test -- --ignored --nocapture
    #[tokio::test]
    #[ignore = "requires a reachable cluster; set LOUPE_TEST_CONTEXT"]
    async fn streams_logs_from_a_live_pod() {
        let context = std::env::var("LOUPE_TEST_CONTEXT")
            .expect("set LOUPE_TEST_CONTEXT to a context in your kubeconfig");

        let session = Session::default();
        super::super::connect(&session, &context)
            .await
            .expect("connect");

        // Any running pod will do; kube-system always has one.
        let pods = super::super::resources::list_pods(&session, Some("kube-system".into()))
            .await
            .expect("list pods");
        let pod = pods
            .iter()
            .find(|p| p.phase == "Running")
            .expect("kube-system should have a running pod");
        println!("streaming logs from {}", pod.name);

        let events = std::sync::Arc::new(StdMutex::new(Vec::new()));
        let collector = Collector {
            events: events.clone(),
            open: std::sync::atomic::AtomicBool::new(true),
        };

        let opts = LogOptions {
            namespace: "kube-system".into(),
            pod: pod.name.clone(),
            container: None,
            // Not following: the stream must terminate for the test to.
            follow: false,
            tail_lines: Some(20),
            timestamps: false,
            previous: false,
        };

        stream(&session, streams(), opts, collector)
            .await
            .expect("open log stream");

        // Give the detached task time to drain the buffered output.
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;

        let seen = events.lock().unwrap();
        println!("received {} event(s)", seen.len());
        assert!(
            seen.iter().any(|e| matches!(e, LogEvent::Ended)),
            "a non-following stream must terminate with Ended, got: {seen:?}"
        );
        assert!(
            !seen.iter().any(|e| matches!(e, LogEvent::Failed { .. })),
            "stream reported a failure: {seen:?}"
        );
    }
}
