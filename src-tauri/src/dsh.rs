//! dsh runtime supervisor and `/api` bridge.
//!
//! The webview cannot talk to the runtime directly. `/api` sits behind a
//! browser-trust fence that demands `Origin == Host` authority, and the
//! webview's origin is `tauri://localhost`. Measured 2026-08-15: `--trusted-host`
//! takes an authority, never a scheme, so no flag admits that origin. Requests
//! issued from here carry no `Origin` at all, which the fence accepts — so every
//! call the UI makes is relayed through this module.
//!
//! Downstream is two WebSocket downlinks, `/api/events.mux` and
//! `/api/events.host` — a plain GET on either answers 426. They are push-only
//! (a client message is a protocol violation) and carry one `server-request`
//! envelope per text message, relayed to the frontend as `dsh:frame`.
//!
//! The fence has a second tier: `credentials.*`, `settings.*` and the rest of
//! `PRIVILEGED_METHODS` are checked against an empty trust list, which pins them
//! to loopback regardless of `--trusted-host`. Sending no `Origin` satisfies both
//! tiers, so the API-key flow works through this proxy and nowhere else.

use futures_util::StreamExt;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

/// The line `dsh web` prints once the listener is bound, e.g. `dsh web: http://127.0.0.1:54149`.
const BOOT_LINE: &str = "dsh web: ";
/// Generous: a cold profile initializes itself from the bundled template on first boot.
const BOOT_TIMEOUT: Duration = Duration::from_secs(90);
/// Backoff before re-opening a downstream stream that closed on its own.
const STREAM_RETRY: Duration = Duration::from_millis(500);
/// Runtime output kept for a boot-failure report. A Node stack trace is long.
const LOG_TAIL: usize = 60;

struct Process {
    child: Child,
    base: String,
}

/// Owns the runtime child process and the generation counter that retires its streams.
#[derive(Default)]
pub struct Supervisor {
    process: Mutex<Option<Process>>,
    /// Bumped on every start. A relay task whose generation is stale exits instead
    /// of pushing frames from a runtime the UI has already forgotten.
    generation: Arc<AtomicU64>,
}

impl Supervisor {
    fn base(&self) -> Option<String> {
        let slot = self.process.lock().ok()?;
        slot.as_ref().map(|process| process.base.clone())
    }

    /// Reap the child. Idempotent — the exit hook and an explicit restart both call it.
    pub fn shutdown(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        let Ok(mut slot) = self.process.lock() else {
            return;
        };
        if let Some(mut process) = slot.take() {
            let _ = process.child.kill();
            let _ = process.child.wait();
        }
    }
}

/// Loopback only, no proxy, no timeout — a downstream stream stays open for the session.
fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .no_proxy()
            .build()
            .expect("reqwest client builds without TLS on loopback")
    })
}

/// Opaque echo token. The runtime only requires that the response mirrors it.
fn mint_rpc_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    format!("neko-{}", COUNTER.fetch_add(1, Ordering::Relaxed))
}

/// Bundled Node and the dsh entry point.
///
/// Dev reads the crate directory, where `scripts/fetch-dsh-runtime.mjs` assembles
/// both. A bundled app reads its resource directory, with the sidecar Node beside
/// the executable under its triple-stripped name.
pub fn locate(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    #[cfg(debug_assertions)]
    let (root, node) = {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let binaries = root.join("binaries");
        let node = std::fs::read_dir(&binaries)
            .map_err(|error| format!("{} is unreadable: {error}", binaries.display()))?
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("dsh-node-"))
            })
            .ok_or_else(|| format!("No dsh-node binary in {}", binaries.display()))?;
        (root, node)
    };

    #[cfg(not(debug_assertions))]
    let (root, node) = {
        let root = app
            .path()
            .resource_dir()
            .map_err(|error| format!("No resource directory: {error}"))?;
        let node = std::env::current_exe()
            .map_err(|error| format!("No executable path: {error}"))?
            .with_file_name(if cfg!(windows) { "dsh-node.exe" } else { "dsh-node" });
        (root, node)
    };

    let _ = app;
    let entry = root.join("runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js");
    if !entry.is_file() {
        return Err(format!(
            "dsh runtime is missing at {} — run `npm run runtime:fetch`",
            entry.display()
        ));
    }
    Ok((node, entry))
}

