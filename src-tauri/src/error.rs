//! Error type shared by every Tauri command.
//!
//! Commands must return an error that implements `Serialize`, because the
//! value crosses the IPC boundary into JavaScript. `kube::Error` does not,
//! so everything is funnelled through `AppError`, which serialises to a
//! plain `{ kind, message }` object the frontend can branch on without
//! parsing prose.

use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    /// No kubeconfig, or it could not be parsed.
    #[error("kubeconfig: {0}")]
    Kubeconfig(String),

    /// The named context does not exist in the loaded kubeconfig.
    #[error("no such context: {0}")]
    UnknownContext(String),

    /// A command needing a cluster ran before `connect`.
    #[error("not connected to a cluster")]
    NotConnected,

    /// The API server rejected or failed the request. Carries the
    /// original message so RBAC denials stay legible to the user.
    #[error("kubernetes: {0}")]
    Kube(String),
}

impl AppError {
    /// Stable machine-readable discriminant for the frontend.
    fn kind(&self) -> &'static str {
        match self {
            AppError::Kubeconfig(_) => "kubeconfig",
            AppError::UnknownContext(_) => "unknown_context",
            AppError::NotConnected => "not_connected",
            AppError::Kube(_) => "kubernetes",
        }
    }
}

impl From<kube::Error> for AppError {
    fn from(e: kube::Error) -> Self {
        AppError::Kube(e.to_string())
    }
}

impl From<kube::config::KubeconfigError> for AppError {
    fn from(e: kube::config::KubeconfigError) -> Self {
        AppError::Kubeconfig(e.to_string())
    }
}

impl From<kube::config::InferConfigError> for AppError {
    fn from(e: kube::config::InferConfigError) -> Self {
        AppError::Kubeconfig(e.to_string())
    }
}

impl Serialize for AppError {
    // Fully qualified: the `Result` alias at the bottom of this file
    // shadows the std one, and serde's signature needs S::Error.
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut st = s.serialize_struct("AppError", 2)?;
        st.serialize_field("kind", self.kind())?;
        st.serialize_field("message", &self.to_string())?;
        st.end()
    }
}

pub type Result<T> = std::result::Result<T, AppError>;
