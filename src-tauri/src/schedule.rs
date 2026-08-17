//! User-level scheduled tasks.
//!
//! Not to be confused with dsh's own `packages/schedule`, which is an in-session
//! reminder tool for the *model*. This is the desktop feature: "every weekday at
//! 09:00, ask the agent to do X in this folder", and it has to fire whether or
//! not the app is open. So it is launchd, the same design pi-gui shipped.
//!
//! What changed from pi-gui is only how a due task runs. pi spawned its CLI with
//! `--print`; dsh answers a one-shot task through its `headless` profile, which
//! shares `$DSH_HOME` with the app — same credentials, same settings, and the
//! run leaves a real session behind that shows up in the sidebar afterwards.
//!
//! The worker runs before Tauri starts (`--run-scheduled <id>`), so it has no
//! `AppHandle`. Every path it needs is therefore handed to it through the
//! environment by whoever launched it: the plist we write, or the app itself.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

use crate::dsh;

/// Handed to the worker so it does not have to guess where app data lives.
const HOME_VAR: &str = "DSH_HOME";
/// Handed to the worker so it can find the bundled Node and dsh entry point.
const RUNTIME_VAR: &str = "DSH_GUI_RUNTIME_DIR";
const NODE_VAR: &str = "DSH_GUI_NODE";
/// Longest a single scheduled run may take before it is killed as hung.
const RUN_TIMEOUT_SECS: u64 = 30 * 60;
/// Output kept per task for the panel. A long answer is truncated, not dropped.
const OUTPUT_LIMIT: usize = 4_000;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTask {
    id: String,
    name: String,
    prompt: String,
    cwd: String,
    /// `once` | `daily` | `weekdays` | `weekly`
    schedule_kind: String,
    /// `HH:MM`, or `YYYY-MM-DDTHH:MM` when the kind is `once`
    schedule_value: String,
    /// 1 = Monday … 7 = Sunday, only for `weekly`
    weekday: Option<u8>,
    enabled: bool,
    created_at: u64,
    updated_at: u64,
    last_run_at: Option<u64>,
    /// `running` | `completed` | `failed`
    last_status: Option<String>,
    last_output: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTaskInput {
    id: Option<String>,
    name: String,
    prompt: String,
    cwd: String,
    schedule_kind: String,
    schedule_value: String,
    weekday: Option<u8>,
    enabled: bool,
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default()
}

// ---------------------------------------------------------------- environment

/// `$DSH_HOME`, from the environment when the worker runs, from Tauri otherwise.
fn home_from_env() -> Result<PathBuf, String> {
    std::env::var_os(HOME_VAR)
        .map(PathBuf::from)
        .ok_or_else(|| format!("{HOME_VAR} is not set"))
}

/// The task file sits beside `dsh-home`, in app data — it is our state, not dsh's.
fn tasks_path(home: &Path) -> Result<PathBuf, String> {
    Ok(home
        .parent()
        .ok_or("Application data directory has no parent")?
        .join("scheduled-tasks.json"))
}

fn logs_dir(home: &Path) -> Result<PathBuf, String> {
    let dir = home
        .parent()
        .ok_or("Application data directory has no parent")?
        .join("schedule-logs");
    std::fs::create_dir_all(&dir).map_err(|error| format!("Cannot create {}: {error}", dir.display()))?;
    Ok(dir)
}

// --------------------------------------------------------------------- storage

fn read_tasks(home: &Path) -> Result<Vec<ScheduledTask>, String> {
    let path = tasks_path(home)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let source = std::fs::read_to_string(&path)
        .map_err(|error| format!("Cannot read {}: {error}", path.display()))?;
    serde_json::from_str(&source)
        .map_err(|error| format!("Invalid scheduled task data in {}: {error}", path.display()))
}

fn write_tasks(home: &Path, tasks: &[ScheduledTask]) -> Result<(), String> {
    let path = tasks_path(home)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Cannot create {}: {error}", parent.display()))?;
    }
    let body = serde_json::to_string_pretty(tasks).map_err(|error| error.to_string())?;
    std::fs::write(&path, body).map_err(|error| format!("Cannot write {}: {error}", path.display()))
}

// ------------------------------------------------------------------ validation

fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || !id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
    {
        return Err("Invalid scheduled task id".to_owned());
    }
    Ok(())
}