/// `$DSH_HOME` — the runtime's whole state directory, inside app data.
pub fn home_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| format!("No application data directory: {error}"))?
        .join("dsh-home"))
}

/// Vision endpoint behind `describe_image`.
///
/// DeepSeek ships no vision model, so reading an image means calling somebody
/// else. This one is keyless and OpenAI-compatible, which is the whole reason it
/// is here: the alternative every other plugin in this space takes is a second
/// API key the user has to go get. The bearer really is a URL — the endpoint
/// answers a keyless request with a 401 naming this exact string.
///
/// Measured 2026-08-16: a five-line screenshot came back correct in 4.9s.
/// It is a free third party and can go away; when it does, the Plugins panel
/// removes the plugin and the Settings card edits the endpoint, both without a
/// rebuild — which is why these are a default rather than the only option.
const VISION_BASE_URL: &str = "https://vision.anionex.me/v1";
const VISION_MODEL: &str = "gemini-3.7-flash";
const VISION_API_KEY: &str = "https://agent-vision.anionex.me";

/// The app-owned patch layer, rewritten on every start.
///
/// It lives beside the profile rather than inside it: `profiles/web/cordis.patch.yml`
/// belongs to the user, and `--patch` applies after that layer, so overwriting a
/// file we own can never clobber their overrides.
///
/// The first row turns on full-text session search. The web bundle ships
/// `openAt: never`, and its own comment names the override a deployment is expected
/// to make. Measured 2026-08-15: without this row `session.search` answers
/// `internal: session search is disabled`.
///
/// The second configures `dsh-plugin-browser-use` (seeded by `plugins.rs`, and its
/// loader id is `browser`, not the package name). Two of its defaults are wrong for
/// a desktop app. `headless: true` hides the window, and a login is something only
/// the human can perform — with no window there is no way to ever be signed in.
/// And without `storageStatePath` the cookie jar dies with the browser, so the
/// agent starts logged out of everything, every run; pointing it inside `$DSH_HOME`
/// means signing in once holds. That file holds live session cookies, which is
/// exactly why it lives in app data rather than the workspace.
///
/// The third points `@linxin666/dsh-tool-describe-image` (loader id `describe-image`)
/// at the endpoint in [`VISION_BASE_URL`]. Its three connection fields have no
/// defaults — the plugin throws on load without them — and asking a user to supply
/// a second API key to look at a screenshot is not something this app does.
///
/// Measured 2026-08-16: a row targeting an id no plugin claims logs one line and
/// carries on, so removing the plugin in the panel does not brick the boot.
fn write_overlay(home: &Path) -> Result<PathBuf, String> {
    let path = home.join("neko.patch.yml");
    /* Single-quoted YAML, so only a quote needs escaping. */
    let cookies = home
        .join("browser-state.json")
        .display()
        .to_string()
        .replace('\'', "''");
    let body = format!(
        concat!(
            "# Written by Neko on every start; edit profiles/web/cordis.patch.yml instead.\n",
            "- id: session-query-sqlite\n",
            "  config:\n",
            "    path: ':memory:'\n",
            "    openAt: first-search\n",
            "- id: browser\n",
            "  config:\n",
            "    headless: false\n",
            "    storageStatePath: '{cookies}'\n",
            "- id: describe-image\n",
            "  config:\n",
            "    baseURL: '{vision_base}'\n",
            "    model: '{vision_model}'\n",
            "    apiKey: '{vision_key}'\n",
        ),
        cookies = cookies,
        vision_base = VISION_BASE_URL,
        vision_model = VISION_MODEL,
        vision_key = VISION_API_KEY,
    );
    std::fs::write(&path, body)
        .map_err(|error| format!("Cannot write {}: {error}", path.display()))?;
    Ok(path)
}

/// Reap runtimes a previous run left behind.
///
/// `RunEvent::Exit` covers quitting the app, but not a crash or a Force Quit —
/// measured 2026-08-16: SIGTERM to the shell leaves the Node child alive, holding
/// a port and ~60MB, with nothing left to ever reap it. It reparents to launchd,
/// so `ppid == 1` identifies exactly the abandoned ones: a runtime belonging to a
/// live second window still has that window as its parent and is left alone.
///
/// Matching is on our own absolute entry path, so another dsh on this machine —
/// a terminal one, another build — is never in scope.
#[cfg(unix)]
fn sweep_orphans(entry: &Path) {
    let Some(needle) = entry.to_str() else { return };
    let Ok(output) = Command::new("ps").args(["-axo", "pid=,ppid=,command="]).output() else {
        return;
    };
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        if !line.contains(needle) {
            continue;
        }
        let mut fields = line.split_whitespace();
        let (Some(pid), Some("1")) = (fields.next(), fields.next()) else {
            continue;
        };
        /* No shell, and the pid came from ps as a bare integer. */
        let _ = Command::new("kill").arg(pid).status();
        eprintln!("[dsh] reaped orphaned runtime {pid}");
    }
}

