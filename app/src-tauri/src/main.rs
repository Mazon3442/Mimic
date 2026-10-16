// No console window behind the app in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio;
mod caelestia;
mod engines;
mod fish;
mod hw;
mod install;
mod remote;
mod store;
mod worker;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use engines::{GenRequest, Manager, Take};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use store::{Profile, Settings};
use tauri::{AppHandle, Emitter, Manager as _, RunEvent, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_updater::UpdaterExt;
use worker::Worker;

struct Dirs {
    resources: PathBuf,
    voices: PathBuf,
    takes: PathBuf,
    logs: PathBuf,
    settings: PathBuf,
    profiles: PathBuf,
}

struct App {
    dirs: Dirs,
    settings: Mutex<Settings>,
    profiles: Mutex<Vec<Profile>>,
    engines: Manager,
    stt: Mutex<Option<(String, Worker)>>,
    hw: Mutex<hw::Hardware>,
    remote: remote::Remote,
}

type Shared = Arc<App>;

impl App {
    fn paths(&self) -> engines::Paths {
        // Separate statements: each lock is released before the next one is taken.
        let home = PathBuf::from(&self.settings.lock().unwrap().engines_dir);
        let hf_token = self.settings.lock().unwrap().hf_token.clone();
        let device = self.device();
        // ROCm settings go to engines only on an AMD GPU, and never over values the user set themselves.
        let device_env = if device == "rocm" {
            self.hw.lock().unwrap().rocm_env.iter().filter(|(k, _)| std::env::var_os(k).is_none()).cloned().collect()
        } else {
            Vec::new()
        };
        engines::Paths {
            home,
            workers: self.dirs.resources.join("engines"),
            scripts: self.dirs.resources.join("scripts"),
            logs: self.dirs.logs.clone(),
            takes: self.dirs.takes.clone(),
            device,
            device_env,
            hf_token,
        }
    }

    fn device(&self) -> String {
        let setting = self.settings.lock().unwrap().device.clone();
        let hw = self.hw.lock().unwrap().clone();
        hw::resolve_device(&setting, &hw)
    }

    fn profile(&self, id: &str) -> Result<Profile, String> {
        self.profiles.lock().unwrap().iter().find(|p| p.id == id).cloned().ok_or_else(|| "That voice profile no longer exists".into())
    }

    fn put_profile(&self, p: Profile) -> Result<Profile, String> {
        let mut all = self.profiles.lock().unwrap();
        match all.iter_mut().find(|x| x.id == p.id) {
            Some(slot) => *slot = p.clone(),
            None => all.insert(0, p.clone()),
        }
        store::save(&self.dirs.profiles, &*all)?;
        Ok(p)
    }
}

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

/// Long work runs off the async runtime so the UI never waits on it.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

fn new_profile(name: &str, clip: &Path, transcript: &str, tx: &str, app: &App) -> Result<Profile, String> {
    let s = app.settings.lock().unwrap();
    let last = app.profile(&s.last_profile).ok();
    Ok(Profile {
        id: format!("p{}", now_ms()),
        name: name.to_string(),
        clip: clip.to_string_lossy().to_string(),
        duration: audio::duration(clip)?,
        transcript: transcript.to_string(),
        tx: tx.to_string(),
        defaults: last.map(|p| p.defaults).unwrap_or_default(),
        ..Default::default()
    })
}

// ---------------------------------------------------------------- commands

#[tauri::command]
fn bootstrap(handle: AppHandle, app: State<'_, Shared>) -> Value {
    // Copy everything out first: locks taken inside json!() would be held until the end of it.
    let s = app.settings.lock().unwrap().clone();
    let profiles = app.profiles.lock().unwrap().clone();
    let hardware = app.hw.lock().unwrap().clone();
    let device = app.device();
    json!({
        "settings": s,
        "profiles": profiles,
        "installed": engines::installed(Path::new(&s.engines_dir)),
        "hardware": hardware,
        "resident": app.engines.resident(),
        "logs": app.dirs.logs,
        "device": device,
        "platform": std::env::consts::OS,
        "caelestia": caelestia::read(),
        "managed": managed(Path::new(&s.engines_dir)),
        "version": handle.package_info().version.to_string(),
        "remote": false,
    })
}

#[tauri::command]
fn save_settings(app: State<'_, Shared>, settings: Settings) -> Result<Value, String> {
    store::save(&app.dirs.settings, &settings)?;
    let installed = engines::installed(Path::new(&settings.engines_dir));
    *app.settings.lock().unwrap() = settings;
    Ok(installed)
}

#[tauri::command]
fn save_profile(app: State<'_, Shared>, profile: Profile) -> Result<Profile, String> {
    app.put_profile(profile)
}

#[tauri::command]
fn delete_profile(app: State<'_, Shared>, id: String) -> Result<(), String> {
    let mut all = app.profiles.lock().unwrap();
    if let Some(p) = all.iter().find(|p| p.id == id) {
        if !p.clip.is_empty() && inside(Path::new(&p.clip), &app.dirs.voices) {
            let _ = std::fs::remove_file(&p.clip);
        }
    }
    all.retain(|p| p.id != id);
    store::save(&app.dirs.profiles, &*all)
}

#[tauri::command]
async fn import_clip(handle: AppHandle, app: State<'_, Shared>) -> Result<Option<Profile>, String> {
    let app = app.inner().clone();
    blocking(move || {
        let picked = handle
            .dialog()
            .file()
            .set_title("Import a voice clip")
            .add_filter("Audio", &["wav", "mp3", "flac", "ogg", "m4a", "aac", "opus", "wma", "mp4"])
            .blocking_pick_file();
        let Some(picked) = picked else { return Ok(None) };
        import_file(&app, &picked.into_path().map_err(|e| e.to_string())?).map(Some)
    })
    .await
}

fn import_file(app: &App, src: &Path) -> Result<Profile, String> {
    let dst = app.dirs.voices.join(format!("v{}.wav", now_ms()));
    audio::to_reference_wav(src, &dst)?;
    let name = src.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "Imported clip".into());
    let p = new_profile(&name, &dst, "", "none", app)?;
    app.put_profile(p)
}

