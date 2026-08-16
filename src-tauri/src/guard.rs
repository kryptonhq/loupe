//! Per-context safeguards against changing the wrong cluster.
//!
//! Every context was treated identically: a local kind cluster and a
//! production EKS cluster sat next to each other in the picker, looked
//! the same, and accepted the same edits. The only thing between a user
//! and a production mistake was noticing the context name in the
//! sidebar. That is tolerable in a read-only tool and not tolerable in
//! one with a delete button.
//!
//! RBAC is not the answer here. Plenty of operators legitimately hold
//! write permission on production and still do not want a stray click to
//! use it. The safeguard people want is local, per-context, and under
//! their own control — the client-side equivalent of a red border round
//! the production window.
//!
//! The check lives in Rust, not in the UI. Hiding a button is a courtesy
//! to the user; refusing the write is the actual guarantee, and it is
//! the one that still holds if a view forgets to ask.

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::settings::Settings;

/// What a context allows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Guard {
    /// No safeguard. What every context does today, and the default, so
    /// nothing changes for anyone who has not asked for this.
    #[default]
    Open,
    /// Writes are allowed but must be confirmed by typing the context
    /// name. The UI enforces the typing; this is the record that it
    /// should.
    Protected,
    /// Writes are refused outright. Reading is unaffected.
    ReadOnly,
}

impl Guard {
    pub fn allows_writes(self) -> bool {
        self != Guard::ReadOnly
    }
}

/// Matches a context name against a pattern where `*` stands for any run
/// of characters.
///
/// Deliberately not a regex: the patterns are typed into a settings
/// field to catch `*prod*` or `*-production`, and a regex there is a
/// sharper tool than the job needs — one that fails in ways that would
/// silently *stop* protecting a cluster.
pub fn matches_pattern(pattern: &str, name: &str) -> bool {
    let parts: Vec<&str> = pattern.split('*').collect();

    // No `*` at all: the pattern has to be the whole name. Anchoring
    // both ends is deliberate — a pattern that quietly matched more than
    // it said would protect clusters the user never named, and one that
    // matches too little is obvious the first time it is used.
    if parts.len() == 1 {
        return pattern == name;
    }

    let first = parts[0];
    let last = parts[parts.len() - 1];
    if !name.starts_with(first) || !name.ends_with(last) {
        return false;
    }
    // The head and tail must not overlap; `a*a` needs two of them.
    if name.len() < first.len() + last.len() {
        return false;
    }

    // Every segment between them, in order, somewhere in the middle.
    // `starts_with`/`ends_with` guarantee these are char boundaries.
    let mut middle = &name[first.len()..name.len() - last.len()];
    for part in &parts[1..parts.len() - 1] {
        match middle.find(part) {
            Some(at) => middle = &middle[at + part.len()..],
            None => return false,
        }
    }
    true
}

/// The guard in force for a context.
///
/// An explicit mark always wins over a pattern, so a user can exempt one
/// cluster from a broad rule without rewriting the rule. Between the two
/// marks, read-only wins: when a context is somehow both, the safer
/// reading is the right one.
pub fn guard_for(settings: &Settings, context: &str) -> Guard {
    if settings.read_only_contexts.iter().any(|c| c == context) {
        return Guard::ReadOnly;
    }
    if settings.protected_contexts.iter().any(|c| c == context) {
        return Guard::Protected;
    }
    if settings
        .protected_patterns
        .iter()
        .any(|p| matches_pattern(p, context))
    {
        return Guard::Protected;
    }
    Guard::Open
}

/// Refuses a write to a read-only context.
///
/// Called from the command layer, before anything leaves the machine.
pub fn ensure_writable(settings: &Settings, context: &str) -> Result<()> {
    if guard_for(settings, context).allows_writes() {
        return Ok(());
    }
    Err(AppError::ReadOnly(format!(
        "{context} is marked read-only in Loupe. Nothing was sent to the cluster."
    )))
}

