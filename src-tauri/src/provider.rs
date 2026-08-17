//! Does this API key work?
//!
//! dsh cannot answer that. `llm.discoverModels` replies "no model discovery is
//! registered for llm-deepseek" — the DeepSeek adapter never registers one — and
//! `llm.models` serves a statically declared catalog, so both say exactly the
//! same thing for a good key and for a typo. Without an answer the app installs,
//! swallows whatever was typed, and then fails every single turn afterwards with
//! a provider error the user has no way to connect back to the box they filled in.
//!
//! So the shell asks the provider itself. This is the one place it talks to
//! anything other than 127.0.0.1, it happens only when someone is entering a key,
//! and the key goes to the service that issued it and nowhere else.

use std::sync::OnceLock;
use std::time::Duration;

/// The adapter's own default (`PUBLIC_BASE_URL` in `dsh-llm-deepseek`). Anyone
/// who has pointed the runtime at a compatible endpoint instead will fail this
/// probe, which is why the caller treats a failure as advice and still offers
/// to save the key.
const BASE_URL: &str = "https://api.deepseek.com";

/// Long enough for a cold TLS handshake on a slow link, short enough that a
/// dead network does not hold the first-run screen hostage.
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);

/// `ok` answers the question. `status` is the HTTP code behind it, so the UI can
/// tell "rejected" from "the service is having a bad day" — this module owns no
/// user-facing copy.
#[derive(serde::Serialize)]
pub struct ProbeResult {
    ok: bool,
    status: u16,
}

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(PROBE_TIMEOUT)
            .build()
            .expect("reqwest client builds with the system TLS backend")
    })
}

/// `Err` means the check could not be made at all (offline, DNS, TLS) — which is
/// not the same as a bad key, and must not be reported as one.
#[tauri::command]
pub async fn probe_api_key(key: String) -> Result<ProbeResult, String> {
    let key = key.trim().to_string();
    if key.is_empty() {
        return Err("empty key".into());
    }
    /* The OpenAI-compatible listing: the cheapest authenticated GET the provider
       offers, and it charges nothing. */
    let response = client()
        .get(format!("{BASE_URL}/models"))
        .bearer_auth(&key)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let status = response.status();
    Ok(ProbeResult {
        ok: status.is_success(),
        status: status.as_u16(),
    })
}
