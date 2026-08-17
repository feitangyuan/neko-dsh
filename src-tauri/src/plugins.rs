//! Profile plugin management.
//!
//! dsh has no `/api` method for plugins — `dsh plugin --profile web <pnpm args>`
//! is a CLI-only path that forwards to pnpm inside the profile directory and then
//! reconciles `dsh.profile.bundles` against what pnpm actually installed. So this
//! module drives the same CLI out of process instead of going through the bridge.
//!
//! Two things the forwarder needs that a bundled app does not have:
//! `spawnSync("pnpm", …)` resolves through `PATH`, and pnpm's own launcher is a
//! `#!/usr/bin/env node` script. Both are satisfied by a shim directory written
//! into `$DSH_HOME` and prepended to `PATH` — rewritten on every call, so a moved
//! app bundle heals itself the way the runtime's own module fallback does.

use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::AppHandle;

use crate::dsh;

/// The only profile this app boots.
const PROFILE: &str = "web";

/// Plugins a fresh profile is seeded with, installed once before the first boot.
///
/// Pinned, never a range. The dsh plugin registry is days old and its packages
/// move several times a day; `dsh-plugin-vetting@0.5.1` shipped a syntax error on
/// 2026-08-16 that took the whole runtime down on import, which is the failure
/// mode a floating range hands to a user who has shipped nothing.
///
/// Three, each closing a gap the runtime leaves open. Everything else in the
/// registry was either UI-only, wired to a shell we do not ship, or needed a
/// terminal; the ones that were measured and rejected are named below.
///
/// - `dsh-better-edit` replaces the built-in read/edit pair with hash-anchored
///   ones: `read` prefixes every line with a 3-char hash and `edit` addresses
///   lines by that hash, so a stale anchor is rejected instead of fuzzily matched
///   into the wrong place.
/// - `dsh-plugin-browser-use` drives a real Chromium: navigate, click, fill, read
///   text, screenshot. Every URL is re-checked against the host allowlist before
///   each action and after each navigation lands, so a redirect cannot walk out of
///   the fence. Configured in `dsh.rs::write_overlay`, including the cookie jar
///   that makes a login survive to the next run.
///   Rejected in its favour: `dsh-pilot@0.1.0`, whose accessibility-ref tools read
///   better on paper but break `ctx.tools` outright — measured 2026-08-16, with it
///   in the profile *every* tool call in *every* session dies with
///   `Cannot read properties of undefined (reading 'prepare')`. Boot looks clean,
///   which is what makes it dangerous. Do not add it back without first
///   re-measuring a plain edit in a session that has it loaded.
/// - `@linxin666/dsh-tool-describe-image` is the eye. DeepSeek's models take no
///   images, so an attached one fails the turn outright; this stores the bytes
///   out of band and gives the model a `describe_image` tool that reads them on a
///   vision endpoint and returns text. The picture never enters the conversation,
///   which is why it works on a text-only model at all. Endpoint configured in
///   `dsh.rs::write_overlay`; the shell does the upload itself in
///   `dsh::dsh_attach_image`, because the plugin ships that half as an injection
///   into dsh's own React UI — the UI this shell replaced.
///
///   Measured 2026-08-16 through this shell, on the plain DeepSeek route: a
///   pasted screenshot came back transcribed, all five lines correct.
///
///   Rejected in its favour: `@aalongaa/dsh-tool-vision`, inert until the user
///   pastes a paid key; `@anionex/dsh-vision-toolkit`, which needs Python 3.11+;
///   `dsh-vision-proxy` and `dsh-vision-recognizer`, which need a local Ollama.
///   And `dsh-vision-router@1.4.4`, seeded here until 2026-08-16 and now removed:
///   its local tools (`vision_colors`, `vision_crop`, `vision_pixel_diff`) always
///   answer, but the two that matter do not. Its keyless free chain returned 429
///   on both attempts half an hour apart, and `vision_ocr` cannot work at all —
///   it feeds tesseract through `execFile`'s nonexistent `input` option, so the
///   child's stdin is never written or closed and the call hangs until its own
///   timeout kills it (reproduced: SIGTERM at 12s, with a real tesseract present).
///   With both installed the model also picked the broken route over this one.
const SEEDED: &[&str] = &[
    "dsh-better-edit@0.2.0",
    "dsh-plugin-browser-use@0.3.1",
    "@linxin666/dsh-tool-describe-image@0.1.19",
];