/// Import a clip by path: files dropped on the window, and test runs.
#[tauri::command]
async fn import_path(app: State<'_, Shared>, path: String) -> Result<Profile, String> {
    let app = app.inner().clone();
    blocking(move || import_file(&app, Path::new(&path))).await
}

#[tauri::command]
async fn save_recording(app: State<'_, Shared>, wav: String, transcript: String, name: Option<String>) -> Result<Profile, String> {
    let app = app.inner().clone();
    blocking(move || {
        let raw = app.dirs.voices.join(format!("rec{}-raw.wav", now_ms()));
        std::fs::write(&raw, STANDARD.decode(wav).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let dst = raw.with_file_name(raw.file_name().unwrap().to_string_lossy().replace("-raw", ""));
        let converted = audio::to_reference_wav(&raw, &dst);
        let _ = std::fs::remove_file(&raw);
        converted?;
        let name = name.map(|n| n.trim().to_string()).filter(|n| !n.is_empty()).unwrap_or_else(|| "New voice".into());
        let p = new_profile(&name, &dst, &transcript, "read", &app)?;
        app.put_profile(p)
    })
    .await
}

fn stt_model(s: &Settings, ram_gib: f64) -> String {
    let auto = if ram_gib >= 15.0 { "small" } else { "base" };
    let size = if s.stt == "Automatic" { auto } else { s.stt.trim_end_matches(".en") };
    if s.lang == "English" { format!("{size}.en") } else { size.to_string() }
}

#[tauri::command]
async fn transcribe(app: State<'_, Shared>, id: String) -> Result<Profile, String> {
    let app = app.inner().clone();
    blocking(move || {
        let mut p = app.profile(&id)?;
        p.tx = "transcribing".into();
        app.put_profile(p.clone())?;
        let (model, lang, home) = {
            let s = app.settings.lock().unwrap();
            (stt_model(&s, app.hw.lock().unwrap().ram_total), if s.lang == "English" { "en" } else { "" }.to_string(), s.engines_dir.clone())
        };
        let result = (|| {
            let mut stt = app.stt.lock().unwrap();
            if stt.as_ref().map(|(m, _)| m != &model).unwrap_or(true) {
                *stt = None;
                let w = Worker::start(
                    &worker::venv_python(&Path::new(&home).join("stt-env")),
                    &app.dirs.resources.join("engines").join("stt_worker.py"),
                    &[model.as_str()],
                    &[],
                    &app.dirs.logs.join("stt.log"),
                    Duration::from_secs(20 * 60),
                )?;
                *stt = Some((model.clone(), w));
            }
            let (_, w) = stt.as_mut().unwrap();
            let lang_v: Value = if lang.is_empty() { Value::Null } else { lang.clone().into() };
            w.request(&json!({ "audio": p.clip, "language": lang_v }), Duration::from_secs(600))
        })();
        let mut p = app.profile(&id)?;
        match result {
            Ok(v) => {
                p.transcript = v["text"].as_str().unwrap_or("").to_string();
                p.tx = "auto".into();
                app.put_profile(p)
            }
            Err(e) => {
                *app.stt.lock().unwrap() = None;
                p.tx = "none".into();
                app.put_profile(p)?;
                Err(format!("Couldn't write the transcript: {e}"))
            }
        }
    })
    .await
}

#[tauri::command]
async fn peaks(path: String, bins: usize) -> Result<Vec<f32>, String> {
    blocking(move || audio::peaks(Path::new(&path), bins)).await
}

#[tauri::command]
async fn generate(handle: AppHandle, app: State<'_, Shared>, req: GenRequest) -> Result<Take, String> {
    let app = app.inner().clone();
    blocking(move || {
        let profile = app.profile(&req.profile_id)?;
        let paths = app.paths();
        app.engines.generate(&handle, &paths, &profile, &req)
    })
    .await
}

#[tauri::command]
fn cancel(app: State<'_, Shared>) {
    app.engines.cancel();
}

#[tauri::command]
async fn unload(handle: AppHandle, app: State<'_, Shared>) -> Result<(), String> {
    let app = app.inner().clone();
    blocking(move || {
        app.engines.unload(&handle);
        Ok(())
    })
    .await
}

#[tauri::command]
async fn preload(handle: AppHandle, app: State<'_, Shared>, engine: String) -> Result<(), String> {
    let app = app.inner().clone();
    blocking(move || app.engines.preload(&handle, &app.paths(), &engine)).await
}

/// Saved takes say in their own metadata that they're synthetic speech (WAV INFO, FLAC Vorbis comment, MP3 ID3),
/// so other software can tell. The EU AI Act asks for machine-readable marking of AI-generated audio.
const AI_MARK: [&str; 4] = ["-metadata", "comment=AI-generated speech, made with Mimic", "-metadata", "encoded_by=Mimic"];

/// Copy (WAV) or convert (FLAC/MP3) a take from the session cache to `dst`, marked as AI-generated.
fn export(src: &Path, dst: &Path) -> Result<(), String> {
    let codec: &[&str] = match dst.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("mp3") => &["-codec:a", "libmp3lame", "-q:a", "2"],
        Some("flac") => &[],
        _ => &["-codec:a", "copy"],
    };
    audio::ffmpeg(src, &[codec, &AI_MARK[..]].concat(), dst)
}

