//! Gives the app the environment the user's terminal has.
//!
//! An app started from the Dock, Finder or Spotlight is launched by
//! launchd, and inherits launchd's environment rather than the user's
//! shell's: PATH is `/usr/bin:/bin:/usr/sbin:/sbin`, and nothing set in
//! `.zprofile` or `.zshrc` exists. That matters more than it sounds.
//! Kubeconfigs for EKS, GKE and AKS authenticate by running a credential
//! plugin — `aws`, `gke-gcloud-auth-plugin`, `kubelogin` — named without
//! a path, and installed to Homebrew's prefix or `~/.local/bin`. kubectl
//! in a terminal finds it; Loupe from the Dock failed every connect with
//! "unable to run auth exec: No such file or directory". The same gap
//! hides `KUBECONFIG`, `AWS_PROFILE` and `AWS_REGION` when they are set
//! in the shell, so a plugin that is found can still pick the wrong
//! account.
//!
//! The fix is the one terminal-adjacent GUI apps settle on: ask the
//! user's own login shell for its environment once, at startup, and
//! adopt it. Anything the process was actually given wins over the shell,
//! except PATH, which is merged — the shell's entries first, so a
//! credential plugin resolves to the same binary it does for kubectl.
//!
//! Runs before Tauri starts any threads: `set_var` is only sound while
//! nothing else can be reading the environment.

use std::collections::HashSet;
use std::ffi::OsString;
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Bracket the environment dump, because an interactive shell may print
/// anything before it — a greeting, a prompt theme's escape codes, a
/// "last login" line — and none of it is ours to parse.
const START: &str = "__LOUPE_ENV_START__";
const END: &str = "__LOUPE_ENV_END__";

/// Long enough for a heavy `.zshrc` (nvm, conda, oh-my-zsh) to finish,
/// short enough that a shell stuck on a prompt costs a slow launch rather
/// than a hung one.
const TIMEOUT: Duration = Duration::from_secs(5);

/// Variables that describe the throwaway shell rather than the user.
const IGNORED: &[&str] = &["_", "PWD", "OLDPWD", "SHLVL", "TERM", "PS1", "PS2"];

/// Where credential plugins are commonly installed. Appended when they
/// exist and are missing, so a shell that could not be asked still leaves
/// the usual suspects reachable.
fn well_known_dirs(home: Option<PathBuf>) -> Vec<PathBuf> {
    let mut dirs = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/opt/homebrew/sbin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/local/sbin"),
    ];
    if let Some(home) = home {
        dirs.push(home.join(".local/bin"));
        dirs.push(home.join("bin"));
    }
    dirs
}

/// Adopts the login shell's environment. Never fails: at worst the app
/// keeps the environment it was started with, plus the well-known dirs.
#[cfg(unix)]
pub fn inherit() {
    let shell_env = match read_login_shell_env() {
        Ok(vars) => vars,
        Err(e) => {
            eprintln!("[loupe] could not read the login shell's environment: {e}");
            Vec::new()
        }
    };

    let mut shell_path = None;
    for (key, value) in shell_env {
        if key == "PATH" {
            shell_path = Some(value);
        } else if !IGNORED.contains(&key.as_str()) && std::env::var_os(&key).is_none() {
            std::env::set_var(key, value);
        }
    }

    let current = std::env::var("PATH").unwrap_or_default();
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let extra: Vec<PathBuf> = well_known_dirs(home)
        .into_iter()
        .filter(|d| d.is_dir())
        .collect();
    std::env::set_var("PATH", merge_path(shell_path.as_deref(), &current, &extra));
}

#[cfg(not(unix))]
pub fn inherit() {}