/// Specs already seeded, one per line. Written only after a successful install.
///
/// Presence — not the profile's own dependency list — is what stops a reinstall,
/// so a plugin the user removed in the panel stays removed.
fn seed_marker(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(dsh::home_dir(app)?.join("neko-seeded.txt"))
}

/// Install anything in `SEEDED` this profile has never been offered.
///
/// Best effort by design: it runs before the runtime starts, and a registry that
/// is unreachable on first launch must cost the user a plugin, not the app. An
/// unrecorded spec is simply retried on the next launch.
pub fn seed_defaults(app: &AppHandle) {
    let Ok(marker) = seed_marker(app) else { return };
    let seeded = std::fs::read_to_string(&marker).unwrap_or_default();
    let pending: Vec<&str> = SEEDED
        .iter()
        .copied()
        .filter(|spec| !seeded.lines().any(|line| line.trim() == *spec))
        .collect();
    if pending.is_empty() {
        return;
    }

    let mut args = vec!["add"];
    args.extend_from_slice(&pending);
    if let Err(error) = run(app, &args) {
        eprintln!("[dsh] could not seed default plugins: {error}");
        return;
    }
    let recorded = format!("{seeded}{}\n", pending.join("\n"));
    if let Err(error) = std::fs::write(&marker, recorded) {
        eprintln!("[dsh] could not record seeded plugins: {error}");
    }
}

/// One entry of the profile's plugin list.
#[derive(Serialize)]
pub struct PluginInfo {
    name: String,
    version: String,
    description: String,
    /// In `dsh.profile.bundles` — it contributes a layer to the composed tree.
    active: bool,
    /// A profile dependency, i.e. installed here rather than shipped in the app.
    removable: bool,
}

fn profile_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(dsh::home_dir(app)?.join("profiles").join(PROFILE))
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// Package metadata, looked up where each installer puts it.
///
/// pnpm runs with the profile directory as cwd, so a user-installed plugin lands
/// in `profiles/web/node_modules`. The app's own runtime packages are reached
/// through the symlink farm one level up, which dsh heals on every boot.
fn manifest_of(profile: &Path, name: &str) -> Option<Value> {
    let local = profile.join("node_modules").join(name).join("package.json");
    let shared = profile
        .parent()?
        .join("node_modules")
        .join(name)
        .join("package.json");
    read_json(&local).or_else(|| read_json(&shared))
}

