//! The engine manager. Only one engine is resident at a time: loading one unloads the other first,
//! because the big engines don't fit in 16 GB together.

use crate::audio;
use crate::fish;
use crate::store::Profile;
use crate::worker::Worker;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

const LOAD_TIMEOUT: Duration = Duration::from_secs(20 * 60); // first load may download weights
const GEN_TIMEOUT: Duration = Duration::from_secs(10 * 60);

pub struct Paths {
    /// Engines folder: venvs and model files (Settings -> Engines folder).
    pub home: PathBuf,
    /// Worker scripts shipped with the app.
    pub workers: PathBuf,
    /// WSL scripts shipped with the app.
    pub scripts: PathBuf,
    pub logs: PathBuf,
    pub takes: PathBuf,
    /// Where models run: "cuda", "rocm" (AMD GPU), "xpu" (Intel GPU) or "cpu". Workers get the PyTorch device as MIMIC_DEVICE.
    pub device: String,
    /// Extra environment for the engine on this device (ROCm's GPU choice and compatibility target).
    pub device_env: Vec<(String, String)>,
    pub hf_token: String,
}

impl Paths {
    fn python(&self, env: &str) -> PathBuf {
        crate::worker::venv_python(&self.home.join(env))
    }
}

/// Which engines can run on this machine, judged from the files on disk.
pub fn installed(home: &Path) -> Value {
    let py = |env: &str| crate::worker::venv_python(&home.join(env)).is_file();
    let mut v = json!({
        "kitten": py("kitten-env") && home.join("models").join("kitten-tts-2").join("config.json").is_file(),
        "breeze": py("breeze-env") && home.join("models").join("breeze-tts-2").is_dir() && home.join("breeze-tts").is_dir(),
        // Fish runs as a vLLM server inside WSL, so it's a Windows-only engine for now.
        "fish": cfg!(windows) && Path::new(r"C:\Windows\System32\wsl.exe").is_file(),
        "stt": py("stt-env"),
    });
    for id in crate::install::downloadable() {
        if !v[*id].as_bool().unwrap_or(false) {
            v[*id] = crate::install::is_installed(home, id).into();
        }
    }
    v
}

enum Resident {
    Py(Worker),
    Fish(fish::Server),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenRequest {
    pub engine: String,
    pub profile_id: String,
    pub text: String,
    #[serde(default)]
    pub kitten_style: String,
    #[serde(default)]
    pub breeze_mode: String,
    #[serde(default)]
    pub instruction: String,
    #[serde(default)]
    pub seed: i64,
    /// Controls panel values the user changed. "speed" is applied here; the rest go to the engine.
    #[serde(default)]
    pub controls: BTreeMap<String, f64>,
}

#[derive(Serialize)]
pub struct Take {
    pub path: String,
    pub seconds: f64,
    pub elapsed: f64,
}

#[derive(Default)]
pub struct Manager {
    slot: Mutex<Option<(String, Resident)>>,
    killer: Mutex<Option<Arc<Mutex<Child>>>>,
    last_used: Mutex<Option<Instant>>,
    cancelled: AtomicBool,
    busy: AtomicBool,
    pub kitten_voices: Mutex<Vec<String>>,
}

fn emit(app: &AppHandle, id: &str, state: &str) {
    let _ = app.emit("engine", json!({ "id": id, "state": state }));
}

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

impl Manager {
    pub fn resident(&self) -> Option<String> {
        self.slot.try_lock().ok().and_then(|s| s.as_ref().map(|(id, _)| id.clone()))
    }

