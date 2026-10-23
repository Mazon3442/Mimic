//! Fish Audio Drama 3 runs as an audio.cpp server (native, CUDA) on a free localhost port. Mimic owns its
//! lifecycle and talks to it over HTTP. The model is a 35B mixture-of-experts, so some expert layers run
//! from system RAM to fit a 16 GB card.

use crate::worker::hidden;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const MODEL_ID: &str = "drama-3";
/// Expert layers (of 40) kept in system RAM with Q4 experts. audio.cpp's suggested setting for 16 GB cards.
const CPU_EXPERT_LAYERS: u32 = 24;
/// Frames of text, reference audio and generated speech the model can hold at once (about 21.5 frames per second).
const CONTEXT_LENGTH: u32 = 4096;

fn find(dir: &Path, want: &dyn Fn(&Path) -> bool) -> Option<PathBuf> {
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let p = entry.path();
        if p.is_dir() {
            if let Some(found) = find(&p, want) {
                return Some(found);
            }
        } else if want(&p) {
            return Some(p);
        }
    }
    None
}

pub struct Server {
    child: Arc<Mutex<Child>>,
    url: String,
}

impl Server {
    /// `dir` is the engine's model folder: the GGUF package and the audio.cpp release unpacked under it.
    pub fn start(dir: &Path, log: &Path) -> Result<Server, String> {
        let exe = find(dir, &|p| p.file_name().is_some_and(|n| n == "audiocpp_server.exe"))
            .ok_or("audio.cpp isn't in the engine folder. Download Drama 3 again")?;
        let gguf = find(dir, &|p| p.extension().is_some_and(|e| e == "gguf")).ok_or("the Drama 3 model file is missing. Download it again")?;
        let port = std::net::TcpListener::bind("127.0.0.1:0").and_then(|l| l.local_addr()).map_err(|e| e.to_string())?.port();
        let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(8);
        let config = json!({
            "host": "127.0.0.1", "port": port, "backend": "cuda", "threads": threads,
            "lazy_load": false, "max_loaded_models": 1, "idle_unload_ms": 0, "ui": false,
            "models": [{
                "id": MODEL_ID, "family": "fish_drama3", "path": gguf, "task": "tts", "mode": "offline",
                "session_options": {
                    "fish_drama3.cpu_expert_layers": CPU_EXPERT_LAYERS,
                    "fish_drama3.context_length": CONTEXT_LENGTH,
                },
            }],
        });
        let config_path = log.with_file_name("drama3-server.json");
        std::fs::write(&config_path, serde_json::to_vec_pretty(&config).unwrap()).map_err(|e| e.to_string())?;

        let f = std::fs::OpenOptions::new().create(true).append(true).open(log).map_err(|e| e.to_string())?;
        let mut c = Command::new(&exe);
        c.arg("--config").arg(&config_path).current_dir(exe.parent().unwrap())
            .stdin(Stdio::null())
            .stdout(f.try_clone().map_err(|e| e.to_string())?)
            .stderr(f);
        hidden(&mut c);
        let child = c.spawn().map_err(|e| format!("couldn't start audio.cpp: {e}"))?;
        crate::worker::adopt(&child);
        let server = Server { child: Arc::new(Mutex::new(child)), url: format!("http://127.0.0.1:{port}") };
        let started = Instant::now();
        loop {
            if let Ok(Some(status)) = server.child.lock().unwrap().try_wait() {
                return Err(format!("the Drama 3 server exited ({status}). Details in {}", log.display()));
            }
            if ureq::get(&format!("{}/health", server.url)).timeout(Duration::from_secs(2)).call().is_ok() {
                return Ok(server);
            }
            if started.elapsed() > Duration::from_secs(600) {
                return Err("the Drama 3 server didn't start within 10 minutes".into());
            }
            std::thread::sleep(Duration::from_secs(1));
        }
    }

    pub fn killer(&self) -> Arc<Mutex<Child>> {
        self.child.clone()
    }

    /// `cast` holds each speaker's clip and transcript in order: `<|speaker:N|>` in the text picks cast[N],
    /// and text before any speaker tag is spoken by cast[0].
    pub fn generate(&self, text: &str, cast: &[(&Path, &str)], controls: &BTreeMap<&String, &f64>, seed: i64, out: &Path) -> Result<(), String> {
        let references: Vec<Value> = cast.iter().enumerate()
            .map(|(i, (clip, transcript))| json!({ "text": format!("<|speaker:{i}|> {transcript}"), "audio_path": clip }))
            .collect();
        let mut options = json!({ "references": serde_json::to_string(&references).unwrap() });
        for (k, v) in controls {
            options[k.as_str()] = match k.as_str() {
                // 0 on the slider means no limit, which is the model's own default.
                "top_k" if **v < 1.0 => continue,
                "top_k" => json!(**v as i64),
                _ => json!(v),
            };
        }
        let body = json!({ "model": MODEL_ID, "input": text, "seed": seed.max(0), "response_format": "wav", "options": options });
        let resp = ureq::post(&format!("{}/v1/audio/speech", self.url))
            .timeout(Duration::from_secs(600))
            .send_json(body)
            .map_err(|e| match e {
                ureq::Error::Status(code, r) => {
                    let msg: String = r.into_string().unwrap_or_default().chars().take(300).collect();
                    format!("Drama 3 returned {code}: {msg}")
                }
                e => format!("Drama 3 didn't answer: {e}"),
            })?;
        let mut bytes = Vec::new();
        resp.into_reader().read_to_end(&mut bytes).map_err(|e| e.to_string())?;
        std::fs::write(out, bytes).map_err(|e| format!("can't write the take: {e}"))
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        if let Ok(mut c) = self.child.lock() {
            crate::worker::kill_tree(&mut c);
        }
    }
}