/// Refuses a write for whichever context a session is on.
///
/// Lives here rather than in the command layer so it can be tested: the
/// commands are thin wrappers that need a Tauri app handle and a
/// cluster, and this is the one decision among them worth covering.
///
/// A session with nothing connected is allowed through deliberately —
/// the operation itself reports "not connected", and it has a better
/// error for that than this does.
pub fn ensure_session_writable(
    settings: &Settings,
    info: Option<&crate::cluster::ClusterInfo>,
) -> Result<()> {
    match info {
        Some(info) => ensure_writable(settings, &info.context),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(read_only: &[&str], protected: &[&str], patterns: &[&str]) -> Settings {
        Settings {
            read_only_contexts: read_only.iter().map(|s| s.to_string()).collect(),
            protected_contexts: protected.iter().map(|s| s.to_string()).collect(),
            protected_patterns: patterns.iter().map(|s| s.to_string()).collect(),
            ..Default::default()
        }
    }

    #[test]
    fn an_unmarked_context_is_unchanged() {
        // The default has to stay exactly what it was, or this feature
        // breaks every existing user's app on upgrade.
        assert_eq!(guard_for(&Settings::default(), "anything"), Guard::Open);
        assert!(ensure_writable(&Settings::default(), "anything").is_ok());
    }

    #[test]
    fn a_read_only_context_refuses_writes() {
        let s = settings(&["prod"], &[], &[]);
        assert_eq!(guard_for(&s, "prod"), Guard::ReadOnly);

        let err = ensure_writable(&s, "prod").unwrap_err();
        // The message has to say nothing was sent. "Failed" alone leaves
        // the user wondering whether half of it landed.
        assert!(err.to_string().contains("Nothing was sent"));
    }

    #[test]
    fn a_protected_context_still_allows_writes() {
        // Protection is a confirmation step, not a refusal; the backend
        // must not block what the UI is about to confirm.
        let s = settings(&[], &["prod"], &[]);
        assert_eq!(guard_for(&s, "prod"), Guard::Protected);
        assert!(ensure_writable(&s, "prod").is_ok());
    }

    #[test]
    fn read_only_wins_when_a_context_is_marked_both() {
        let s = settings(&["prod"], &["prod"], &[]);
        assert_eq!(guard_for(&s, "prod"), Guard::ReadOnly);
    }

    fn connected(context: &str) -> crate::cluster::ClusterInfo {
        crate::cluster::ClusterInfo {
            context: context.to_string(),
            server: "https://example:6443".into(),
            version: "v1.33.1".into(),
            platform: "linux/arm64".into(),
        }
    }

    #[test]
    fn a_session_on_a_read_only_context_refuses_writes() {
        let s = settings(&["prod"], &[], &[]);
        let err = ensure_session_writable(&s, Some(&connected("prod"))).unwrap_err();
        assert!(err.to_string().contains("Nothing was sent"));
    }

    #[test]
    fn a_session_on_an_unmarked_context_writes_freely() {
        let s = settings(&["prod"], &[], &[]);
        assert!(ensure_session_writable(&s, Some(&connected("staging"))).is_ok());
    }

    #[test]
    fn a_session_with_nothing_connected_is_left_to_the_operation() {
        // "Not connected" is a better error than "read-only", and the
        // operation itself has it. Refusing here would replace a precise
        // message with a misleading one.
        let s = settings(&["prod"], &[], &[]);
        assert!(ensure_session_writable(&s, None).is_ok());
    }

    #[test]
    fn a_pattern_protects_without_naming_every_cluster() {
        // The point of patterns: six hundred contexts, one rule.
        let s = settings(&[], &[], &["*prod*"]);
        assert_eq!(guard_for(&s, "eks-prod-eu"), Guard::Protected);
        assert_eq!(guard_for(&s, "eks-staging-eu"), Guard::Open);
    }

    #[test]
    fn an_explicit_mark_beats_a_pattern() {
        // Exempting one cluster from a broad rule must not mean
        // rewriting the rule.
        let s = settings(&["prod-locked"], &[], &["*prod*"]);
        assert_eq!(guard_for(&s, "prod-locked"), Guard::ReadOnly);
    }
}

#[cfg(test)]
mod pattern_tests {
    use super::matches_pattern;

    #[test]
    fn a_pattern_without_a_star_is_an_exact_match() {
        assert!(matches_pattern("prod", "prod"));
        assert!(!matches_pattern("prod", "prod-eu"));
        assert!(!matches_pattern("prod", "eks-prod"));
    }

    #[test]
    fn a_trailing_star_matches_a_prefix() {
        assert!(matches_pattern("prod*", "prod"));
        assert!(matches_pattern("prod*", "prod-eu-west-1"));
        assert!(!matches_pattern("prod*", "eks-prod"));
    }

    #[test]
    fn a_leading_star_matches_a_suffix() {
        assert!(matches_pattern("*-production", "eks-production"));
        assert!(matches_pattern("*-production", "a-b-c-production"));
        assert!(!matches_pattern("*-production", "production-canary"));
    }

    #[test]
    fn stars_at_both_ends_match_anywhere() {
        assert!(matches_pattern("*prod*", "prod"));
        assert!(matches_pattern("*prod*", "eks-prod-eu"));
        assert!(!matches_pattern("*prod*", "staging"));
    }

    #[test]
    fn a_bare_star_matches_everything() {
        assert!(matches_pattern("*", ""));
        assert!(matches_pattern("*", "whatever"));
    }

    #[test]
    fn segments_must_appear_in_order() {
        assert!(matches_pattern("a*b*c", "a-b-c"));
        assert!(!matches_pattern("a*b*c", "a-c-b"));
    }

    #[test]
    fn an_empty_pattern_matches_only_an_empty_name() {
        // A pattern that matched everything would silently protect the
        // whole kubeconfig, which is the wrong direction to fail in but
        // still not what was asked for.
        assert!(matches_pattern("", ""));
        assert!(!matches_pattern("", "prod"));
    }

    #[test]
    fn matching_is_case_sensitive_like_context_names() {
        // Kubernetes context names are case sensitive, so pretending
        // otherwise here would protect clusters the user did not name.
        assert!(!matches_pattern("*prod*", "PROD-eu"));
    }
}