    fn load(&self, paths: &Paths, engine: &str) -> Result<Resident, String> {
        let home = paths.home.to_string_lossy().to_string();
        let mut envs = vec![
            ("TTS_HOME", home.clone()),
            ("MIMIC_DEVICE", crate::hw::torch_device(&paths.device).to_string()),
            ("HF_HUB_DISABLE_SYMLINKS_WARNING", "1".to_string()),
            ("HF_TOKEN", paths.hf_token.clone()),
        ];
        envs.extend(paths.device_env.iter().map(|(k, v)| (k.as_str(), v.clone())));
        let start_py = |env: &str, script: &str, args: &[&str]| {
            Worker::start(&paths.python(env), &paths.workers.join(script), args, &envs, &paths.logs.join(format!("{engine}.log")), LOAD_TIMEOUT)
        };
        match engine {
            "kitten" => {
                let w = start_py("kitten-env", "kitten_worker.py", &[])?;
                if let Some(v) = w.hello["voices"].as_array() {
                    *self.kitten_voices.lock().unwrap() = v.iter().filter_map(|x| x.as_str().map(String::from)).collect();
                }
                Ok(Resident::Py(w))
            }
            "breeze" => Ok(Resident::Py(start_py("breeze-env", "breeze_worker.py", &[])?)),
            "qwen06" | "qwen17" | "chatterbox" | "voxcpm" | "audio8" => {
                let env = crate::install::env_for(engine).unwrap();
                let model = crate::install::model_dir(&paths.home, engine).unwrap().to_string_lossy().to_string();
                let script = if engine.starts_with("qwen") { "qwen_worker.py".to_string() } else { format!("{engine}_worker.py") };
                Ok(Resident::Py(start_py(env, &script, &[model.as_str()])?))
            }
            "neutts" => Ok(Resident::Py(start_py("neutts-env", "neutts_worker.py", &[])?)),
            "fish" if cfg!(windows) => Ok(Resident::Fish(fish::Server::start(&paths.scripts, &paths.logs.join("fish.log"))?)),
            other => Err(format!("{other} isn't available in this version of Mimic yet")),
        }
    }

    /// Make `engine` the resident one, unloading whatever was there.
    fn ensure(&self, app: &AppHandle, paths: &Paths, slot: &mut Option<(String, Resident)>, engine: &str) -> Result<(), String> {
        if let Some((id, _)) = slot.as_ref() {
            if id == engine {
                return Ok(());
            }
            let old = id.clone();
            emit(app, &old, "unloading");
            *slot = None; // Drop kills the worker / stops the server
            *self.killer.lock().unwrap() = None;
            emit(app, &old, "cold");
        }
        emit(app, engine, "loading");
        match self.load(paths, engine) {
            Ok(r) => {
                *self.killer.lock().unwrap() = Some(match &r {
                    Resident::Py(w) => w.killer(),
                    Resident::Fish(s) => s.killer(),
                });
                // A worker that was asked for a GPU but couldn't use it says so; the UI explains the fix.
                if let Resident::Py(w) = &r {
                    if w.hello["fallback"].is_object() {
                        let _ = app.emit("fallback", json!({ "id": engine, "fallback": w.hello["fallback"] }));
                    }
                }
                *slot = Some((engine.to_string(), r));
                *self.last_used.lock().unwrap() = Some(Instant::now());
                emit(app, engine, "warm");
                Ok(())
            }
            Err(e) => {
                emit(app, engine, "cold");
                Err(format!("Couldn't load {engine}: {e}"))
            }
        }
    }

    pub fn preload(&self, app: &AppHandle, paths: &Paths, engine: &str) -> Result<(), String> {
        let mut slot = self.slot.lock().unwrap();
        self.ensure(app, paths, &mut slot, engine)
    }