/// Every plugin the profile carries: the app's own layers plus anything installed.
#[tauri::command]
pub fn dsh_plugin_list(app: AppHandle) -> Result<Vec<PluginInfo>, String> {
    let profile = profile_dir(&app)?;
    let manifest = profile.join("package.json");
    /* A profile that has never booted has no manifest yet; that is an empty list,
       not a failure. */
    let Some(parsed) = read_json(&manifest) else {
        return Ok(Vec::new());
    };

    let bundles: Vec<String> = parsed["dsh"]["profile"]["bundles"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|item| item.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    let dependencies: Vec<String> = parsed["dependencies"]
        .as_object()
        .map(|map| map.keys().cloned().collect())
        .unwrap_or_default();

    let mut names = bundles.clone();
    for name in &dependencies {
        if !names.contains(name) {
            names.push(name.clone());
        }
    }

    Ok(names
        .into_iter()
        .map(|name| {
            let package = manifest_of(&profile, &name);
            PluginInfo {
                version: package
                    .as_ref()
                    .and_then(|value| value["version"].as_str())
                    .unwrap_or_default()
                    .to_owned(),
                description: package
                    .as_ref()
                    .and_then(|value| value["description"].as_str())
                    .unwrap_or_default()
                    .to_owned(),
                active: bundles.contains(&name),
                removable: dependencies.contains(&name),
                name,
            }
        })
        .collect())
}

/// Write the `node` + `pnpm` shims the CLI's pnpm forwarder resolves through.
///
/// Returned so the caller can prepend it to `PATH`.
#[cfg(unix)]
fn shim_dir(app: &AppHandle, node: &Path) -> Result<PathBuf, String> {
    use std::os::unix::fs::PermissionsExt;

    let (_, entry) = dsh::locate(app)?;
    /* entry is <runtime>/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js — six levels
       up is <runtime>, where the pnpm bundle sits beside the dsh one. */
    let pnpm = entry
        .ancestors()
        .nth(6)
        .ok_or("dsh entry point is not inside the runtime directory")?
        .join("pnpm/node_modules/pnpm/bin/pnpm.cjs");
    if !pnpm.is_file() {
        return Err(format!("Bundled pnpm is missing at {}", pnpm.display()));
    }

    let dir = dsh::home_dir(app)?.join("bin");
    std::fs::create_dir_all(&dir).map_err(|error| format!("Cannot create {}: {error}", dir.display()))?;

    let link = dir.join("node");
    let _ = std::fs::remove_file(&link);
    std::os::unix::fs::symlink(node, &link)
        .map_err(|error| format!("Cannot link {}: {error}", link.display()))?;

    let script = dir.join("pnpm");
    let body = format!(
        "#!/bin/sh\n# Written by DSH Desktop.\nexec {} {} \"$@\"\n",
        shell_quote(node),
        shell_quote(&pnpm)
    );
    std::fs::write(&script, body)
        .map_err(|error| format!("Cannot write {}: {error}", script.display()))?;
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755))
        .map_err(|error| format!("Cannot mark {} executable: {error}", script.display()))?;
    Ok(dir)
}

#[cfg(not(unix))]
fn shim_dir(_app: &AppHandle, _node: &Path) -> Result<PathBuf, String> {
    Err("Plugin installation is not implemented on this platform".to_owned())
}

#[cfg(unix)]
fn shell_quote(path: &Path) -> String {
    format!("'{}'", path.display().to_string().replace('\'', "'\\''"))
}

/// Run one `dsh plugin` invocation and return its combined output.
fn run(app: &AppHandle, args: &[&str]) -> Result<String, String> {
    let (node, entry) = dsh::locate(app)?;
    let home = dsh::home_dir(app)?;
    let shims = shim_dir(app, &node)?;
    let path = match std::env::var_os("PATH") {
        Some(current) => format!("{}:{}", shims.display(), current.to_string_lossy()),
        None => shims.display().to_string(),
    };

    let output = Command::new(&node)
        .arg(&entry)
        .args(["plugin", "--profile", PROFILE])
        .args(args)
        .env("DSH_HOME", &home)
        .env("PATH", path)
        .current_dir(&home)
        .output()
        .map_err(|error| format!("Cannot start {}: {error}", node.display()))?;

    let log = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    if output.status.success() {
        Ok(log)
    } else {
        Err(if log.trim().is_empty() {
            format!("dsh plugin exited with {}", output.status)
        } else {
            log
        })
    }
}

/// Install a plugin. `spec` is a pnpm spec — a registry name, optionally versioned.
#[tauri::command]
pub async fn dsh_plugin_add(app: AppHandle, spec: String) -> Result<String, String> {
    let spec = spec.trim().to_owned();
    if spec.is_empty() {
        return Err("Plugin name is empty".to_owned());
    }
    /* A flag here would reach pnpm verbatim, so nothing that looks like one runs. */
    if spec.starts_with('-') {
        return Err(format!("Not a package name: {spec}"));
    }
    tauri::async_runtime::spawn_blocking(move || run(&app, &["add", &spec]))
        .await
        .map_err(|error| format!("Plugin install panicked: {error}"))?
}

/// Remove an installed plugin by package name.
#[tauri::command]
pub async fn dsh_plugin_remove(app: AppHandle, name: String) -> Result<String, String> {
    let name = name.trim().to_owned();
    if name.is_empty() || name.starts_with('-') {
        return Err(format!("Not a package name: {name}"));
    }
    tauri::async_runtime::spawn_blocking(move || run(&app, &["remove", &name]))
        .await
        .map_err(|error| format!("Plugin removal panicked: {error}"))?
}