#[cfg(not(unix))]
fn sweep_orphans(_entry: &Path) {}

/// Start the runtime and block until it reports its port.
///
/// `--port 0` because a fixed port would collide with a second copy of the app;
/// `--host 127.0.0.1` because the listener must never leave this machine.
fn spawn(node: &Path, entry: &Path, home: &Path, cwd: &Path) -> Result<(Child, String), String> {
    std::fs::create_dir_all(home)
        .map_err(|error| format!("Cannot create {}: {error}", home.display()))?;
    let overlay = write_overlay(home)?;
    sweep_orphans(entry);

    let mut command = Command::new(node);
    command
        .arg(entry)
        /* `--profile web`, not the `web` alias: the alias rejects every parent flag,
           `--patch` included. */
        .arg("--patch")
        .arg(&overlay)
        .args(["--profile", "web"])
        .args(["--host", "127.0.0.1", "--port", "0"])
        .env("DSH_HOME", home)
        /* A new session defaults to the runtime's own cwd. Left inherited, a
           bundled app would hand every session `/`. */
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|error| format!("Cannot start {}: {error}", node.display()))?;

    /* Both pipes get a reader for their whole lifetime: a full pipe would block the
       runtime mid-turn, so draining is not optional once we ask for one. */
    let stdout = child.stdout.take().ok_or("dsh stdout was not piped")?;
    let stderr = child.stderr.take().ok_or("dsh stderr was not piped")?;
    /* Kept so a boot failure can say why. A plugin that throws on import takes the
       whole tree down, and the only account of it is on the runtime's own pipes. */
    let log: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::new()));
    let (sender, receiver) = channel();
    for (pipe, is_stdout) in [
        (Box::new(stdout) as Box<dyn std::io::Read + Send>, true),
        (Box::new(stderr) as Box<dyn std::io::Read + Send>, false),
    ] {
        let log = Arc::clone(&log);
        let mut once = is_stdout.then(|| sender.clone());
        std::thread::spawn(move || {
            for line in BufReader::new(pipe).lines().map_while(Result::ok) {
                if let Some(base) = line.trim().strip_prefix(BOOT_LINE) {
                    if let Some(sender) = once.take() {
                        let _ = sender.send(base.trim().to_string());
                    }
                }
                if let Ok(mut tail) = log.lock() {
                    if tail.len() == LOG_TAIL {
                        tail.pop_front();
                    }
                    tail.push_back(line.clone());
                }
                eprintln!("[dsh] {line}");
            }
        });
    }
    /* Our own handle would keep the channel alive past both readers' EOF, turning
       a crash into a full BOOT_TIMEOUT wait. */
    drop(sender);

    match receiver.recv_timeout(BOOT_TIMEOUT) {
        Ok(base) => Ok((child, base)),
        Err(reason) => {
            let _ = child.kill();
            let _ = child.wait();
            let headline = match reason {
                // A reader drops its sender only when its pipe reaches EOF.
                RecvTimeoutError::Disconnected => "dsh 启动失败".to_owned(),
                RecvTimeoutError::Timeout => {
                    format!("dsh 在 {}s 内没有开始监听", BOOT_TIMEOUT.as_secs())
                }
            };
            let tail = log
                .lock()
                .map(|lines| lines.iter().cloned().collect::<Vec<_>>().join("\n"))
                .unwrap_or_default();
            Err(if tail.is_empty() {
                headline
            } else {
                format!("{headline}\n{tail}")
            })
        }
    }
}

