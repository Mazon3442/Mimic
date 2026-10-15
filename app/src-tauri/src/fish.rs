//! Fish S2 Pro runs as a vLLM-Omni server inside WSL. Mimic owns its lifecycle and talks to it over HTTP.

use crate::worker::hidden;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const DISTRO: &str = "Ubuntu-24.04";
const URL: &str = "http://127.0.0.1:8091";

/// C:\Users\x\file -> /mnt/c/Users/x/file
pub fn to_wsl(p: &Path) -> String {
    let s = p.to_string_lossy();
    let s = s.trim_start_matches(r"\\?\").replace('\\', "/");
    if s.len() > 2 && s.as_bytes()[1] == b':' {
        format!("/mnt/{}{}", s[..1].to_lowercase(), &s[2..])
    } else {
        s
    }
}

fn wsl_bash(script: &Path, args: &[&str], log: &Path) -> Result<Command, String> {
    let f = std::fs::OpenOptions::new().create(true).append(true).open(log).map_err(|e| e.to_string())?;
    let mut c = Command::new("wsl");
    c.args(["-d", DISTRO, "-u", "root", "--", "bash"]).arg(to_wsl(script)).args(args)
        .stdin(Stdio::null())
        .stdout(f.try_clone().map_err(|e| e.to_string())?)
        .stderr(f);
    hidden(&mut c);
    Ok(c)
}

/// Kills any running or half-dead server so the port and GPU memory are free.
pub fn stop_all(scripts: &Path, log: &Path) {
    if let Ok(mut c) = wsl_bash(&scripts.join("stop-fish-wsl.sh"), &[], log) {
        let _ = c.status();
    }
}

pub struct Server {
    child: Arc<Mutex<Child>>,
    scripts: PathBuf,
    log: PathBuf,
}

impl Server {
    pub fn start(scripts: &Path, log: &Path) -> Result<Server, String> {
        stop_all(scripts, log);
        let child = wsl_bash(
            &scripts.join("serve-fish-wsl.sh"),
            &["--gpu-memory-utilization", "0.95", "--max-model-len", "4096", "--max-num-batched-tokens", "4096"],
            log,
        )?
        .spawn()
        .map_err(|e| format!("couldn't start WSL: {e}"))?;
        crate::worker::adopt(&child);
        let server = Server { child: Arc::new(Mutex::new(child)), scripts: scripts.into(), log: log.into() };
        let started = Instant::now();
        loop {
            if let Ok(Some(status)) = server.child.lock().unwrap().try_wait() {
                return Err(format!("the Fish server exited ({status}). Details in {}", log.display()));
            }
            if ureq::get(&format!("{URL}/health")).timeout(Duration::from_secs(2)).call().is_ok() {
                return Ok(server);
            }
            if started.elapsed() > Duration::from_secs(600) {
                return Err("the Fish server didn't start within 10 minutes".into());
            }
            std::thread::sleep(Duration::from_secs(2));
        }
    }

    pub fn killer(&self) -> Arc<Mutex<Child>> {
        self.child.clone()
    }

    pub fn generate(&self, text: &str, reference: Option<(&Path, &str)>, out: &Path) -> Result<(), String> {
        let mut body = serde_json::json!({
            "model": "fishaudio/s2-pro", "input": text, "voice": "default", "response_format": "wav"
        });
        if let Some((wav, ref_text)) = reference {
            let bytes = std::fs::read(wav).map_err(|e| format!("can't read the clip: {e}"))?;
            body["ref_audio"] = format!("data:audio/wav;base64,{}", STANDARD.encode(bytes)).into();
            body["ref_text"] = ref_text.into();
        }
        let resp = ureq::post(&format!("{URL}/v1/audio/speech"))
            .timeout(Duration::from_secs(600))
            .send_json(body)
            .map_err(|e| match e {
                ureq::Error::Status(code, r) => {
                    let msg: String = r.into_string().unwrap_or_default().chars().take(300).collect();
                    format!("Fish returned {code}: {msg}")
                }
                e => format!("Fish didn't answer: {e}"),
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
        stop_all(&self.scripts, &self.log);
    }
}