fn unique(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let mut p = dir.join(format!("{stem}.{ext}"));
    let mut n = 2;
    while p.exists() {
        p = dir.join(format!("{stem} ({n}).{ext}"));
        n += 1;
    }
    p
}

#[tauri::command]
async fn save_take(app: State<'_, Shared>, path: String, name: String) -> Result<String, String> {
    let app = app.inner().clone();
    blocking(move || {
        let (dir, fmt) = {
            let s = app.settings.lock().unwrap();
            (PathBuf::from(&s.save_dir), s.format.to_ascii_lowercase())
        };
        std::fs::create_dir_all(&dir).map_err(|e| format!("can't create {}: {e}", dir.display()))?;
        let dst = unique(&dir, &name, &fmt);
        export(Path::new(&path), &dst)?;
        Ok(dst.to_string_lossy().to_string())
    })
    .await
}

#[tauri::command]
async fn save_take_as(handle: AppHandle, app: State<'_, Shared>, path: String, name: String) -> Result<Option<String>, String> {
    let fmt = app.settings.lock().unwrap().format.to_ascii_lowercase();
    blocking(move || {
        let picked = handle
            .dialog()
            .file()
            .set_title("Save take as")
            .set_file_name(format!("{name}.{fmt}"))
            .add_filter("WAV", &["wav"])
            .add_filter("FLAC", &["flac"])
            .add_filter("MP3", &["mp3"])
            .blocking_save_file();
        let Some(picked) = picked else { return Ok(None) };
        let dst = picked.into_path().map_err(|e| e.to_string())?;
        export(Path::new(&path), &dst)?;
        Ok(Some(dst.to_string_lossy().to_string()))
    })
    .await
}

