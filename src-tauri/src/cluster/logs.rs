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
    /// A batch of lines, oldest first.
    ///
    /// Batched rather than sent per line because each message crosses
    /// the IPC boundary and is deserialised by the webview. A pod
    /// emitting 5,000 lines a second is a manageable amount of text and
    /// an unmanageable number of round-trips.
    Lines { texts: Vec<String> },
    /// The stream finished normally: the container exited, or a
    /// non-following read reached the end of the buffer.
    Ended,
    /// The stream stopped because something went wrong.
    Failed { message: String },
}

/// Lines held before a batch is sent regardless of the timer.
///
/// Bounds how far behind the view can fall on a burst: at this size the
/// batch goes immediately rather than waiting out the interval.
const MAX_BATCH: usize = 500;

/// How long a partial batch waits for company.
///
/// Short enough to read as live — a line appears within a frame or two
/// of arriving — and long enough that a busy pod coalesces into a few
/// messages a second instead of thousands.
const FLUSH_INTERVAL: std::time::Duration = std::time::Duration::from_millis(50);

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
        pump(reader.lines(), sink).await;
        streams.finish(id).await;
    });

    streams.register(id, task.abort_handle()).await;
    Ok(id)
}

/// Sends whatever has accumulated, clearing the batch.
///
/// Returns false when the receiver has gone away, which is the signal to
/// stop reading: there is nothing left to stream to.
fn send_batch(sink: &impl LogSink, batch: &mut Vec<String>) -> bool {
    if batch.is_empty() {
        return true;
    }
    sink.send(LogEvent::Lines {
        texts: std::mem::take(batch),
    })
}

