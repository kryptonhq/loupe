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
    match settings_path(app) {
        Ok(path) => read_from(&path),
        Err(_) => Settings::default(),
    }
}

/// Split from `load` so the fallback behaviour can be tested against a
/// real file without a Tauri app handle or the user's config directory.
pub(crate) fn read_from(path: &std::path::Path) -> Settings {
    match std::fs::read_to_string(path) {
        Ok(text) => parse(&text),
        // Missing is the first-run case and is not worth distinguishing
        // from unreadable: both mean "no preference recorded".
        Err(_) => Settings::default(),
    }
}

pub(crate) fn parse(text: &str) -> Settings {
    serde_json::from_str(text).unwrap_or_default()
}

/// Writes the settings file, creating its directory if needed.
///
/// Written to a temporary file and renamed, so an interrupted write
/// leaves the previous settings intact rather than a truncated file that
/// reads as corrupt on next launch.
pub fn save(app: &tauri::AppHandle, settings: &Settings) -> Result<()> {
    write_to(&settings_path(app)?, settings)
}

/// Split from `save` for the same reason as `read_from`: the write is
/// the part with a failure mode worth testing.
pub(crate) fn write_to(path: &std::path::Path, settings: &Settings) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| AppError::Settings(format!("create {}: {e}", dir.display())))?;
    }

    let json = serde_json::to_string_pretty(settings)
        .map_err(|e| AppError::Settings(format!("serialise settings: {e}")))?;

    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, json.as_bytes())
        .map_err(|e| AppError::Settings(format!("write {}: {e}", temp.display())))?;
    std::fs::rename(&temp, path)
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

    /// A scratch directory that removes itself, so the file tests below
    /// leave nothing behind and cannot collide with each other.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            // Nanoseconds plus the test's own name: `cargo test` runs
            // these in parallel and a shared path would flake.
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let dir = std::env::temp_dir().join(format!("loupe-settings-{tag}-{stamp}"));
            std::fs::create_dir_all(&dir).expect("create scratch dir");
            TempDir(dir)
        }

        fn join(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn settings_survive_a_write_and_a_read() {
        let dir = TempDir::new("roundtrip");
        let path = dir.join("settings.json");

        write_to(&path, &Settings { theme: Theme::Dark }).expect("write");
        assert_eq!(read_from(&path).theme, Theme::Dark);
    }

    #[test]
    fn writing_creates_the_config_directory() {
        // First run on a machine that has never opened Loupe: the
        // directory does not exist yet, and a failure here would mean
        // the preference silently never persists.
        let dir = TempDir::new("mkdir");
        let path = dir.join("nested").join("deeper").join("settings.json");

        write_to(
            &path,
            &Settings {
                theme: Theme::Light,
            },
        )
        .expect("write");
        assert!(path.exists());
        assert_eq!(read_from(&path).theme, Theme::Light);
    }

    #[test]
    fn a_second_write_replaces_the_first() {
        let dir = TempDir::new("replace");
        let path = dir.join("settings.json");

        write_to(&path, &Settings { theme: Theme::Dark }).expect("first");
        write_to(
            &path,
            &Settings {
                theme: Theme::Light,
            },
        )
        .expect("second");

        assert_eq!(read_from(&path).theme, Theme::Light);
        // The temporary file is renamed, not left behind.
        assert!(
            !path.with_extension("json.tmp").exists(),
            "the temp file should not survive a completed write"
        );
    }

    #[test]
    fn a_file_that_is_not_there_reads_as_default() {
        let dir = TempDir::new("missing");
        assert_eq!(read_from(&dir.join("nothing.json")).theme, Theme::System);
    }

    #[test]
    fn a_corrupt_file_on_disk_does_not_stop_the_app() {
        // The whole point of the fallback: a half-written or hand-edited
        // file should cost the user their preference, not their app.
        let dir = TempDir::new("corrupt");
        let path = dir.join("settings.json");
        std::fs::write(&path, b"{\"theme\": ").expect("write corrupt file");

        assert_eq!(read_from(&path).theme, Theme::System);

        // And the next save repairs it.
        write_to(&path, &Settings { theme: Theme::Dark }).expect("overwrite");
        assert_eq!(read_from(&path).theme, Theme::Dark);
    }
}