#[tauri::command]
fn delete_take(app: State<'_, Shared>, path: String) {
    if inside(Path::new(&path), &app.dirs.takes) {
        let _ = std::fs::remove_file(path);
    }
}

/// Whether `path` really is in `dir`, after resolving ".." and links (a plain prefix check would let "takes/../x" out).
fn inside(path: &Path, dir: &Path) -> bool {
    matches!((path.canonicalize(), dir.canonicalize()), (Ok(p), Ok(d)) if p.starts_with(&d))
}

#[tauri::command]
async fn pick_folder(handle: AppHandle, title: String) -> Result<Option<String>, String> {
    blocking(move || {
        Ok(handle.dialog().file().set_title(title).blocking_pick_folder().and_then(|p| p.into_path().ok()).map(|p| p.to_string_lossy().to_string()))
    })
    .await
}

#[tauri::command]
async fn install_engine(handle: AppHandle, app: State<'_, Shared>, id: String) -> Result<Value, String> {
    let app = app.inner().clone();
    blocking(move || {
        let home = PathBuf::from(&app.settings.lock().unwrap().engines_dir);
        let token = app.settings.lock().unwrap().hf_token.clone();
        install::install(Some(&handle), &home, &app.dirs.logs, &id, &app.device(), &token)?;
        Ok(json!({ "installed": engines::installed(&home), "managed": managed(&home) }))
    })
    .await
}

#[tauri::command]
async fn remove_engine(handle: AppHandle, app: State<'_, Shared>, id: String) -> Result<Value, String> {
    let app = app.inner().clone();
    blocking(move || {
        if app.engines.resident().as_deref() == Some(id.as_str()) {
            app.engines.unload(&handle);
        }
        let home = PathBuf::from(&app.settings.lock().unwrap().engines_dir);
        if !install::is_installed(&home, &id) {
            return Err("This engine wasn't downloaded by Mimic, so Mimic won't delete its files.".into());
        }
        install::remove(&home, &id)?;
        Ok(json!({ "installed": engines::installed(&home), "managed": managed(&home) }))
    })
    .await
}

/// A scripted test run, from the MIMIC_TEST environment variable (empty for normal launches).
#[tauri::command]
fn test_script() -> String {
    std::env::var("MIMIC_TEST").unwrap_or_default()
}

#[tauri::command]
fn ui_error(app: State<'_, Shared>, message: String) {
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(app.dirs.logs.join("ui.log")) {
        let _ = writeln!(f, "{} {message}", now_ms());
    }
}

/// Show a saved file in the file manager.
#[tauri::command]
fn reveal(path: String) {
    #[cfg(windows)]
    let _ = std::process::Command::new("explorer").arg(format!("/select,{path}")).spawn();
    #[cfg(unix)]
    {
        let dir = Path::new(&path).parent().map(Path::to_path_buf).unwrap_or_default();
        let _ = std::process::Command::new("xdg-open").arg(dir).spawn();
    }
}

// ---------------------------------------------------------------- remote access

#[tauri::command]
fn remote_status(app: State<'_, Shared>) -> Value {
    app.remote.status(&app)
}

#[tauri::command]
async fn remote_start(handle: AppHandle, mode: String) -> Result<Value, String> {
    blocking(move || remote::start(&handle, &mode)).await
}

#[tauri::command]
async fn remote_stop(handle: AppHandle) -> Result<Value, String> {
    blocking(move || Ok(remote::stop(&handle))).await
}

#[tauri::command]
fn remote_new_link(handle: AppHandle) -> Result<Value, String> {
    remote::new_link(&handle)
}

/// Opens one of Tailscale's pages (download, turning on HTTPS) in the browser, for the sharing setup guide.
/// Only Tailscale's sites, so the window can't be made to open anything else.
#[tauri::command]
fn open_tailscale_page(url: String) -> Result<(), String> {
    let allowed = ["https://tailscale.com/", "https://login.tailscale.com/"].iter().any(|p| url.starts_with(p));
    if !allowed || url.chars().any(|c| c.is_whitespace() || c == '"') {
        return Err("Mimic only opens Tailscale's own pages.".into());
    }
    #[cfg(windows)]
    let opened = std::process::Command::new("rundll32").args(["url.dll,FileProtocolHandler", &url]).spawn();
    #[cfg(unix)]
    let opened = std::process::Command::new("xdg-open").arg(&url).spawn();
    opened.map(|_| ()).map_err(|e| format!("couldn't open the browser: {e}"))
}