/// One unary `/api` call. Transport failures surface as `Err`; a protocol-level
/// `{ ok: false, error }` is a legitimate result and rides back in `Ok`.
async fn call(base: &str, method: &str, payload: Value) -> Result<Value, String> {
    let rpc_id = mint_rpc_id();
    let response = http()
        .post(format!("{base}/api/{method}"))
        .json(&json!({
            "type": "client-request",
            "rpcId": rpc_id,
            "method": method,
            "payload": payload,
        }))
        .send()
        .await
        .map_err(|error| format!("{method}: {error}"))?;

    if !response.status().is_success() {
        return Err(format!("{method}: HTTP {}", response.status()));
    }
    let envelope: Value = response
        .json()
        .await
        .map_err(|error| format!("{method}: malformed response: {error}"))?;
    if envelope["rpcId"] != json!(rpc_id) {
        return Err(format!("{method}: rpcId mismatch"));
    }
    envelope
        .get("result")
        .cloned()
        .ok_or_else(|| format!("{method}: response carried no result"))
}

/// Decode one downlink message and hand its frame to the frontend.
fn emit_frame(app: &AppHandle, stream: &str, text: &str) {
    /* The envelope is a `server-request`; rpcId matters because answerable frames
       (approval/question) echo it back through /api/respond. */
    let Ok(envelope) = serde_json::from_str::<Value>(text) else {
        eprintln!("[dsh] dropping malformed {stream} frame");
        return;
    };
    let _ = app.emit(
        "dsh:frame",
        json!({
            "stream": stream,
            "rpcId": envelope.get("rpcId").cloned().unwrap_or(Value::Null),
            "payload": envelope.get("payload").cloned().unwrap_or(Value::Null),
        }),
    );
}

/// Read one downlink until it closes.
async fn read_stream(
    app: &AppHandle,
    url: &str,
    stream: &str,
    mine: u64,
    generation: &AtomicU64,
) -> Result<(), String> {
    let (mut socket, _) = tokio_tungstenite::connect_async(url)
        .await
        .map_err(|error| error.to_string())?;
    let _ = app.emit("dsh:stream", json!({ "stream": stream, "state": "open" }));

    while let Some(message) = socket.next().await {
        if generation.load(Ordering::SeqCst) != mine {
            return Ok(());
        }
        match message.map_err(|error| error.to_string())? {
            tokio_tungstenite::tungstenite::Message::Text(text) => emit_frame(app, stream, &text),
            tokio_tungstenite::tungstenite::Message::Close(_) => return Ok(()),
            // Binary never appears on this downlink, and ping/pong is handled below us.
            _ => {}
        }
    }
    Ok(())
}

/// Keep one downstream stream open for as long as its generation is current.
fn relay(app: AppHandle, base: String, stream: &'static str, mine: u64, generation: Arc<AtomicU64>) {
    tauri::async_runtime::spawn(async move {
        let url = format!("{}/api/events.{stream}", base.replacen("http://", "ws://", 1));
        while generation.load(Ordering::SeqCst) == mine {
            if let Err(error) = read_stream(&app, &url, stream, mine, &generation).await {
                eprintln!("[dsh] {stream} stream: {error}");
            }
            if generation.load(Ordering::SeqCst) != mine {
                return;
            }
            /* A closed stream means missed frames. The frontend re-pulls history on
               reopen — `since` is a reserved seat the runtime does not implement. */
            let _ = app.emit("dsh:stream", json!({ "stream": stream, "state": "closed" }));
            tokio::time::sleep(STREAM_RETRY).await;
        }
    });
}

/// The bundled runtime's version, read from the package we ship.
///
/// Not `host.describe`: its `version` is the hardcoded string `"0.0.1"` with an
/// upstream TODO to read apps/cli's package.json. The manifest beside the entry
/// point is the only honest source.
#[tauri::command]
pub fn dsh_version(app: AppHandle) -> Result<String, String> {
    let (_, entry) = locate(&app)?;
    /* entry is …/@deepseek-ai/dsh/lib/bin.js; the manifest sits two levels up. */
    let manifest = entry
        .parent()
        .and_then(Path::parent)
        .ok_or("dsh entry point has no package root")?
        .join("package.json");
    let text = std::fs::read_to_string(&manifest)
        .map_err(|error| format!("Cannot read {}: {error}", manifest.display()))?;
    let parsed: Value = serde_json::from_str(&text)
        .map_err(|error| format!("Cannot parse {}: {error}", manifest.display()))?;
    parsed["version"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| format!("No version field in {}", manifest.display()))
}