    pub fn generate(&self, app: &AppHandle, paths: &Paths, profile: &Profile, req: &GenRequest) -> Result<Take, String> {
        let needs_ref = !(req.engine == "breeze" && req.breeze_mode == "Design");
        if needs_ref && profile.builtin.is_empty() && profile.duration < 3.0 {
            return Err(format!("{}'s clip is under 3 seconds", profile.name));
        }
        let clip = Path::new(&profile.clip);
        if needs_ref && profile.builtin.is_empty() {
            if !clip.is_file() {
                return Err(format!("{}'s clip is missing ({})", profile.name, profile.clip));
            }
            if !matches!(req.engine.as_str(), "kitten" | "chatterbox") && profile.transcript.trim().is_empty() {
                return Err(format!("{} needs the clip's transcript first", req.engine));
            }
        }
        if !profile.builtin.is_empty() && req.engine != "kitten" {
            return Err(format!("{} is a built-in Kitten voice", profile.name));
        }

        self.cancelled.store(false, Ordering::SeqCst);
        self.busy.store(true, Ordering::SeqCst);
        let started = Instant::now();
        let mut slot = self.slot.lock().unwrap();
        let result = (|| {
            self.ensure(app, paths, &mut slot, &req.engine)?;
            emit(app, &req.engine, "generating");
            let out = paths.takes.join(format!("take-{}.wav", now_ms()));
            let out_s = out.to_string_lossy().to_string();
            let res = match &mut slot.as_mut().unwrap().1 {
                Resident::Py(w) => {
                    let mut request = match req.engine.as_str() {
                        "kitten" => {
                            let mut r = json!({ "text": req.text, "output": out_s, "seed": req.seed,
                                                "expressive": req.kitten_style == "Expressive" });
                            if profile.builtin.is_empty() { r["reference"] = profile.clip.clone().into(); } else { r["voice"] = profile.builtin.clone().into(); }
                            r
                        }
                        "breeze" => {
                            let mut r = json!({ "text": req.text, "output": out_s, "seed": req.seed });
                            if req.breeze_mode != "Clone" { r["instruction"] = req.instruction.clone().into(); }
                            if req.breeze_mode != "Design" {
                                r["ref_audio"] = profile.clip.clone().into();
                                r["ref_text"] = profile.transcript.clone().into();
                            }
                            r
                        }
                        _ => json!({ "text": req.text, "output": out_s, "seed": req.seed, "language": "English",
                                     "ref_audio": profile.clip, "ref_text": profile.transcript }),
                    };
                    let sampling: BTreeMap<_, _> = req.controls.iter().filter(|(k, _)| k.as_str() != "speed").collect();
                    request["controls"] = json!(sampling);
                    w.request(&request, GEN_TIMEOUT).map(|_| ())
                }
                Resident::Fish(s) => s.generate(&req.text, Some((clip, profile.transcript.as_str())), &out),
            };
            let res = res.and_then(|()| audio::set_speed(&out, req.controls.get("speed").copied().unwrap_or(1.0)));
            match res {
                Ok(()) => {
                    emit(app, &req.engine, "warm");
                    Ok(Take { seconds: audio::duration(&out).unwrap_or(0.0), path: out_s, elapsed: started.elapsed().as_secs_f64() })
                }
                Err(e) => {
                    let dead = self.cancelled.load(Ordering::SeqCst) || e.contains("stopped") || e.contains("didn't answer");
                    if dead {
                        *slot = None;
                        *self.killer.lock().unwrap() = None;
                        emit(app, &req.engine, "cold");
                    } else {
                        emit(app, &req.engine, "warm");
                    }
                    Err(if self.cancelled.load(Ordering::SeqCst) { "Cancelled".to_string() } else { e })
                }
            }
        })();
        *self.last_used.lock().unwrap() = Some(Instant::now());
        self.busy.store(false, Ordering::SeqCst);
        result
    }

    /// Stops a take in progress by killing the engine process. The engine reloads on the next take.
    pub fn cancel(&self) {
        if !self.busy.load(Ordering::SeqCst) {
            return;
        }
        self.cancelled.store(true, Ordering::SeqCst);
        if let Some(k) = self.killer.lock().unwrap().as_ref() {
            if let Ok(mut c) = k.lock() {
                crate::worker::kill_tree(&mut c);
            }
        }
    }

    pub fn unload(&self, app: &AppHandle) {
        self.cancel();
        let mut slot = self.slot.lock().unwrap();
        if let Some((id, _)) = slot.take() {
            emit(app, &id, "unloading");
            *self.killer.lock().unwrap() = None;
            emit(app, &id, "cold");
        }
    }

    /// Called every few seconds: unloads the engine after the idle time from Settings.
    pub fn idle_check(&self, app: &AppHandle, minutes: Option<u64>) {
        let Some(m) = minutes else { return };
        if self.busy.load(Ordering::SeqCst) {
            return;
        }
        let idle = self.last_used.lock().unwrap().map(|t| t.elapsed() > Duration::from_secs(m * 60)).unwrap_or(false);
        if !idle {
            return;
        }
        if let Ok(mut slot) = self.slot.try_lock() {
            if let Some((id, _)) = slot.take() {
                *self.killer.lock().unwrap() = None;
                emit(app, &id, "cold");
                let _ = app.emit("log", format!("Unloaded {id} after {m} idle minutes. Memory is free."));
            }
        }
    }

    pub fn idle_seconds_left(&self, minutes: Option<u64>) -> Option<u64> {
        let m = minutes?;
        let t = (*self.last_used.lock().unwrap())?;
        self.resident()?;
        Some((m * 60).saturating_sub(t.elapsed().as_secs()))
    }
}
