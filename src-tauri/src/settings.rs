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

/// How many recently-used contexts to remember.
///
/// Enough to cover the handful anyone moves between in a day, short
/// enough that the recents list stays a shortlist rather than becoming a
/// second copy of the kubeconfig.
const MAX_RECENT: usize = 8;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub theme: Theme,

    /// Contexts connected to, most recent first.
    ///
    /// On a kubeconfig with thousands of entries, this is what makes the
    /// picker usable: four names are the ones anyone actually opens.
    pub recent_contexts: Vec<String>,

    /// Contexts the user pinned, in their own order. Distinct from
    /// recents because pinning is a deliberate statement and should not
    /// be pushed out by a day of connecting to something else.
    pub pinned_contexts: Vec<String>,

    /// Contexts where writes are refused outright. See `crate::guard`.
    pub read_only_contexts: Vec<String>,

    /// Contexts where a write has to be confirmed by typing the name.
    pub protected_contexts: Vec<String>,

    /// Glob patterns marking contexts protected without naming each one
    /// — `*prod*` covers six hundred clusters in one line.
    pub protected_patterns: Vec<String>,

    /// Interface scale, where 1.0 is the size the app is drawn at.
    ///
    /// An accessibility setting, so it is stored rather than reset each
    /// launch: someone who needs 150% needs it every time, and having to
    /// say so at every start is the same as not having the control.
    #[serde(default = "default_zoom")]
    pub zoom: f64,
}

/// Serde needs a function for a non-zero default, and `Default` for the
/// struct as a whole has to agree with it.
fn default_zoom() -> f64 {
    1.0
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: Theme::default(),
            recent_contexts: Vec::new(),
            pinned_contexts: Vec::new(),
            read_only_contexts: Vec::new(),
            protected_contexts: Vec::new(),
            protected_patterns: Vec::new(),
            zoom: default_zoom(),
        }
    }
}

/// What the app will render at. Anything outside this is a settings file
/// that has been edited by hand, and is clamped rather than obeyed — a
/// window drawn at 20x has no way back to the control that fixes it.
const MIN_ZOOM: f64 = 0.75;
const MAX_ZOOM: f64 = 2.0;

/// Bring a stored or requested scale into range.
pub fn clamp_zoom(zoom: f64) -> f64 {
    if !zoom.is_finite() {
        return 1.0;
    }
    zoom.clamp(MIN_ZOOM, MAX_ZOOM)
}

impl Settings {
    /// Records a connection, moving the context to the front.
    ///
    /// Deduplicates rather than appending: connecting to the same
    /// cluster twice should not fill the list with one name.
    pub fn record_recent(&mut self, context: &str) {
        self.recent_contexts.retain(|c| c != context);
        self.recent_contexts.insert(0, context.to_string());
        self.recent_contexts.truncate(MAX_RECENT);
    }

    /// Pins or unpins a context. Pinning is idempotent; a context is
    /// never listed twice.
    pub fn set_pinned(&mut self, context: &str, pinned: bool) {
        self.pinned_contexts.retain(|c| c != context);
        if pinned {
            self.pinned_contexts.push(context.to_string());
        }
    }

