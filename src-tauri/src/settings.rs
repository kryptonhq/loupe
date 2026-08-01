//! User preferences, stored as JSON beside the app's other config.
//!
//! Deliberately tiny and deliberately not in the webview's localStorage:
//! a preference the user set should survive a cache clear, and it should
//! be a file they can read, edit, or delete when something goes wrong.
//!
//! Everything here degrades to defaults rather than failing. A settings
//! file that cannot be read is a worse reason to refuse to start than
//! almost anything else the app could hit.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::error::{AppError, Result};

/// Which appearance the user asked for.
///
/// `System` is not the same as recording whatever the system currently
/// says: it means "keep following it", so a user who never chose still
/// tracks the OS when they flip it at sunset.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    #[default]
    System,
    Light,
    Dark,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub theme: Theme,
}

fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::Settings(format!("no config directory: {e}")))?;
    Ok(dir.join("settings.json"))
}

/// Reads the settings file, falling back to defaults.
///
/// A missing file is the normal first-run case. A corrupt one is not,
/// but refusing to start over it would be worse than quietly using
/// defaults — the user can always delete the file, and the next save
/// rewrites it.
pub fn load(app: &tauri::AppHandle) -> Settings {
    let Ok(path) = settings_path(app) else {
        return Settings::default();
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Settings::default();
    };
    parse(&text)
}

/// Split from `load` so the fallback behaviour can be tested without a
/// Tauri app handle or a real config directory.
pub(crate) fn parse(text: &str) -> Settings {
    serde_json::from_str(text).unwrap_or_default()
}

/// Writes the settings file, creating its directory if needed.
///
/// Written to a temporary file and renamed, so an interrupted write
/// leaves the previous settings intact rather than a truncated file that
/// reads as corrupt on next launch.
pub fn save(app: &tauri::AppHandle, settings: &Settings) -> Result<()> {
    let path = settings_path(app)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| AppError::Settings(format!("create {}: {e}", dir.display())))?;
    }

    let json = serde_json::to_string_pretty(settings)
        .map_err(|e| AppError::Settings(format!("serialise settings: {e}")))?;

    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, json.as_bytes())
        .map_err(|e| AppError::Settings(format!("write {}: {e}", temp.display())))?;
    std::fs::rename(&temp, &path)
        .map_err(|e| AppError::Settings(format!("replace {}: {e}", path.display())))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn theme_round_trips_as_a_lowercase_string() {
        // The frontend compares against these spellings; a change here
        // silently stops the preference applying.
        assert_eq!(serde_json::to_string(&Theme::Dark).unwrap(), "\"dark\"");
        assert_eq!(serde_json::to_string(&Theme::System).unwrap(), "\"system\"");
        assert_eq!(
            serde_json::from_str::<Theme>("\"light\"").unwrap(),
            Theme::Light
        );
    }

    #[test]
    fn settings_serialise_with_the_key_the_frontend_reads() {
        let json = serde_json::to_string(&Settings { theme: Theme::Dark }).unwrap();
        assert_eq!(json, r#"{"theme":"dark"}"#);
    }

    #[test]
    fn a_missing_file_reads_as_following_the_system() {
        // First run. Not an error, and not a guess at the user's taste.
        assert_eq!(Settings::default().theme, Theme::System);
    }

    #[test]
    fn a_corrupt_file_falls_back_rather_than_failing() {
        // Better to start with defaults than to refuse to open because a
        // preferences file got truncated.
        assert_eq!(parse("{not json").theme, Theme::System);
        assert_eq!(parse("").theme, Theme::System);
    }

    #[test]
    fn an_unknown_theme_falls_back_rather_than_failing() {
        // A file written by a newer build, or edited by hand.
        assert_eq!(parse(r#"{"theme":"solarized"}"#).theme, Theme::System);
    }

    #[test]
    fn a_file_missing_the_key_still_parses() {
        // `#[serde(default)]` on the struct: an older file, or one the
        // user trimmed, should not be treated as corrupt.
        assert_eq!(parse("{}").theme, Theme::System);
    }

    #[test]
    fn a_valid_file_is_honoured() {
        assert_eq!(parse(r#"{"theme":"dark"}"#).theme, Theme::Dark);
        assert_eq!(parse(r#"{"theme":"light"}"#).theme, Theme::Light);
    }
}