/// Drains a line stream into a sink, coalescing lines into batches.
///
/// Split from `stream` and written against any line stream so the
/// batching can be tested without a cluster — it is the part with the
/// timing behaviour, and therefore the part worth testing.
///
/// A batch is sent when it reaches `MAX_BATCH` or when `FLUSH_INTERVAL`
/// passes, whichever comes first. That bounds both the latency of a
/// quiet pod's occasional line and the message rate of a loud one.
async fn pump<S>(mut lines: S, sink: impl LogSink)
where
    S: futures::Stream<Item = std::io::Result<String>> + Unpin,
{
    let mut batch: Vec<String> = Vec::new();

    // Starts one interval in, rather than firing immediately: the first
    // tick of a plain `interval` completes at once and would send an
    // empty batch before a single line had been read.
    let mut ticker =
        tokio::time::interval_at(tokio::time::Instant::now() + FLUSH_INTERVAL, FLUSH_INTERVAL);
    // Ticks missed while draining a burst must not queue up and then
    // fire back to back the moment the pod goes quiet.
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            // Both arms hold state in the stream rather than in the
            // future, so losing a race drops no lines.
            item = lines.try_next() => match item {
                Ok(Some(text)) => {
                    batch.push(text);
                    if batch.len() >= MAX_BATCH && !send_batch(&sink, &mut batch) {
                        return;
                    }
                }
                Ok(None) => {
                    // The tail of a short stream would otherwise sit in
                    // the batch until an interval that never comes.
                    if !send_batch(&sink, &mut batch) {
                        return;
                    }
                    sink.send(LogEvent::Ended);
                    return;
                }
                Err(e) => {
                    if !send_batch(&sink, &mut batch) {
                        return;
                    }
                    sink.send(LogEvent::Failed { message: e.to_string() });
                    return;
                }
            },
            _ = ticker.tick() => {
                if !send_batch(&sink, &mut batch) {
                    return;
                }
            }
        }
    }
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

    /// Every line the sink was sent, batches flattened.
    fn lines_of(events: &[LogEvent]) -> Vec<String> {
        events
            .iter()
            .flat_map(|e| match e {
                LogEvent::Lines { texts } => texts.clone(),
                _ => Vec::new(),
            })
            .collect()
    }

    fn batch_sizes(events: &[LogEvent]) -> Vec<usize> {
        events
            .iter()
            .filter_map(|e| match e {
                LogEvent::Lines { texts } => Some(texts.len()),
                _ => None,
            })
            .collect()
    }

    fn collector() -> (Collector, std::sync::Arc<StdMutex<Vec<LogEvent>>>) {
        let events: std::sync::Arc<StdMutex<Vec<LogEvent>>> = Default::default();
        (
            Collector {
                events: events.clone(),
                open: std::sync::atomic::AtomicBool::new(true),
            },
            events,
        )
    }

    fn ok_stream(lines: Vec<&str>) -> impl futures::Stream<Item = std::io::Result<String>> + Unpin {
        futures::stream::iter(
            lines
                .into_iter()
                .map(|l| Ok(l.to_string()))
                .collect::<Vec<_>>(),
        )
    }

    #[tokio::test]
    async fn pump_batches_lines_rather_than_sending_one_each() {
        // The whole point of the batching: 900 lines available at once
        // must not become 900 messages across the IPC boundary.
        let lines: Vec<String> = (0..900).map(|i| format!("line {i}")).collect();
        let stream = futures::stream::iter(
            lines
                .iter()
                .map(|l| Ok(l.clone()))
                .collect::<Vec<std::io::Result<String>>>(),
        );

        let (sink, events) = collector();
        pump(stream, sink).await;

        let seen = events.lock().unwrap();
        assert_eq!(lines_of(&seen), lines, "every line must arrive, in order");
        let sizes = batch_sizes(&seen);
        assert!(
            sizes.len() < 10,
            "900 lines should coalesce into a handful of batches, got {}",
            sizes.len()
        );
        assert!(
            sizes.iter().all(|n| *n <= MAX_BATCH),
            "no batch may exceed MAX_BATCH, got {sizes:?}"
        );
    }

    #[tokio::test]
    async fn pump_flushes_the_tail_before_ending() {
        // A stream shorter than a batch would otherwise leave its lines
        // sitting in the buffer waiting for an interval that never comes.
        let (sink, events) = collector();
        pump(ok_stream(vec!["only", "two"]), sink).await;

        let seen = events.lock().unwrap();
        assert_eq!(lines_of(&seen), vec!["only", "two"]);
        assert!(
            matches!(seen.last(), Some(LogEvent::Ended)),
            "the tail must be sent before Ended, got: {seen:?}"
        );
    }

    #[tokio::test]
    async fn pump_reports_a_read_error_after_flushing_what_it_had() {
        // Lines read before the failure are still worth showing — they
        // are usually the ones explaining it.
        let stream = futures::stream::iter(vec![
            Ok("before".to_string()),
            Err(std::io::Error::other("connection reset")),
        ]);

        let (sink, events) = collector();
        pump(stream, sink).await;

        let seen = events.lock().unwrap();
        assert_eq!(lines_of(&seen), vec!["before"]);
        match seen.last() {
            Some(LogEvent::Failed { message }) => assert!(message.contains("connection reset")),
            other => panic!("expected a failure, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn pump_stops_when_the_receiver_goes_away() {
        // A closed view must stop the read loop, not keep draining an
        // open connection to the API server into nowhere.
        let lines: Vec<std::io::Result<String>> =
            (0..5_000).map(|i| Ok(format!("line {i}"))).collect();

        let (sink, events) = collector();
        sink.open.store(false, Ordering::Relaxed);
        pump(futures::stream::iter(lines), sink).await;

        assert!(
            events.lock().unwrap().is_empty(),
            "nothing should be recorded once the receiver has gone"
        );
    }

    #[tokio::test]
    async fn pump_does_not_send_empty_batches_while_idle() {
        // A quiet pod holds the connection open for a long time. Ticking
        // an empty batch across the boundary every interval would make
        // silence cost as much as output.
        let (tx, rx) = futures::channel::mpsc::unbounded::<std::io::Result<String>>();

        let (sink, events) = collector();
        let task = tokio::spawn(async move { pump(rx, sink).await });

        // Several intervals with nothing to say.
        tokio::time::sleep(FLUSH_INTERVAL * 4).await;
        assert!(events.lock().unwrap().is_empty(), "idle must be silent");

        tx.unbounded_send(Ok("finally".to_string())).unwrap();
        tokio::time::sleep(FLUSH_INTERVAL * 3).await;
        assert_eq!(lines_of(&events.lock().unwrap()), vec!["finally"]);

        drop(tx);
        task.await.unwrap();
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