/// Boot the runtime (or report the one already running) and open both streams.
#[tauri::command]
pub async fn dsh_start(app: AppHandle, supervisor: State<'_, Supervisor>) -> Result<String, String> {
    if let Some(base) = supervisor.base() {
        return Ok(base);
    }
    supervisor.shutdown();

    let (node, entry) = locate(&app)?;
    let home = home_dir(&app)?;
    let cwd = app
        .path()
        .home_dir()
        .map_err(|error| format!("No home directory: {error}"))?;

    /* Before the spawn, not after: the profile's layer stack is read once at boot,
       so a plugin seeded afterwards would sit dead until the next launch. */
    let seed_handle = app.clone();
    let (child, base) = tauri::async_runtime::spawn_blocking(move || {
        crate::plugins::seed_defaults(&seed_handle);
        spawn(&node, &entry, &home, &cwd)
    })
    .await
    .map_err(|error| format!("Runtime start panicked: {error}"))??;

    let generation = supervisor.generation.fetch_add(1, Ordering::SeqCst) + 1;
    if let Ok(mut slot) = supervisor.process.lock() {
        *slot = Some(Process {
            child,
            base: base.clone(),
        });
    }

    /* Health check before the UI is told it is connected: this is also the first
       proof that the trust fence lets a proxied request through. */
    call(&base, "host.describe", json!({})).await?;

    relay(
        app.clone(),
        base.clone(),
        "mux",
        generation,
        Arc::clone(&supervisor.generation),
    );
    relay(
        app.clone(),
        base.clone(),
        "host",
        generation,
        Arc::clone(&supervisor.generation),
    );
    Ok(base)
}

/// Reap the runtime and boot a fresh one.
///
/// The profile's layer stack is read once at boot, so a plugin installed while the
/// runtime is up only takes effect on the next process.
#[tauri::command]
pub async fn dsh_restart(app: AppHandle, supervisor: State<'_, Supervisor>) -> Result<String, String> {
    supervisor.shutdown();
    dsh_start(app, supervisor).await
}

/// Relay one unary `/api` call from the UI.
#[tauri::command]
pub async fn dsh_call(
    supervisor: State<'_, Supervisor>,
    method: String,
    payload: Value,
) -> Result<Value, String> {
    let base = supervisor.base().ok_or("dsh runtime is not running")?;
    call(&base, &method, payload).await
}

/// Answer a `server-request` frame (approval, question). The rpcId is echoed, never minted.
#[tauri::command]
pub async fn dsh_respond(
    supervisor: State<'_, Supervisor>,
    rpc_id: String,
    result: Value,
) -> Result<Value, String> {
    let base = supervisor.base().ok_or("dsh runtime is not running")?;
    let response = http()
        .post(format!("{base}/api/respond"))
        .json(&json!({ "type": "client-response", "rpcId": rpc_id, "result": result }))
        .send()
        .await
        .map_err(|error| format!("respond: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("respond: HTTP {}", response.status()));
    }
    response
        .json()
        .await
        .map_err(|error| format!("respond: malformed response: {error}"))
}

/// Hand one pasted image to `describe-image` and get back the reference to send.
///
/// DeepSeek takes no image input — `session.prompt` answers `attachment-error:
/// does not support image input` and drops the turn, so an image block is not a
/// thing the shell can send. `@linxin666/dsh-tool-describe-image` answers that by
/// storing the bytes out of band and putting a short reference in the message; the
/// model then calls its `describe_image` tool, which reads the image on a vision
/// endpoint and returns text. The picture never enters the conversation.
///
/// The plugin ships that upload as a browser half injected into dsh's own React
/// UI — the UI this shell replaced — so the shell does the same POST itself.
/// Measured 2026-08-16: the route is on the shared webserver and answers a plain
/// client, so nothing about it needed their front end.
///
/// Returns the `[image attachment {…}]` note that goes into the prompt text.
/// The route also offers a short `![图片](/describe-image/raw/sha256:…)` form,
/// and this takes the long one on purpose: the plugin resolves a bare id through
/// an in-memory registry that a restart empties, while a note carries the whole
/// reference inline and reads straight from the attachment store. After a restart
/// the short form is unrecoverable; the note still has everything in it.
#[tauri::command]
pub async fn dsh_attach_image(
    supervisor: State<'_, Supervisor>,
    media_type: String,
    data: String,
    name: Option<String>,
) -> Result<String, String> {
    let base = supervisor.base().ok_or("dsh runtime is not running")?;
    let mut body = json!({ "data": data, "mediaType": media_type });
    if let Some(name) = name {
        body["name"] = Value::String(name);
    }
    let response = http()
        .post(format!("{base}/describe-image/attach"))
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("attach: {error}"))?;
    let status = response.status();
    let parsed: Value = response
        .json()
        .await
        .map_err(|error| format!("attach: malformed response: {error}"))?;
    /* The route reports its own failures in the body, so the message the user
       reads comes from there rather than from a bare status line. */
    if let Some(message) = parsed.pointer("/error/message").and_then(Value::as_str) {
        return Err(format!("attach: {message}"));
    }
    if !status.is_success() {
        return Err(format!("attach: HTTP {status}"));
    }
    parsed
        .pointer("/value/note")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| "attach: the runtime returned no image reference".to_owned())
}

