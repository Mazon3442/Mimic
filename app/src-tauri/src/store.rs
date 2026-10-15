//! Settings and voice profiles, kept as JSON in the app data folder.

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub theme: String,
    pub script_size: String,
    pub save_dir: String,
    pub names: String,
    pub format: String,
    pub warn_unsaved: bool,
    pub output: String,
    pub autoplay: bool,
    pub idle: String,
    pub preload: bool,
    pub engines_dir: String,
    pub mic: String,
    pub stt: String,
    pub lang: String,
    pub last_profile: String,
    /// Engines shown in the top bar. Empty means "every engine that's installed".
    pub pinned: Vec<String>,
    /// Where models run: "Automatic" | "GPU" | "CPU".
    pub device: String,
    /// Hugging Face access token, for models that need an account (NeuTTS). Stays on this PC.
    pub hf_token: String,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            theme: if crate::caelestia::scheme_path().is_file() { "Caelestia".into() } else { "Dark".into() },
            script_size: "Medium".into(),
            save_dir: default_save_dir(),
            names: "voice-engine-take".into(),
            format: "WAV".into(),
            warn_unsaved: true,
            output: "".into(),
            autoplay: false,
            idle: "10 minutes".into(),
            preload: false,
            engines_dir: default_engines_dir(),
            mic: "".into(),
            stt: "Automatic".into(),
            lang: "English".into(),
            last_profile: "".into(),
            pinned: vec![],
            device: "Automatic".into(),
            hf_token: String::new(),
        }
    }
}

#[cfg(windows)]
fn default_save_dir() -> String {
    format!("{}\\Documents\\Mimic", std::env::var("USERPROFILE").unwrap_or_else(|_| "C:".into()))
}

/// The XDG Music folder if `xdg-user-dir` knows it, else ~/Music/Mimic.
#[cfg(unix)]
fn default_save_dir() -> String {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    let music = std::process::Command::new("xdg-user-dir")
        .arg("MUSIC")
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty() && s != &home)
        .unwrap_or_else(|| format!("{home}/Music"));
    format!("{music}/Mimic")
}

#[cfg(windows)]
fn default_engines_dir() -> String {
    format!("{}\\tts", std::env::var("USERPROFILE").unwrap_or_else(|_| "C:".into()))
}

/// $XDG_DATA_HOME/mimic/engines (usually ~/.local/share/mimic/engines).
#[cfg(unix)]
fn default_engines_dir() -> String {
    let data = std::env::var("XDG_DATA_HOME").unwrap_or_else(|_| format!("{}/.local/share", std::env::var("HOME").unwrap_or_default()));
    format!("{data}/mimic/engines")
}

impl Settings {
    pub fn idle_minutes(&self) -> Option<u64> {
        match self.idle.as_str() {
            "5 minutes" => Some(5),
            "10 minutes" => Some(10),
            "30 minutes" => Some(30),
            _ => None,
        }
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct Defaults {
    pub engine: String,
    pub kitten_style: String,
    pub breeze_mode: String,
    pub seed: i64,
}

impl Default for Defaults {
    fn default() -> Self {
        Defaults { engine: "kitten".into(), kitten_style: "Plain".into(), breeze_mode: "Clone".into(), seed: 42 }
    }
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Profile {
    pub id: String,
    pub name: String,
    /// Reference clip (mono 24 kHz WAV in the app's voices folder). Empty for built-in voices.
    pub clip: String,
    /// Built-in KittenTTS voice name, e.g. "Bruno".
    pub builtin: String,
    pub duration: f64,
    pub transcript: String,
    /// "none" | "transcribing" | "auto" | "edited" | "read" (from guided recording)
    pub tx: String,
    pub defaults: Defaults,
}

pub fn load<T: DeserializeOwned + Default>(path: &Path) -> T {
    std::fs::read_to_string(path).ok().and_then(|s| serde_json::from_str(s.trim_start_matches('\u{feff}')).ok()).unwrap_or_default()
}

/// Write via a temp file so a crash never leaves half a JSON file behind.
pub fn save<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let tmp: PathBuf = path.with_extension("tmp");
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, text).map_err(|e| format!("can't write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("can't save {}: {e}", path.display()))
}