/// Runs a UI command for a browser on another device. Commands that open windows on this PC or take its file
/// paths aren't offered; remote.rs has browser versions of those (upload, download).
fn remote_call(h: &AppHandle, cmd: &str, args: Value) -> Result<Value, String> {
    use tauri::async_runtime::block_on;
    fn arg<T: serde::de::DeserializeOwned>(args: &Value, k: &str) -> Result<T, String> {
        serde_json::from_value(args.get(k).cloned().unwrap_or(Value::Null)).map_err(|e| format!("{k}: {e}"))
    }
    fn to<T: serde::Serialize>(r: Result<T, String>) -> Result<Value, String> {
        r.and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
    }
    let app = || h.state::<Shared>();
    match cmd {
        "bootstrap" => {
            let mut b = bootstrap(h.clone(), app());
            b["remote"] = true.into();
            b["settings"]["hfToken"] = "".into(); // the host's secret stays on the host
            Ok(b)
        }
        "save_settings" => {
            // Folders, the token and audio devices belong to the host PC, so a browser can't change them.
            let mut s: Settings = arg(&args, "settings")?;
            let host = app().settings.lock().unwrap().clone();
            (s.engines_dir, s.save_dir, s.hf_token, s.mic, s.output) = (host.engines_dir, host.save_dir, host.hf_token, host.mic, host.output);
            to(save_settings(app(), s))
        }
        "save_profile" => {
            // A browser edits names, transcripts and defaults, never which file is the clip: that would let it read any file here.
            let mut p: Profile = arg(&args, "profile")?;
            let host = app().profile(&p.id)?;
            (p.clip, p.builtin) = (host.clip, host.builtin);
            to(save_profile(app(), p))
        }
        "delete_profile" => to(delete_profile(app(), arg(&args, "id")?)),
        "save_recording" => to(block_on(save_recording(app(), arg(&args, "wav")?, arg(&args, "transcript")?, arg(&args, "name")?))),
        "transcribe" => to(block_on(transcribe(app(), arg(&args, "id")?))),
        "peaks" => {
            let path = remote::check_path(&app(), &arg::<String>(&args, "path")?)?;
            to(block_on(peaks(path.to_string_lossy().to_string(), arg(&args, "bins")?)))
        }
        "generate" => to(block_on(generate(h.clone(), app(), arg(&args, "req")?))),
        "cancel" => {
            cancel(app());
            Ok(Value::Null)
        }
        "unload" => to(block_on(unload(h.clone(), app()))),
        "preload" => to(block_on(preload(h.clone(), app(), arg(&args, "engine")?))),
        "delete_take" => {
            delete_take(app(), arg(&args, "path")?);
            Ok(Value::Null)
        }
        "install_engine" => to(block_on(install_engine(h.clone(), app(), arg(&args, "id")?))),
        "remove_engine" => to(block_on(remove_engine(h.clone(), app(), arg(&args, "id")?))),
        "ui_error" => {
            ui_error(app(), format!("[remote] {}", arg::<String>(&args, "message")?));
            Ok(Value::Null)
        }
        "test_script" => Ok("".into()),
        other => Err(format!("{other} only works on the PC running Mimic.")),
    }
}

/// Which engines Mimic downloaded itself (and so may delete): false, or the PyTorch build it has ("cuda", "rocm", "xpu", "cpu").
fn managed(home: &Path) -> Value {
    install::downloadable()
        .iter()
        .map(|id| {
            // Engines without PyTorch (speech-to-text) count as CPU builds.
            let v = if install::is_installed(home, id) { Value::from(install::torch_build(home, id).unwrap_or_else(|| "cpu".into())) } else { Value::from(false) };
            (id.to_string(), v)
        })
        .collect::<serde_json::Map<_, _>>()
        .into()
}

// ---------------------------------------------------------------- updates

/// The package manager that owns this install when a distro package built it (set by packaging/arch/PKGBUILD).
/// Such installs hear about new versions but get them from that package manager, not from the updater.
const PACKAGE_MANAGER: Option<&str> = option_env!("MIMIC_PACKAGE");