fn validate_schedule(kind: &str, value: &str, weekday: Option<u8>) -> Result<(), String> {
    match kind {
        "once" => {
            let at = chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M")
                .map_err(|_| "选一个有效的日期和时间".to_owned())?;
            if at <= chrono::Local::now().naive_local() {
                return Err("时间要在将来".to_owned());
            }
        }
        "daily" | "weekdays" => {
            chrono::NaiveTime::parse_from_str(value, "%H:%M").map_err(|_| "选一个有效的时间".to_owned())?;
        }
        "weekly" => {
            chrono::NaiveTime::parse_from_str(value, "%H:%M").map_err(|_| "选一个有效的时间".to_owned())?;
            if !matches!(weekday, Some(1..=7)) {
                return Err("选一个星期几".to_owned());
            }
        }
        _ => return Err("不支持的重复方式".to_owned()),
    }
    Ok(())
}

// -------------------------------------------------------------------- launchd

fn label(id: &str) -> String {
    format!("io.dsh.desktop.scheduled.{id}")
}

fn plist_path(id: &str) -> Result<PathBuf, String> {
    validate_id(id)?;
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or("Cannot determine the user home directory")?;
    Ok(home
        .join("Library")
        .join("LaunchAgents")
        .join(format!("{}.plist", label(id))))
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[cfg(target_os = "macos")]
fn launchd_domain() -> Result<String, String> {
    let output = Command::new("id")
        .arg("-u")
        .output()
        .map_err(|error| format!("Cannot determine the user id: {error}"))?;
    if !output.status.success() {
        return Err("Cannot determine the user id".to_owned());
    }
    Ok(format!("gui/{}", String::from_utf8_lossy(&output.stdout).trim()))
}

/// `StartCalendarInterval` — one dict, or an array of them for multi-day rules.
#[cfg(target_os = "macos")]
fn calendar_xml(task: &ScheduledTask) -> Result<String, String> {
    use chrono::{Datelike, Timelike};

    let entry = |weekday: Option<u8>, month: Option<u32>, day: Option<u32>, hour: u32, minute: u32| {
        let mut values = String::from("<dict>");
        if let Some(weekday) = weekday {
            values.push_str(&format!("<key>Weekday</key><integer>{weekday}</integer>"));
        }
        if let Some(month) = month {
            values.push_str(&format!("<key>Month</key><integer>{month}</integer>"));
        }
        if let Some(day) = day {
            values.push_str(&format!("<key>Day</key><integer>{day}</integer>"));
        }
        values.push_str(&format!(
            "<key>Hour</key><integer>{hour}</integer><key>Minute</key><integer>{minute}</integer></dict>"
        ));
        values
    };

    match task.schedule_kind.as_str() {
        "once" => {
            let at = chrono::NaiveDateTime::parse_from_str(&task.schedule_value, "%Y-%m-%dT%H:%M")
                .map_err(|_| "Invalid one-time schedule".to_owned())?;
            Ok(entry(None, Some(at.month()), Some(at.day()), at.hour(), at.minute()))
        }
        "daily" | "weekdays" | "weekly" => {
            let time = chrono::NaiveTime::parse_from_str(&task.schedule_value, "%H:%M")
                .map_err(|_| "Invalid schedule time".to_owned())?;
            if task.schedule_kind == "daily" {
                return Ok(entry(None, None, None, time.hour(), time.minute()));
            }
            /* launchd's Weekday is already ISO — Monday is 1, and "0 and 7 are
               Sunday" (launchd.plist(5)) — so this passes straight through.
               ⚠️ pi-gui shifted these by one, which fires a Monday task on
               Tuesday; do not port that. */
            let days: Vec<u8> = if task.schedule_kind == "weekdays" {
                vec![1, 2, 3, 4, 5]
            } else {
                let weekday = task.weekday.ok_or("Missing weekday")?;
                vec![if weekday == 7 { 0 } else { weekday }]
            };
            Ok(format!(
                "<array>{}</array>",
                days.into_iter()
                    .map(|day| entry(Some(day), None, None, time.hour(), time.minute()))
                    .collect::<String>()
            ))
        }
        _ => Err("Unsupported schedule type".to_owned()),
    }
}

#[cfg(target_os = "macos")]
fn unregister(id: &str) -> Result<(), String> {
    let plist = plist_path(id)?;
    if let Ok(domain) = launchd_domain() {
        let _ = Command::new("launchctl")
            .arg("bootout")
            .arg(&domain)
            .arg(&plist)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    if plist.exists() {
        std::fs::remove_file(&plist)
            .map_err(|error| format!("Cannot remove {}: {error}", plist.display()))?;
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn unregister(_id: &str) -> Result<(), String> {
    Ok(())
}

/// Write and load the agent. The plist carries the runtime paths so the worker,
/// which launchd starts with an empty environment, can find everything.
#[cfg(target_os = "macos")]
fn register(app: &AppHandle, task: &ScheduledTask) -> Result<(), String> {
    validate_schedule(&task.schedule_kind, &task.schedule_value, task.weekday)?;
    let (node, entry) = dsh::locate(app)?;
    let runtime = entry
        .ancestors()
        .nth(5)
        .ok_or("dsh entry point is not inside the runtime directory")?
        .to_path_buf();
    let home = dsh::home_dir(app)?;
    let logs = logs_dir(&home)?;
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let plist = plist_path(&task.id)?;
    if let Some(parent) = plist.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Cannot create {}: {error}", parent.display()))?;
    }

    let contents = format!(
        concat!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n",
            "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n",
            "<plist version=\"1.0\"><dict>\n",
            "<key>Label</key><string>{label}</string>\n",
            "<key>ProgramArguments</key><array><string>{exe}</string><string>--run-scheduled</string><string>{id}</string></array>\n",
            "<key>EnvironmentVariables</key><dict>",
            "<key>{home_var}</key><string>{home}</string>",
            "<key>{runtime_var}</key><string>{runtime}</string>",
            "<key>{node_var}</key><string>{node}</string>",
            "</dict>\n",
            "<key>StartCalendarInterval</key>{calendar}\n",
            "<key>ProcessType</key><string>Background</string>\n",
            "<key>StandardOutPath</key><string>{out}</string>\n",
            "<key>StandardErrorPath</key><string>{err}</string>\n",
            "</dict></plist>\n"
        ),
        label = xml_escape(&label(&task.id)),
        exe = xml_escape(&executable.to_string_lossy()),
        id = xml_escape(&task.id),
        home_var = HOME_VAR,
        home = xml_escape(&home.to_string_lossy()),
        runtime_var = RUNTIME_VAR,
        runtime = xml_escape(&runtime.to_string_lossy()),
        node_var = NODE_VAR,
        node = xml_escape(&node.to_string_lossy()),
        calendar = calendar_xml(task)?,
        out = xml_escape(&logs.join(format!("{}.out.log", task.id)).to_string_lossy()),
        err = xml_escape(&logs.join(format!("{}.err.log", task.id)).to_string_lossy()),
    );

    let _ = unregister(&task.id);
    std::fs::write(&plist, contents)
        .map_err(|error| format!("Cannot write {}: {error}", plist.display()))?;
    let output = Command::new("launchctl")
        .arg("bootstrap")
        .arg(launchd_domain()?)
        .arg(&plist)
        .output()
        .map_err(|error| format!("Cannot register the scheduled task: {error}"))?;
    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        let _ = std::fs::remove_file(&plist);
        return Err(format!("Cannot register the scheduled task: {message}"));
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn register(_app: &AppHandle, _task: &ScheduledTask) -> Result<(), String> {
    Err("定时任务目前只支持 macOS".to_owned())
}

// ------------------------------------------------------------------- commands

#[tauri::command]
pub fn schedule_list(app: AppHandle) -> Result<Vec<ScheduledTask>, String> {
    let mut tasks = read_tasks(&dsh::home_dir(&app)?)?;
    tasks.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(tasks)
}

#[tauri::command]
pub fn schedule_save(app: AppHandle, input: ScheduledTaskInput) -> Result<ScheduledTask, String> {
    let name = input.name.trim();
    let prompt = input.prompt.trim();
    if name.is_empty() || prompt.is_empty() {
        return Err("名字和任务内容都要填".to_owned());
    }
    if name.chars().count() > 120 || prompt.chars().count() > 50_000 {
        return Err("内容太长了".to_owned());
    }
    validate_schedule(&input.schedule_kind, &input.schedule_value, input.weekday)?;
    let cwd = PathBuf::from(input.cwd.trim())
        .canonicalize()
        .map_err(|error| format!("打不开文件夹 {}：{error}", input.cwd.trim()))?;
    if !cwd.is_dir() {
        return Err("这个路径不是文件夹".to_owned());
    }

    let home = dsh::home_dir(&app)?;
    let mut tasks = read_tasks(&home)?;
    let previous = tasks.clone();
    let now = now_millis();
    let id = input
        .id
        .unwrap_or_else(|| format!("{:x}-{:x}", now, std::process::id()));
    validate_id(&id)?;

    let existing = tasks.iter().position(|task| task.id == id);
    let task = ScheduledTask {
        id: id.clone(),
        name: name.to_owned(),
        prompt: prompt.to_owned(),
        cwd: cwd.to_string_lossy().to_string(),
        schedule_kind: input.schedule_kind,
        schedule_value: input.schedule_value,
        weekday: input.weekday,
        enabled: input.enabled,
        created_at: existing.map(|index| tasks[index].created_at).unwrap_or(now),
        updated_at: now,
        last_run_at: existing.and_then(|index| tasks[index].last_run_at),
        last_status: existing.and_then(|index| tasks[index].last_status.clone()),
        last_output: existing.and_then(|index| tasks[index].last_output.clone()),
    };
    match existing {
        Some(index) => tasks[index] = task.clone(),
        None => tasks.push(task.clone()),
    }
    write_tasks(&home, &tasks)?;

    /* launchd is the source of truth for *when*. If it refuses the rule, roll the
       file back rather than leaving a task the user believes is armed. */
    let registration = if task.enabled {
        register(&app, &task)
    } else {
        unregister(&task.id)
    };
    if let Err(error) = registration {
        let _ = write_tasks(&home, &previous);
        return Err(error);
    }
    Ok(task)
}

#[tauri::command]
pub fn schedule_set_enabled(
    app: AppHandle,
    id: String,
    enabled: bool,
) -> Result<ScheduledTask, String> {
    validate_id(&id)?;
    let home = dsh::home_dir(&app)?;
    let mut tasks = read_tasks(&home)?;
    let index = tasks
        .iter()
        .position(|task| task.id == id)
        .ok_or("找不到这个定时任务")?;
    let previous = tasks[index].clone();
    tasks[index].enabled = enabled;
    tasks[index].updated_at = now_millis();
    write_tasks(&home, &tasks)?;

    let registration = if enabled {
        register(&app, &tasks[index])
    } else {
        unregister(&id)
    };
    if let Err(error) = registration {
        tasks[index] = previous;
        let _ = write_tasks(&home, &tasks);
        return Err(error);
    }
    Ok(tasks[index].clone())
}

#[tauri::command]
pub fn schedule_delete(app: AppHandle, id: String) -> Result<(), String> {
    validate_id(&id)?;
    unregister(&id)?;
    let home = dsh::home_dir(&app)?;
    let mut tasks = read_tasks(&home)?;
    tasks.retain(|task| task.id != id);
    write_tasks(&home, &tasks)
}

/// Run one task right now, in the same detached way launchd would.
#[tauri::command]
pub fn schedule_run_now(app: AppHandle, id: String) -> Result<(), String> {
    validate_id(&id)?;
    let home = dsh::home_dir(&app)?;
    if !read_tasks(&home)?.iter().any(|task| task.id == id) {
        return Err("找不到这个定时任务".to_owned());
    }
    let (node, entry) = dsh::locate(&app)?;
    let runtime = entry
        .ancestors()
        .nth(5)
        .ok_or("dsh entry point is not inside the runtime directory")?
        .to_path_buf();

    Command::new(std::env::current_exe().map_err(|error| error.to_string())?)
        .arg("--run-scheduled")
        .arg(&id)
        .arg("--manual")
        .env(HOME_VAR, &home)
        .env(RUNTIME_VAR, &runtime)
        .env(NODE_VAR, &node)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("启动失败：{error}"))?;
    Ok(())
}

// --------------------------------------------------------------------- worker

fn truncate(value: &str, limit: usize) -> String {
    let mut output: String = value.chars().take(limit).collect();
    if value.chars().count() > limit {
        output.push_str("\n…");
    }
    output
}

/// Node + dsh entry point, from the environment the launcher set up.
fn worker_runtime() -> Result<(PathBuf, PathBuf), String> {
    let node = std::env::var_os(NODE_VAR)
        .map(PathBuf::from)
        .ok_or_else(|| format!("{NODE_VAR} is not set"))?;
    let runtime = std::env::var_os(RUNTIME_VAR)
        .map(PathBuf::from)
        .ok_or_else(|| format!("{RUNTIME_VAR} is not set"))?;
    let entry = runtime.join("node_modules/@deepseek-ai/dsh/lib/bin.js");
    if !entry.is_file() {
        return Err(format!("dsh runtime is missing at {}", entry.display()));
    }
    Ok((node, entry))
}

/// Run a due task to completion. Called from `main` before Tauri starts.
///
/// `manual` marks a run the user triggered from the panel: it ignores the
/// enabled flag and does not disarm a one-shot task afterwards.
pub fn run_worker(id: &str, manual: bool) -> Result<(), String> {
    validate_id(id)?;
    let home = home_from_env()?;
    let mut tasks = read_tasks(&home)?;
    let index = tasks
        .iter()
        .position(|task| task.id == id)
        .ok_or("Scheduled task not found")?;
    if !tasks[index].enabled && !manual {
        return Ok(());
    }

    tasks[index].last_run_at = Some(now_millis());
    tasks[index].last_status = Some("running".to_owned());
    tasks[index].last_output = None;
    write_tasks(&home, &tasks)?;
    let task = tasks[index].clone();

    let result = (|| -> Result<(bool, String), String> {
        let (node, entry) = worker_runtime()?;
        let mut child = Command::new(&node)
            .arg(&entry)
            .args(["--profile", "headless"])
            .arg(&task.prompt)
            .env(HOME_VAR, &home)
            .current_dir(&task.cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("Cannot start the dsh runtime: {error}"))?;

        /* No wait_timeout in std, so poll. A task that hangs must not leave a
           launchd job resident until the next reboot. */
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(RUN_TIMEOUT_SECS);
        loop {
            match child.try_wait().map_err(|error| error.to_string())? {
                Some(_) => break,
                None if std::time::Instant::now() >= deadline => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("任务超过 {} 分钟没结束，已中止", RUN_TIMEOUT_SECS / 60));
                }
                None => std::thread::sleep(std::time::Duration::from_millis(250)),
            }
        }

        let output = child
            .wait_with_output()
            .map_err(|error| format!("Cannot collect the run output: {error}"))?;
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        Ok((
            output.status.success(),
            if stdout.is_empty() { stderr } else { stdout },
        ))
    })();

    /* Re-read: the panel may have edited other tasks while this one ran. */
    let mut latest = read_tasks(&home)?;
    if let Some(entry) = latest.iter_mut().find(|candidate| candidate.id == id) {
        match result {
            Ok((success, text)) => {
                entry.last_status = Some(if success { "completed" } else { "failed" }.to_owned());
                entry.last_output = Some(truncate(&text, OUTPUT_LIMIT));
            }
            Err(error) => {
                entry.last_status = Some("failed".to_owned());
                entry.last_output = Some(error);
            }
        }
        entry.last_run_at = Some(now_millis());
        if entry.schedule_kind == "once" && !manual {
            entry.enabled = false;
            if let Ok(plist) = plist_path(id) {
                let _ = std::fs::remove_file(plist);
            }
        }
    }
    write_tasks(&home, &latest)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(kind: &str, value: &str, weekday: Option<u8>) -> ScheduledTask {
        ScheduledTask {
            id: "t1".to_owned(),
            name: "n".to_owned(),
            prompt: "p".to_owned(),
            cwd: "/tmp".to_owned(),
            schedule_kind: kind.to_owned(),
            schedule_value: value.to_owned(),
            weekday,
            enabled: true,
            created_at: 0,
            updated_at: 0,
            last_run_at: None,
            last_status: None,
            last_output: None,
        }
    }

    #[test]
    fn daily_is_a_single_dict() {
        let xml = calendar_xml(&task("daily", "09:05", None)).unwrap();
        assert_eq!(
            xml,
            "<dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>5</integer></dict>"
        );
    }

    #[test]
    fn weekdays_covers_monday_through_friday() {
        let xml = calendar_xml(&task("weekdays", "17:30", None)).unwrap();
        assert!(xml.starts_with("<array>"));
        assert_eq!(xml.matches("<key>Weekday</key>").count(), 5);
        assert!(xml.contains("<key>Weekday</key><integer>1</integer>"));
        assert!(xml.contains("<key>Weekday</key><integer>5</integer>"));
    }

    /// ISO Sunday is 7; launchd wants 0.
    #[test]
    fn weekly_sunday_maps_to_zero() {
        let xml = calendar_xml(&task("weekly", "08:00", Some(7))).unwrap();
        assert!(xml.contains("<key>Weekday</key><integer>0</integer>"));
    }

    #[test]
    fn once_pins_month_and_day() {
        let xml = calendar_xml(&task("once", "2030-12-24T18:45", None)).unwrap();
        assert!(xml.contains("<key>Month</key><integer>12</integer>"));
        assert!(xml.contains("<key>Day</key><integer>24</integer>"));
        assert!(xml.contains("<key>Hour</key><integer>18</integer>"));
    }

    #[test]
    fn a_past_one_shot_is_rejected() {
        assert!(validate_schedule("once", "2000-01-01T00:00", None).is_err());
    }

    #[test]
    fn ids_may_not_escape_the_launch_agents_directory() {
        assert!(validate_id("../../evil").is_err());
        assert!(validate_id("abc-123").is_ok());
    }
}