    /// Marks a context read-only, protected, or neither.
    ///
    /// Always removes it from both lists first, so a context can never
    /// end up in two states at once and the setting means exactly what
    /// the user last chose.
    pub fn set_guard(&mut self, context: &str, guard: crate::guard::Guard) {
        use crate::guard::Guard;
        self.read_only_contexts.retain(|c| c != context);
        self.protected_contexts.retain(|c| c != context);
        match guard {
            Guard::ReadOnly => self.read_only_contexts.push(context.to_string()),
            Guard::Protected => self.protected_contexts.push(context.to_string()),
            Guard::Open => {}
        }
    }
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
        let settings = Settings {
            theme: Theme::Dark,
            ..Default::default()
        };
        let json: serde_json::Value = serde_json::to_value(&settings).unwrap();
        assert_eq!(json["theme"], "dark");
        assert_eq!(json["recentContexts"], serde_json::json!([]));
        assert_eq!(json["pinnedContexts"], serde_json::json!([]));
    }

    #[test]
    fn zoom_defaults_to_the_size_the_app_is_drawn_at() {
        assert_eq!(Settings::default().zoom, 1.0);
        assert_eq!(
            serde_json::to_value(Settings::default()).unwrap()["zoom"],
            1.0
        );
    }

    #[test]
    fn a_settings_file_written_before_zoom_existed_reads_at_full_size() {
        // Rather than at 0, which is what a bare numeric default would
        // give and which would render the window to nothing.
        let settings: Settings = serde_json::from_str(r#"{"theme":"dark"}"#).unwrap();
        assert_eq!(settings.zoom, 1.0);
    }

    #[test]
    fn a_hand_edited_zoom_is_clamped_rather_than_obeyed() {
        // A window drawn at twenty times its size has no way back to the
        // control that would fix it.
        assert_eq!(clamp_zoom(20.0), 2.0);
        assert_eq!(clamp_zoom(0.01), 0.75);
        assert_eq!(clamp_zoom(-1.0), 0.75);
        assert_eq!(clamp_zoom(f64::NAN), 1.0);
        assert_eq!(clamp_zoom(f64::INFINITY), 1.0);
        // And a sane one is left alone.
        assert_eq!(clamp_zoom(1.25), 1.25);
    }

    #[test]
    fn a_settings_file_from_an_older_build_still_reads() {
        // The keys were added after 0.1.2 shipped. An existing file has
        // only `theme`, and must not read as corrupt.
        let settings = parse(r#"{"theme":"dark"}"#);
        assert_eq!(settings.theme, Theme::Dark);
        assert!(settings.recent_contexts.is_empty());
        assert!(settings.pinned_contexts.is_empty());
    }

    #[test]
    fn the_most_recent_context_comes_first() {
        let mut settings = Settings::default();
        settings.record_recent("staging");
        settings.record_recent("prod");
        assert_eq!(settings.recent_contexts, ["prod", "staging"]);
    }

    #[test]
    fn reconnecting_moves_a_context_up_rather_than_repeating_it() {
        // Otherwise a day of switching between two clusters fills the
        // shortlist with two names.
        let mut settings = Settings::default();
        settings.record_recent("a");
        settings.record_recent("b");
        settings.record_recent("a");
        assert_eq!(settings.recent_contexts, ["a", "b"]);
    }

    #[test]
    fn recents_stay_a_shortlist() {
        let mut settings = Settings::default();
        for i in 0..50 {
            settings.record_recent(&format!("ctx-{i}"));
        }
        assert_eq!(settings.recent_contexts.len(), MAX_RECENT);
        // The cap drops the oldest, not the newest.
        assert_eq!(settings.recent_contexts[0], "ctx-49");
    }

    #[test]
    fn pinning_is_idempotent_and_unpinning_removes() {
        let mut settings = Settings::default();
        settings.set_pinned("prod", true);
        settings.set_pinned("prod", true);
        assert_eq!(settings.pinned_contexts, ["prod"]);

        settings.set_pinned("prod", false);
        assert!(settings.pinned_contexts.is_empty());
    }

    #[test]
    fn pins_keep_the_order_they_were_added() {
        // The user's own ordering; re-sorting it would discard the only
        // thing a pin is expressing.
        let mut settings = Settings::default();
        settings.set_pinned("b", true);
        settings.set_pinned("a", true);
        assert_eq!(settings.pinned_contexts, ["b", "a"]);
    }

    #[test]
    fn a_context_is_never_in_two_guard_states_at_once() {
        use crate::guard::Guard;
        let mut settings = Settings::default();

        settings.set_guard("prod", Guard::Protected);
        settings.set_guard("prod", Guard::ReadOnly);
        assert_eq!(settings.read_only_contexts, ["prod"]);
        assert!(settings.protected_contexts.is_empty());

        settings.set_guard("prod", Guard::Open);
        assert!(settings.read_only_contexts.is_empty());
        assert!(settings.protected_contexts.is_empty());
    }

    #[test]
    fn setting_the_same_guard_twice_does_not_duplicate_it() {
        use crate::guard::Guard;
        let mut settings = Settings::default();
        settings.set_guard("prod", Guard::ReadOnly);
        settings.set_guard("prod", Guard::ReadOnly);
        assert_eq!(settings.read_only_contexts, ["prod"]);
    }

    #[test]
    fn unpinning_something_never_pinned_is_not_an_error() {
        let mut settings = Settings::default();
        settings.set_pinned("ghost", false);
        assert!(settings.pinned_contexts.is_empty());
    }

    #[test]
    fn recents_and_pins_survive_a_write_and_a_read() {
        // The shared TempDir helper below, rather than reaching for
        // `env::temp_dir` again: it fails closed on a path something
        // else already made, and cleans up even when the test panics.
        let dir = TempDir::new("contexts");
        let path = dir.join("settings.json");

        let mut settings = Settings::default();
        settings.record_recent("prod");
        settings.set_pinned("staging", true);
        write_to(&path, &settings).expect("write");

        assert_eq!(read_from(&path), settings);
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
            // Test scaffolding. `create_dir` below rather than
            // `create_dir_all` so it fails closed: the system temp
            // directory is shared, and a path something else got to
            // first should stop the test rather than be written through.
            // nosemgrep: rust.lang.security.temp-dir.temp-dir
            let dir = std::env::temp_dir().join(format!("loupe-settings-{tag}-{stamp}"));
            std::fs::create_dir(&dir).expect("create scratch dir");
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

        write_to(
            &path,
            &Settings {
                theme: Theme::Dark,
                ..Default::default()
            },
        )
        .expect("write");
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
                ..Default::default()
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

        write_to(
            &path,
            &Settings {
                theme: Theme::Dark,
                ..Default::default()
            },
        )
        .expect("first");
        write_to(
            &path,
            &Settings {
                theme: Theme::Light,
                ..Default::default()
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
        write_to(
            &path,
            &Settings {
                theme: Theme::Dark,
                ..Default::default()
            },
        )
        .expect("overwrite");
        assert_eq!(read_from(&path).theme, Theme::Dark);
    }
}