#[cfg(unix)]
fn read_login_shell_env() -> Result<Vec<(String, String)>, String> {
    let shell = std::env::var_os("SHELL")
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| OsString::from("/bin/zsh"));

    // `-l` for .zprofile / .profile, `-i` for .zshrc / .bashrc — PATH
    // is set in either depending on who wrote the dotfiles. `env` by
    // absolute path, so a shell function or alias named `env` cannot
    // change what comes back, and `-0` so values with newlines survive.
    let script = format!("printf '{START}'; /usr/bin/env -0; printf '{END}'");
    let mut child = Command::new(&shell)
        .args(["-l", "-i", "-c", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("{}: {e}", shell.to_string_lossy()))?;

    // Read on another thread so a shell that fills the pipe and then
    // waits cannot deadlock the timeout below.
    let mut stdout = child.stdout.take().ok_or("no stdout")?;
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        buf
    });

    let deadline = Instant::now() + TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("timed out after {}s", TIMEOUT.as_secs()));
            }
            Err(e) => return Err(e.to_string()),
        }
    }

    let out = reader.join().map_err(|_| "reader panicked")?;
    parse_env(&out).ok_or_else(|| "no environment in the shell's output".into())
}

/// Pulls `KEY=VALUE` pairs out of the NUL-separated dump between the
/// markers. `None` when the markers are missing, which means the shell
/// never ran the script — not that the environment is empty.
fn parse_env(out: &[u8]) -> Option<Vec<(String, String)>> {
    let text = String::from_utf8_lossy(out);
    let start = text.find(START)? + START.len();
    let end = start + text[start..].find(END)?;
    Some(
        text[start..end]
            .split('\0')
            .filter_map(|entry| {
                let (k, v) = entry.split_once('=')?;
                (!k.is_empty()).then(|| (k.to_string(), v.to_string()))
            })
            .collect(),
    )
}

/// The shell's PATH, then whatever the process already had, then the
/// well-known dirs — each directory once, first occurrence wins.
fn merge_path(shell: Option<&str>, current: &str, extra: &[PathBuf]) -> String {
    let mut seen = HashSet::new();
    let extra = extra.iter().filter_map(|p| p.to_str());
    shell
        .into_iter()
        .flat_map(|p| p.split(':'))
        .chain(current.split(':'))
        .chain(extra)
        .filter(|d| !d.is_empty() && seen.insert(d.to_string()))
        .collect::<Vec<_>>()
        .join(":")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_between_markers_ignoring_shell_noise() {
        let out = format!(
            "\x1b]7;file://host\x07Last login: today\n{START}PATH=/opt/homebrew/bin:/usr/bin\0AWS_PROFILE=prod\0MULTI=a\nb\0{END}% "
        );
        let vars = parse_env(out.as_bytes()).unwrap();
        assert_eq!(
            vars,
            vec![
                ("PATH".into(), "/opt/homebrew/bin:/usr/bin".into()),
                ("AWS_PROFILE".into(), "prod".into()),
                ("MULTI".into(), "a\nb".into()),
            ]
        );
    }

    #[test]
    fn keeps_equals_signs_in_values() {
        let out = format!("{START}OPTS=a=b=c\0{END}");
        assert_eq!(
            parse_env(out.as_bytes()).unwrap(),
            vec![("OPTS".into(), "a=b=c".into())]
        );
    }

    #[test]
    fn missing_markers_is_not_an_empty_environment() {
        assert!(parse_env(b"zsh: command not found").is_none());
        assert!(parse_env(format!("{START}PATH=/bin\0").as_bytes()).is_none());
    }

    #[test]
    fn shell_path_comes_first_and_nothing_repeats() {
        let merged = merge_path(
            Some("/Users/me/.local/bin:/opt/homebrew/bin:/usr/bin"),
            "/usr/bin:/bin:/usr/sbin:/sbin",
            &[
                PathBuf::from("/opt/homebrew/bin"),
                PathBuf::from("/usr/local/bin"),
            ],
        );
        assert_eq!(
            merged,
            "/Users/me/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin"
        );
    }

    #[test]
    fn without_a_shell_the_launchd_path_still_gains_the_usual_dirs() {
        let merged = merge_path(None, "/usr/bin:/bin", &[PathBuf::from("/usr/local/bin")]);
        assert_eq!(merged, "/usr/bin:/bin:/usr/local/bin");
    }

    #[cfg(unix)]
    #[test]
    fn reads_a_real_login_shell() {
        // The shell this test runs under; proves the flags and markers
        // survive a real startup, not just the parser.
        let vars = read_login_shell_env().expect("login shell env");
        assert!(vars.iter().any(|(k, v)| k == "PATH" && !v.is_empty()));
    }
}