/// Read a stored image back for the timeline, as a `data:` URL.
///
/// `session.attachment` cannot serve these — measured 2026-08-16, it answers
/// `ATTACHMENT_NOT_REFERENCED`, because the message carries a note rather than an
/// image block. The plugin's own route serves the bytes instead. It answers from
/// the same in-memory registry that the attach call filled, so a restart makes
/// this 404 while the note in the message stays readable; the caller shows the
/// note's own name and dimensions in that case.
#[tauri::command]
pub async fn dsh_image_preview(
    supervisor: State<'_, Supervisor>,
    attachment_id: String,
) -> Result<String, String> {
    let base = supervisor.base().ok_or("dsh runtime is not running")?;
    /* The id is `sha256:<hex>`; the colon is the one character the route wants
       left alone, and nothing else in it needs escaping. */
    let response = http()
        .get(format!("{base}/describe-image/raw/{attachment_id}"))
        .send()
        .await
        .map_err(|error| format!("image: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("image: HTTP {}", response.status()));
    }
    let media = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("image/png")
        .to_owned();
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("image: {error}"))?;
    Ok(format!("data:{media};base64,{}", base64(&bytes)))
}

/// Base64 for one image, so the webview can show it without a second server.
///
/// Hand-rolled because it is the only encoder this app needs and a crate for it
/// would be a dependency for sixteen lines.
fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let packed = u32::from(b[0]) << 16 | u32::from(b[1]) << 8 | u32::from(b[2]);
        /* A short final group encodes one symbol per byte it does have, plus a
           leading one, and pads the rest with '='. */
        let kept = chunk.len() + 1;
        for shift in [18, 12, 6, 0].into_iter().take(kept) {
            out.push(ALPHABET[(packed >> shift) as usize & 0x3f] as char);
        }
        for _ in kept..4 {
            out.push('=');
        }
    }
    out
}

/// Write the session log archive to the user's download folder.
///
/// Export is the one capability that is a plain GET instead of an RPC — the
/// runtime streams a ZIP, so it cannot ride the `client-request` envelope. It
/// goes through the same no-Origin client, which is what the trust fence wants.
#[tauri::command]
pub async fn dsh_export_session(
    app: AppHandle,
    supervisor: State<'_, Supervisor>,
    session_id: String,
) -> Result<String, String> {
    let base = supervisor.base().ok_or("dsh runtime is not running")?;
    let response = http()
        .get(format!("{base}/api/session.export"))
        .query(&[
            ("sessionId", session_id.as_str()),
            /* Subagent logs are part of the story of the turn that spawned them. */
            ("includeDescendants", "true"),
        ])
        .send()
        .await
        .map_err(|error| format!("export: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("export: HTTP {}", response.status()));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("export: {error}"))?;

    let folder = app
        .path()
        .download_dir()
        .map_err(|error| format!("No download folder: {error}"))?;
    /* Exporting the same session twice is a normal thing to do, so the second
       archive gets its own name instead of overwriting the first. */
    let stem = format!("dsh-{session_id}");
    let mut target = folder.join(format!("{stem}.zip"));
    let mut nth = 2;
    while target.exists() {
        target = folder.join(format!("{stem}-{nth}.zip"));
        nth += 1;
    }
    std::fs::write(&target, &bytes)
        .map_err(|error| format!("Cannot write {}: {error}", target.display()))?;
    Ok(target.display().to_string())
}
