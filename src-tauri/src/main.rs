#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! DSH Desktop shell.
//!
//! This file owns the window: frameless chrome, drag-and-drop path forwarding,
//! and external link handoff. The dsh runtime itself — spawning it, proxying
//! `/api` past the browser-trust fence, relaying its two downstream streams —
//! lives in [`dsh`].

mod dsh;
mod plugins;
mod provider;
mod schedule;

use serde_json::json;
use std::process::Command;
use tauri::{Emitter, Manager};

/// 外链交给系统默认浏览器：webview 自身绝不跳转（会把 app 界面顶掉）。
/// 只允许 http(s)；Command 传参不经 shell，无注入面。
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    let lower = url.trim_start().to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://")) {
        return Err(format!("Refusing to open non-http(s) URL: {url}"));
    }
    Command::new("open")
        .arg(&url)
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// Bounce the Dock icon.
///
/// An agent turn runs long enough that nobody watches the window, so the shell
/// has to say when one lands. `request_user_attention` is core Tauri — no
/// notification plugin, no permission prompt, and on macOS it is exactly the
/// Dock bounce a user already reads as "that app wants you".
#[tauri::command]
fn request_attention(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.request_user_attention(Some(tauri::UserAttentionType::Informational));
    }
}

/// 选择项目文件夹。
///
/// 走系统面板而不是 `host.pickDirectory`：web profile 的那个方法直接回 `null`，
/// 因为它期待浏览器端自己用 `host.listDirectory` 画一个目录浏览器。我们是 Mac app，
/// 该出的是 Finder 的选择框。`osascript` 免掉一个 dialog 插件依赖。
#[tauri::command]
fn pick_directory() -> Result<Option<String>, String> {
    let output = Command::new("osascript")
        .arg("-e")
        .arg("POSIX path of (choose folder with prompt \"选择要加入 Projects 的文件夹\")")
        .output()
        .map_err(|error| format!("Could not open the folder picker: {error}"))?;
    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr);
        /* -128 is AppleScript's "user cancelled", which is not a failure. */
        if message.contains("-128") {
            return Ok(None);
        }
        return Err(format!("Could not choose a folder: {}", message.trim()));
    }
    let selected = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if selected.is_empty() {
        return Ok(None);
    }
    /* `choose folder` hands back a trailing slash; dsh keys workspaces on the exact
       string, so a stray slash would adopt the same directory twice. */
    Ok(Some(selected.trim_end_matches('/').to_string()))
}

/// Largest file the preview pane will load. Past this it is not a preview.
const MAX_PREVIEW_BYTES: u64 = 2 * 1024 * 1024;

/// Read one text file for the preview pane.
///
/// dsh exposes no file-read RPC — `host.*` lists directories and opens paths in
/// Finder, nothing more — so the shell reads it itself. The paths that reach
/// here are lifted out of model output, which is exactly why `roots` is a hard
/// fence rather than a hint: a path the agent invented is only ever read when it
/// canonicalizes inside a directory the user opened. Symlinks are resolved
/// before the check, so a link planted inside a root cannot point out of it.
#[tauri::command]
fn read_preview_file(roots: Vec<String>, path: String) -> Result<String, String> {
    let trimmed = path.trim();
    let requested = match trimmed.strip_prefix("~/") {
        Some(rest) => match std::env::var_os("HOME") {
            Some(home) => std::path::PathBuf::from(home).join(rest),
            None => return Err("No home directory to resolve ~/ against".to_owned()),
        },
        None => std::path::PathBuf::from(trimmed),
    };

    let allowed: Vec<std::path::PathBuf> = roots
        .iter()
        .filter_map(|root| std::path::PathBuf::from(root).canonicalize().ok())
        .collect();
    if allowed.is_empty() {
        return Err("No open folder to read this file from".to_owned());
    }

    /* A relative path is tried against every root, nearest match first. */
    let candidates: Vec<std::path::PathBuf> = if requested.is_absolute() {
        vec![requested]
    } else {
        allowed.iter().map(|root| root.join(&requested)).collect()
    };
    let target = candidates
        .into_iter()
        .filter_map(|candidate| candidate.canonicalize().ok())
        .find(|candidate| {
            candidate.is_file() && allowed.iter().any(|root| candidate.starts_with(root))
        })
        .ok_or_else(|| format!("Not a readable file inside an open folder: {trimmed}"))?;

    let size = target
        .metadata()
        .map_err(|error| format!("Cannot stat {}: {error}", target.display()))?
        .len();
    if size > MAX_PREVIEW_BYTES {
        return Err("This file is too large to preview (2 MB)".to_owned());
    }
    std::fs::read_to_string(&target).map_err(|_| format!("Not a text file: {trimmed}"))
}

fn main() {
    /* A scheduled run re-enters this same executable from launchd. It must not
       build a window: launchd starts it in the background, with no session. */
    let arguments: Vec<String> = std::env::args().collect();
    if arguments.get(1).map(String::as_str) == Some("--run-scheduled") {
        let id = arguments.get(2).cloned().unwrap_or_default();
        let manual = arguments.iter().any(|argument| argument == "--manual");
        if let Err(error) = schedule::run_worker(&id, manual) {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }

    tauri::Builder::default()
        .manage(dsh::Supervisor::default())
        .setup(|app| {
            /* 拖放进窗：dragDropEnabled=false 后 OS 级事件经 WindowEvent::DragDrop 到达，
               把真实路径转发给前端。前端只做路径文本插入——agent 自己用工具读文件。 */
            let window = app.get_webview_window("main").expect("main window exists");
            let emitter = window.clone();
            window.on_window_event(move |event| {
                let tauri::WindowEvent::DragDrop(drag) = event else {
                    return;
                };
                match drag {
                    tauri::DragDropEvent::Enter { .. } => {
                        let _ = emitter.emit("file-drag", json!({ "kind": "enter" }));
                    }
                    tauri::DragDropEvent::Drop { paths, .. } => {
                        let _ = emitter.emit("file-drag", json!({ "kind": "drop", "paths": paths }));
                    }
                    tauri::DragDropEvent::Leave => {
                        let _ = emitter.emit("file-drag", json!({ "kind": "leave" }));
                    }
                    _ => {}
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_external,
            pick_directory,
            read_preview_file,
            request_attention,
            dsh::dsh_start,
            dsh::dsh_version,
            dsh::dsh_call,
            dsh::dsh_respond,
            dsh::dsh_restart,
            dsh::dsh_attach_image,
            dsh::dsh_image_preview,
            dsh::dsh_export_session,
            plugins::dsh_plugin_list,
            plugins::dsh_plugin_add,
            plugins::dsh_plugin_remove,
            provider::probe_api_key,
            schedule::schedule_list,
            schedule::schedule_save,
            schedule::schedule_set_enabled,
            schedule::schedule_delete,
            schedule::schedule_run_now
        ])
        .build(tauri::generate_context!())
        .expect("error while building DSH")
        .run(|app, event| {
            /* The runtime is a child process, not a daemon: nothing else reaps it,
               and a leaked one holds a port plus the profile's lock. */
            if matches!(event, tauri::RunEvent::Exit) {
                app.state::<dsh::Supervisor>().shutdown();
            }
        });
}
