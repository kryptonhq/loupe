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

    /// The cluster does not serve the requested kind. Distinct from a
    /// generic API failure because the fix is different: the CRD is not
    /// installed, rather than the request being wrong.
    #[error("{0}")]
    UnknownResource(String),

    /// The edited YAML cannot be applied as written. Everything this
    /// covers is caught before the request leaves the machine.
    #[error("{0}")]
    InvalidEdit(String),

    /// The object changed in the cluster since it was loaded into the
    /// editor. Its own kind because the only useful response is to
    /// reload and re-apply, and the UI can offer exactly that.
    #[error("{0}")]
    Conflict(String),

    /// Preferences could not be read or written. Never fatal: the app
    /// falls back to defaults and says so rather than refusing to start.
    #[error("settings: {0}")]
    Settings(String),

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
            AppError::UnknownResource(_) => "unknown_resource",
            AppError::InvalidEdit(_) => "invalid_edit",
            AppError::Conflict(_) => "conflict",
            AppError::Settings(_) => "settings",
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

#[cfg(test)]
mod tests {
    use super::*;

    fn serialised(e: AppError) -> serde_json::Value {
        serde_json::to_value(e).expect("errors must serialise; the IPC boundary requires it")
    }

    #[test]
    fn every_error_crosses_the_boundary_as_kind_and_message() {
        // The frontend branches on `kind` and shows `message`. Anything
        // else — a bare string, a tagged enum — silently breaks both.
        let value = serialised(AppError::NotConnected);
        assert_eq!(value["kind"], "not_connected");
        assert_eq!(value["message"], "not connected to a cluster");
        assert_eq!(
            value.as_object().map(|o| o.len()),
            Some(2),
            "exactly two fields: {value}"
        );
    }

    #[test]
    fn the_discriminants_match_what_the_frontend_compares_against() {
        // These strings are a contract with src/lib/api.ts. Renaming one
        // here is a silent behaviour change over there — `isConflict`
        // stops matching and the editor loses its reload-and-retry path.
        let cases = [
            (AppError::Kubeconfig("x".into()), "kubeconfig"),
            (AppError::UnknownContext("x".into()), "unknown_context"),
            (AppError::NotConnected, "not_connected"),
            (AppError::UnknownResource("x".into()), "unknown_resource"),
            (AppError::InvalidEdit("x".into()), "invalid_edit"),
            (AppError::Conflict("x".into()), "conflict"),
            (AppError::Settings("x".into()), "settings"),
            (AppError::Kube("x".into()), "kubernetes"),
        ];

        for (error, expected) in cases {
            assert_eq!(serialised(error)["kind"], expected);
        }
    }

    #[test]
    fn an_rbac_denial_keeps_the_servers_own_wording() {
        // "forbidden: User cannot list pods in namespace prod" is the
        // whole answer. Replacing it with a generic "request failed"
        // turns a solvable permissions problem into a mystery.
        let message = "pods is forbidden: User \"dev\" cannot list resource \"pods\"";
        let value = serialised(AppError::Kube(message.into()));
        assert!(
            value["message"].as_str().unwrap().contains(message),
            "got {value}"
        );
    }

    #[test]
    fn a_conflict_carries_its_message_unprefixed() {
        // The editor shows this text directly next to a "Discard &
        // reload" button, so a prefix like "kubernetes: " would read as
        // noise in the one place the wording was written for the user.
        let value = serialised(AppError::Conflict(
            "the object was changed in the cluster".into(),
        ));
        assert_eq!(value["message"], "the object was changed in the cluster");
    }

    #[test]
    fn context_and_settings_errors_say_what_went_wrong() {
        assert_eq!(
            AppError::UnknownContext("staging".into()).to_string(),
            "no such context: staging"
        );
        // Prefixed, because this one surfaces in a log rather than in a
        // dialog written for the user.
        assert_eq!(
            AppError::Settings("disk full".into()).to_string(),
            "settings: disk full"
        );
    }

    #[test]
    fn a_kube_error_converts_rather_than_being_stringified_at_the_call_site() {
        // `?` on a kube::Error has to land on the Kube variant. If the
        // From impl were missing, every call site would need its own
        // map_err and one of them would eventually get it wrong.
        let err: AppError = kube::Error::LinesCodecMaxLineLengthExceeded.into();
        assert!(matches!(err, AppError::Kube(_)));
        assert_eq!(serialised(err)["kind"], "kubernetes");
    }
}
