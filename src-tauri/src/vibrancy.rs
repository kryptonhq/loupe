//! Native window translucency.
//!
//! Uses the official `window-vibrancy` crate, which drives public
//! platform APIs — `NSVisualEffectView` on macOS, the DWM backdrop on
//! Windows. There is a plugin that achieves Apple's newer Liquid Glass
//! look via `NSGlassEffectView`, but that is a private, undocumented API
//! that can break between OS releases and jeopardise App Store review,
//! so it is deliberately not used here.
//!
//! Support is decided at runtime, not compile time: Windows 10 before
//! build 17763 has no acrylic, and Linux blur depends entirely on which
//! compositor the user runs. The frontend is told what actually
//! happened rather than assuming, because a translucent stylesheet over
//! an opaque window looks broken in a very specific, ugly way.

use tauri::{Manager, WebviewWindow};

// Applies the platform's vibrancy effect to the main window, returning
// whether it took effect. A `false` is normal rather than an error —
// most Linux setups land there — and the frontend keeps its opaque
// background.
//
// Exactly one of the three below is compiled, so each is the whole
// function on its platform. Separate items rather than `cfg` blocks
// with early returns, which reads better and keeps clippy happy.

#[cfg(target_os = "macos")]
pub fn apply(window: &WebviewWindow) -> bool {
    use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};

    // `Sidebar` is the material the system itself uses for source
    // lists, which is exactly the role ours plays. `Active` keeps the
    // effect on when the window loses focus; the default "follows
    // window" state makes the whole UI visibly flatten every time the
    // user tabs to a terminal, which is distracting when you are
    // watching logs.
    apply_vibrancy(
        window,
        NSVisualEffectMaterial::Sidebar,
        Some(NSVisualEffectState::Active),
        None,
    )
    .is_ok()
}

#[cfg(target_os = "windows")]
pub fn apply(window: &WebviewWindow) -> bool {
    // Acrylic needs Windows 10 1809+. Mica would need Windows 11, so a
    // plain opaque window is the fallback rather than a second attempt.
    window_vibrancy::apply_acrylic(window, Some((18, 18, 24, 160))).is_ok()
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn apply(_window: &WebviewWindow) -> bool {
    // Linux blur is the compositor's business, not ours.
    false
}

/// Applies vibrancy to the app's main window and reports the result.
pub fn setup(app: &tauri::App) -> bool {
    match app.get_webview_window("main") {
        Some(window) => apply(&window),
        None => false,
    }
}