/// The newest GitHub release, if it's newer than this build. Development builds never offer one.
#[tauri::command]
async fn check_update(handle: AppHandle) -> Result<Option<Value>, String> {
    if cfg!(debug_assertions) {
        return Ok(None);
    }
    let update = handle.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| format!("Couldn't check for updates: {e}"))?;
    Ok(update.map(|u| json!({
        "version": u.version, "current": u.current_version, "notes": u.body.clone().unwrap_or_default(),
        "packageManager": PACKAGE_MANAGER,
    })))
}

/// Download the newest release, install it and restart into it. Progress arrives as "update-progress" events.
#[tauri::command]
async fn install_update(handle: AppHandle) -> Result<(), String> {
    if let Some(manager) = PACKAGE_MANAGER {
        return Err(format!("This copy of Mimic was installed with {manager}. Update it there."));
    }
    let update = handle
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| format!("Couldn't check for updates: {e}"))?
        .ok_or("Mimic is already up to date.")?;
    let h = handle.clone();
    let mut done = 0u64;
    update
        .download_and_install(
            move |chunk, total| {
                done += chunk as u64;
                let _ = h.emit("update-progress", json!({ "done": done, "total": total }));
            },
            || {},
        )
        .await
        .map_err(|e| format!("Couldn't install the update: {e}"))?;
    handle.restart()
}

// ---------------------------------------------------------------- setup

fn resources_dir(handle: &AppHandle) -> PathBuf {
    let bundled = handle.path().resource_dir().unwrap_or_default();
    if bundled.join("engines").join("stt_worker.py").is_file() {
        return bundled;
    }
    // Running from the repo (cargo run / tauri dev): use the source folders.
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..")
}

