//! Handing text the user is looking at to a file they choose.
//!
//! The dialog is opened from Rust, not from the webview, and the write
//! happens here too. That is the whole design: the frontend can say
//! "save this text, suggest this name" and nothing else. It cannot name
//! a path, cannot read one back, and gains no filesystem reach it could
//! be talked into using for something else — which matters when the
//! strings it renders come from a cluster.
//!
//! The file dialog itself is the user's consent. Nothing is written
//! anywhere until they pick a destination, and cancelling writes
//! nothing at all.

use std::path::PathBuf;

use tauri_plugin_dialog::DialogExt;

use crate::error::{AppError, Result};

/// Asks the user where to put `contents`, then writes it.
///
/// Returns the path written, or None when the user cancelled — which is
/// an ordinary outcome, not a failure, and the caller should say nothing
/// about it.
pub async fn save_text(
    app: &tauri::AppHandle,
    suggested_name: &str,
    contents: &str,
) -> Result<Option<PathBuf>> {
    // The dialog is callback-based; a oneshot turns it back into
    // something awaitable without blocking a runtime worker on it.
    let (tx, rx) = tokio::sync::oneshot::channel();

    app.dialog()
        .file()
        .set_file_name(suggested_name)
        .add_filter("Log file", &["log", "txt"])
        .save_file(move |chosen| {
            // The receiver is gone only if the app is shutting down.
            let _ = tx.send(chosen);
        });

    let chosen = rx
        .await
        .map_err(|_| AppError::Export("the save dialog closed unexpectedly".into()))?;

    let Some(path) = chosen else {
        return Ok(None);
    };

    let path = path
        .into_path()
        .map_err(|e| AppError::Export(format!("that location cannot be written to: {e}")))?;

    std::fs::write(&path, contents)
        .map_err(|e| AppError::Export(format!("write {}: {e}", path.display())))?;

    Ok(Some(path))
}
