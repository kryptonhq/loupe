//! A fake API server for tests: a `kube::Client` whose requests are
//! answered by a closure instead of a cluster.
//!
//! What it is for is the thin layer between a decision and the wire —
//! which URL, which query, which headers, what a 403 turns into. The
//! decisions themselves are tested directly; this proves they are asked
//! of the API server the way they are meant to be.

use std::sync::{Arc, Mutex};

use http::{Request, Response, StatusCode};
use kube::client::Body;

/// One request as the fake saw it.
#[derive(Debug, Clone)]
pub struct Seen {
    pub path: String,
    pub query: String,
    pub accept: String,
}

pub type Handler = dyn Fn(&Seen) -> (StatusCode, serde_json::Value) + Send + Sync;

/// A client backed by `handler`, and the log of every request it served.
pub fn client(
    handler: impl Fn(&Seen) -> (StatusCode, serde_json::Value) + Send + Sync + 'static,
) -> (kube::Client, Arc<Mutex<Vec<Seen>>>) {
    let log = Arc::new(Mutex::new(Vec::new()));
    let handler: Arc<Handler> = Arc::new(handler);
    let service = {
        let log = log.clone();
        tower::service_fn(move |req: Request<Body>| {
            let seen = Seen {
                path: req.uri().path().to_string(),
                query: req.uri().query().unwrap_or("").to_string(),
                accept: req
                    .headers()
                    .get(http::header::ACCEPT)
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("")
                    .to_string(),
            };
            log.lock().unwrap().push(seen.clone());
            let (status, body) = handler(&seen);
            async move {
                Ok::<_, std::convert::Infallible>(
                    Response::builder()
                        .status(status)
                        .header(http::header::CONTENT_TYPE, "application/json")
                        .body(Body::from(serde_json::to_vec(&body).unwrap()))
                        .unwrap(),
                )
            }
        })
    };
    (kube::Client::new(service, "default"), log)
}

/// The body the API server sends with a refusal.
pub fn status(code: u16, reason: &str) -> (StatusCode, serde_json::Value) {
    (
        StatusCode::from_u16(code).unwrap(),
        serde_json::json!({
            "kind": "Status", "apiVersion": "v1", "status": "Failure",
            "code": code, "reason": reason, "message": format!("{reason} by the fake")
        }),
    )
}