/// `mimic --install <engine>` downloads an engine without opening the window (used for testing and scripting).
fn cli_install(id: &str) -> ! {
    // Same folders Tauri uses: %APPDATA% / %LOCALAPPDATA% on Windows, $XDG_DATA_HOME on Linux.
    let (data, local) = if cfg!(windows) {
        (std::env::var("APPDATA").unwrap_or_default(), std::env::var("LOCALAPPDATA").unwrap_or_default())
    } else {
        let d = std::env::var("XDG_DATA_HOME").unwrap_or_else(|_| format!("{}/.local/share", std::env::var("HOME").unwrap_or_default()));
        (d.clone(), d)
    };
    let data = PathBuf::from(data).join("com.mazon.mimic");
    let logs = PathBuf::from(local).join("com.mazon.mimic").join("logs");
    let _ = std::fs::create_dir_all(&logs);
    let settings: Settings = if data.join("settings.json").is_file() { store::load(&data.join("settings.json")) } else { Settings::default() };
    let device = hw::resolve_device(&settings.device, &hw::snapshot(&mut sysinfo::System::new()));
    println!("installing {id} for {device} into {}", settings.engines_dir);
    match install::install(None, Path::new(&settings.engines_dir), &logs, id, &device, &settings.hf_token) {
        Ok(()) => {
            println!("installed {id}");
            std::process::exit(0)
        }
        Err(e) => {
            eprintln!("install failed: {e}");
            std::process::exit(1)
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if let Some(i) = args.iter().position(|a| a == "--install") {
        cli_install(args.get(i + 1).map(String::as_str).unwrap_or(""));
    }
    // WebKitGTK's DMA-BUF renderer shows a blank window with NVIDIA's Linux driver on Wayland.
    #[cfg(target_os = "linux")]
    if Path::new("/proc/driver/nvidia").exists() && std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|tauri_app| {
            let handle = tauri_app.handle().clone();
            // MIMIC_DATA_DIR gives a separate set of profiles, settings and takes (demos, screenshots, tests).
            // Keep it inside the app data folder so the audio player is allowed to read it.
            let (data, local) = match std::env::var_os("MIMIC_DATA_DIR") {
                Some(dir) => (PathBuf::from(&dir), PathBuf::from(&dir).join("local")),
                None => (handle.path().app_data_dir()?, handle.path().app_local_data_dir()?),
            };
            let dirs = Dirs {
                resources: resources_dir(&handle),
                voices: data.join("voices"),
                takes: local.join("takes"),
                logs: local.join("logs"),
                settings: data.join("settings.json"),
                profiles: data.join("profiles.json"),
            };
            // Takes from a previous session were never saved; they're cleared on start.
            let _ = std::fs::remove_dir_all(&dirs.takes);
            for d in [&dirs.voices, &dirs.takes, &dirs.logs] {
                std::fs::create_dir_all(d)?;
            }
            let settings: Settings = if dirs.settings.is_file() { store::load(&dirs.settings) } else { Settings::default() };
            let mut profiles: Vec<Profile> = store::load(&dirs.profiles);
            if profiles.is_empty() {
                profiles.push(Profile {
                    id: "bruno".into(),
                    name: "Bruno".into(),
                    builtin: "Bruno".into(),
                    tx: "none".into(),
                    defaults: store::Defaults { engine: "kitten".into(), kitten_style: "Expressive".into(), ..Default::default() },
                    ..Default::default()
                });
            }
            // Read the hardware once before the window asks, so engines aren't judged against an empty GPU.
            let mut sys = sysinfo::System::new();
            let first = hw::snapshot(&mut sys);
            let app: Shared = Arc::new(App {
                dirs,
                settings: Mutex::new(settings),
                profiles: Mutex::new(profiles),
                engines: Manager::default(),
                stt: Mutex::new(None),
                hw: Mutex::new(first),
                remote: remote::Remote::default(),
            });
            tauri_app.manage(app.clone());
            remote::Remote::init(&handle);

            // The window starts hidden so test runs can show it without taking focus from whatever the user is doing.
            if let Some(win) = handle.get_webview_window("main") {
                #[cfg(windows)]
                if std::env::var("MIMIC_TEST").is_ok() {
                    if let Ok(hwnd) = win.hwnd() {
                        unsafe { windows_sys::Win32::UI::WindowsAndMessaging::ShowWindow(hwnd.0 as _, 4) }; // SW_SHOWNOACTIVATE
                    }
                } else {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
                #[cfg(not(windows))]
                {
                    // Hyprland tiles windows and draws its own borders, so a GTK title bar would just waste space.
                    let desktop = std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default().to_lowercase();
                    if desktop.contains("hyprland") || std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE").is_some() {
                        let _ = win.set_decorations(false);
                    }
                    let _ = win.show();
                }
            }

            // Hardware every 2 s, and the idle-unload check.
            let h = handle.clone();
            std::thread::spawn(move || {
                let mut scheme_seen = caelestia::modified();
                loop {
                    let scheme_now = caelestia::modified();
                    if scheme_now != scheme_seen {
                        scheme_seen = scheme_now;
                        let _ = h.emit("caelestia", caelestia::read());
                    }
                    let snap = hw::snapshot(&mut sys);
                    *app.hw.lock().unwrap() = snap.clone();
                    let minutes = app.settings.lock().unwrap().idle_minutes();
                    app.engines.idle_check(&h, minutes);
                    let _ = h.emit("hardware", json!({
                        "hardware": snap,
                        "resident": app.engines.resident(),
                        "idleLeft": app.engines.idle_seconds_left(minutes),
                    }));
                    std::thread::sleep(Duration::from_secs(2));
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bootstrap, save_settings, save_profile, delete_profile, import_clip, save_recording, transcribe,
            peaks, generate, cancel, unload, preload, save_take, save_take_as, delete_take, pick_folder, reveal, ui_error,
            install_engine, remove_engine, test_script, import_path, check_update, install_update,
            remote_status, remote_start, remote_stop, remote_new_link, open_tailscale_page
        ])
        .build(tauri::generate_context!())
        .expect("error while building Mimic")
        .run(|handle, event| {
            if let RunEvent::Exit = event {
                if let Some(app) = handle.try_state::<Shared>() {
                    remote::stop(handle); // also takes Mimic's route out of Tailscale
                    app.engines.unload(handle);
                    *app.stt.lock().unwrap() = None;
                    let _ = std::fs::remove_dir_all(&app.dirs.takes);
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inside_resolves_dot_dot() {
        let root = std::env::temp_dir().join(format!("mimic-inside-{}", std::process::id()));
        let takes = root.join("takes");
        std::fs::create_dir_all(&takes).unwrap();
        std::fs::write(takes.join("take.wav"), b"x").unwrap();
        std::fs::write(root.join("secret.txt"), b"x").unwrap();
        assert!(inside(&takes.join("take.wav"), &takes));
        assert!(!inside(&takes.join("..").join("secret.txt"), &takes), "a prefix check would have allowed this");
        assert!(!inside(&takes.join("missing.wav"), &takes));
        let _ = std::fs::remove_dir_all(&root);
    }
}
