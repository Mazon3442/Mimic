//! Downloads engines into the engines folder: an isolated venv per engine family, its packages,
//! and the model weights. Progress goes to the UI as "install" events and to logs/install-<id>.log.

use crate::worker::{adopt, hidden, venv_python};
use serde_json::json;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::{AppHandle, Emitter};

enum Step {
    Venv(&'static str),
    /// PyTorch built for where models will run (CUDA 12.8 for NVIDIA incl. RTX 50-series, ROCm for AMD, XPU for Intel GPUs, or CPU).
    Torch,
    /// CPU-only PyTorch, for engines that always run on the CPU (smaller download).
    TorchCpu,
    Pip(&'static [&'static str]),
    /// Download a Hugging Face repo into the model folder as plain files.
    Fetch(&'static str),
    /// Run Python inside the venv; `{dir}` is replaced with the model folder.
    Script(&'static str),
}

struct Recipe {
    env: &'static str,
    /// Folder name under <engines folder>/models, if the engine has model files.
    model: Option<&'static str>,
    steps: Vec<(&'static str, Step)>,
}

/// KittenTTS 2 ships several weight packings; this fetches only the files its config uses.
const KITTEN_FETCH: &str = r#"
import json
from huggingface_hub import hf_hub_download, snapshot_download
from kittenml.get_model import _kitten2_files
repo = "KittenML/kitten-tts-2"
config = json.load(open(hf_hub_download(repo, "config.json", local_dir=r"{dir}")))
snapshot_download(repo, local_dir=r"{dir}", allow_patterns=sorted(_kitten2_files(config)))
"#;

const GATED: &str = "This model needs a free Hugging Face account. Sign in at huggingface.co, open huggingface.co/neuphonic/neutts-air-q4-gguf and huggingface.co/neuphonic/neucodec and accept the terms (approval is instant), then create a read token (Settings > Access Tokens) and paste it in Mimic's Settings > Engines and memory.";

/// Loading NeuTTS once downloads its quantized backbone and codec into the Hugging Face cache.
const NEUTTS_FETCH: &str = r#"
from neutts import NeuTTS
NeuTTS(backbone_repo="neuphonic/neutts-air-q4-gguf", backbone_device="cpu", codec_repo="neuphonic/neucodec", codec_device="cpu")
"#;

/// The repo also holds the original Chatterbox decoder (s3gen.safetensors, 1 GB), which Turbo never loads.
const CHATTERBOX_FETCH: &str = r#"
from huggingface_hub import snapshot_download
snapshot_download("ResembleAI/chatterbox-turbo", local_dir=r"{dir}", ignore_patterns=["s3gen.safetensors"])
"#;

fn recipe(id: &str) -> Option<Recipe> {
    let qwen = |repo: &'static str, folder: &'static str| Recipe {
        env: "qwen-env",
        model: Some(folder),
        steps: vec![
            ("Creating the Python environment", Step::Venv("3.12")),
            ("Installing PyTorch", Step::Torch),
            ("Installing Qwen3-TTS", Step::Pip(&["qwen-tts", "soundfile"])),
            ("Downloading the model", Step::Fetch(repo)),
        ],
    };
    match id {
        "qwen06" => Some(qwen("Qwen/Qwen3-TTS-12Hz-0.6B-Base", "Qwen3-TTS-12Hz-0.6B-Base")),
        "qwen17" => Some(qwen("Qwen/Qwen3-TTS-12Hz-1.7B-Base", "Qwen3-TTS-12Hz-1.7B-Base")),
        "kitten" => Some(Recipe {
            env: "kitten-env",
            model: Some("kitten-tts-2"),
            steps: vec![
                ("Creating the Python environment", Step::Venv("3.12")),
                ("Installing PyTorch", Step::Torch),
                ("Installing KittenTTS", Step::Pip(&["kittenml", "soundfile", "numpy"])),
                ("Downloading the model", Step::Script(KITTEN_FETCH)),
            ],
        }),
        "neutts" => Some(Recipe {
            env: "neutts-env",
            model: None,
            steps: vec![
                ("Creating the Python environment", Step::Venv("3.12")),
                ("Installing PyTorch (CPU)", Step::TorchCpu),
                // torchao is pinned: neucodec pulls in torchtune 0.6, which imports a module newer torchao removed.
                ("Installing NeuTTS and llama.cpp (this compiles, so it takes a few minutes)", Step::Pip(&["neutts[llama]", "soundfile", "numpy", "torchao==0.13.0"])),
                ("Downloading the model", Step::Script(NEUTTS_FETCH)),
            ],
        }),
        "chatterbox" => Some(Recipe {
            env: "chatterbox-env",
            model: Some("chatterbox-turbo"),
            steps: vec![
                ("Creating the Python environment", Step::Venv("3.12")),
                ("Installing PyTorch", Step::Torch),
                // chatterbox-tts pins torch 2.6, which has no kernels for RTX 50-series cards, so its own pins
                // are skipped and its dependencies installed next to the PyTorch above (gradio is only its demo UI).
                ("Installing Chatterbox", Step::Pip(&["chatterbox-tts", "--no-deps"])),
                ("Installing Chatterbox's libraries", Step::Pip(&["numpy<2", "librosa==0.11.0", "s3tokenizer", "transformers==5.2.0",
                    "diffusers==0.29.0", "resemble-perth", "conformer==0.3.2", "safetensors", "pyloudnorm", "omegaconf", "soundfile"])),
                ("Downloading the model", Step::Script(CHATTERBOX_FETCH)),
            ],
        }),
        "voxcpm" => Some(Recipe {
            env: "voxcpm-env",
            model: Some("VoxCPM2"),
            steps: vec![
                ("Creating the Python environment", Step::Venv("3.12")),
                ("Installing PyTorch", Step::Torch),
                ("Installing VoxCPM", Step::Pip(&["voxcpm", "soundfile"])),
                ("Downloading the model", Step::Fetch("openbmb/VoxCPM2")),
            ],
        }),
        "audio8" => Some(Recipe {
            env: "audio8-env",
            model: Some("Audio8-TTS-Preview-0.6b"),
            steps: vec![
                ("Creating the Python environment", Step::Venv("3.12")),
                ("Installing PyTorch", Step::Torch),
                ("Installing Transformers", Step::Pip(&["transformers>=4.57.0,<5", "soundfile", "safetensors"])),
                ("Downloading the model", Step::Fetch("Audio8/Audio8-TTS-Preview-0.6b")),
            ],
        }),
        "stt" => Some(Recipe {
            env: "stt-env",
            model: None,
            steps: vec![
                ("Creating the Python environment", Step::Venv("3.12")),
                ("Installing speech-to-text (faster-whisper)", Step::Pip(&["faster-whisper", "soundfile", "numpy"])),
            ],
        }),
        _ => None,
    }
}

pub fn env_for(id: &str) -> Option<&'static str> {
    recipe(id).map(|r| r.env)
}

/// Model files live in <engines folder>/models/<name>, as plain files (no Hugging Face cache symlinks,
/// which Windows refuses without Developer Mode).
pub fn model_dir(home: &Path, id: &str) -> Option<PathBuf> {
    Some(home.join("models").join(recipe(id)?.model?))
}

fn marker(home: &Path, env: &str, id: &str) -> PathBuf {
    home.join(env).join(format!(".mimic-installed-{id}"))
}

/// Which PyTorch build an engine's environment has ("cuda" | "rocm" | "xpu" | "cpu"), read from the installed
/// torch's version tag (torch-2.11.0+cu128.dist-info), so it's right however and whenever the engine was installed.
/// None when the environment has no PyTorch.
pub fn torch_build(home: &Path, id: &str) -> Option<String> {
    let env = home.join(recipe(id)?.env);
    let sites: Vec<PathBuf> = if cfg!(windows) {
        vec![env.join("Lib").join("site-packages")]
    } else {
        std::fs::read_dir(env.join("lib")).into_iter().flatten().flatten().map(|d| d.path().join("site-packages")).collect()
    };
    let name = sites.iter().flat_map(|d| std::fs::read_dir(d).into_iter().flatten().flatten()).map(|e| e.file_name().to_string_lossy().to_string())
        .find(|n| n.starts_with("torch-") && n.ends_with(".dist-info"))?;
    let tag = name.trim_end_matches(".dist-info").split_once('+').map(|(_, t)| t.to_string()).unwrap_or_default();
    Some(match tag.as_str() {
        t if t.starts_with("cu") => "cuda",
        t if t.starts_with("rocm") => "rocm",
        t if t.starts_with("xpu") => "xpu",
        "" if cfg!(target_os = "linux") => "cuda", // plain PyPI torch is the CUDA build on Linux
        _ => "cpu",
    }.to_string())
}

pub fn is_installed(home: &Path, id: &str) -> bool {
    let Some(r) = recipe(id) else { return false };
    marker(home, r.env, id).is_file()
        && venv_python(&home.join(r.env)).is_file()
        && model_dir(home, id).map(|d| d.read_dir().map(|mut files| files.next().is_some()).unwrap_or(false)).unwrap_or(true)
}

pub fn downloadable() -> &'static [&'static str] {
    &["kitten", "qwen06", "qwen17", "chatterbox", "voxcpm", "audio8", "neutts", "stt"]
}

fn torch_args(device: &str) -> Vec<&'static str> {
    let index = match device {
        "cuda" => "https://download.pytorch.org/whl/cu128",
        "rocm" => "https://download.pytorch.org/whl/rocm7.2", // Linux only; AMD GPUs
        "xpu" => "https://download.pytorch.org/whl/xpu",
        _ => "https://download.pytorch.org/whl/cpu",
    };
    vec![TORCH, TORCHAUDIO, "--index-url", index]
}

/// torch and torchaudio must be the same release (torchaudio's compiled ops are built against it). Unpinned, the ROCm
/// and XPU indexes pair a newer torch with the newest torchaudio they have, which is older. 2.11 exists on all four.
const TORCH: &str = "torch==2.11.*";
const TORCHAUDIO: &str = "torchaudio==2.11.*";

fn uv() -> Result<PathBuf, String> {
    let mut probe = Command::new("uv");
    probe.arg("--version").stdout(Stdio::null()).stderr(Stdio::null());
    hidden(&mut probe);
    if probe.status().map(|s| s.success()).unwrap_or(false) {
        return Ok("uv".into());
    }
    let home = std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).unwrap_or_default();
    let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
    let exe = if cfg!(windows) { "uv.exe" } else { "uv" };
    [format!("{home}/.local/bin/{exe}"), format!("{home}/.cargo/bin/{exe}"), format!("{local}\\hermes\\bin\\uv.exe")]
        .into_iter()
        .map(PathBuf::from)
        .find(|p| p.is_file())
        .ok_or_else(|| {
            if cfg!(windows) {
                "Downloading engines needs uv. Install it with: winget install astral-sh.uv".into()
            } else {
                "Downloading engines needs uv. On Arch: sudo pacman -S uv".into()
            }
        })
}

fn run(mut cmd: Command, log: &Path) -> Result<(), String> {
    let f = std::fs::OpenOptions::new().create(true).append(true).open(log).map_err(|e| e.to_string())?;
    cmd.stdout(f.try_clone().map_err(|e| e.to_string())?).stderr(f).stdin(Stdio::null());
    cmd.env("HF_HUB_DISABLE_SYMLINKS_WARNING", "1").env("PYTHONIOENCODING", "utf-8");
    hidden(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    adopt(&child);
    let status = child.wait().map_err(|e| e.to_string())?;
    if status.success() {
        return Ok(());
    }
    let text = std::fs::read_to_string(log).unwrap_or_default();
    let tail: Vec<&str> = text.lines().rev().take(4).collect();
    Err(format!("failed ({status}): {}", tail.into_iter().rev().collect::<Vec<_>>().join(" | ")))
}

/// Runs every step of the recipe for `device`. Safe to re-run: each step skips work that's already done.
pub fn install(app: Option<&AppHandle>, home: &Path, logs: &Path, id: &str, device: &str, hf_token: &str) -> Result<(), String> {
    let r = recipe(id).ok_or_else(|| format!("{id} can't be downloaded"))?;
    let uv = uv()?;
    let env = home.join(r.env);
    let py = venv_python(&env);
    let log = logs.join(format!("install-{id}.log"));
    let total = r.steps.len();
    std::fs::create_dir_all(home.join("models")).map_err(|e| e.to_string())?;
    let dir = model_dir(home, id).unwrap_or_default();
    for (i, (label, step)) in r.steps.iter().enumerate() {
        if let Some(app) = app {
            let _ = app.emit("install", json!({ "id": id, "step": i + 1, "steps": total, "label": label }));
        }
        println!("[{}/{}] {label}", i + 1, total);
        let cmd = match step {
            Step::Venv(version) => {
                if py.is_file() {
                    continue;
                }
                let mut c = Command::new(&uv);
                c.args(["venv", "--python", version]).arg(&env);
                c
            }
            Step::Torch | Step::TorchCpu => {
                let build = if matches!(step, Step::Torch) { device } else { "cpu" };
                let mut c = Command::new(&uv);
                c.args(["pip", "install", "--python"]).arg(&py).args(torch_args(build));
                // A different build is already there (the device setting changed): swap it, since "torch" alone is already satisfied.
                if torch_build(home, id).is_some_and(|b| b != build) {
                    c.args(["--reinstall-package", "torch", "--reinstall-package", "torchaudio"]);
                }
                c
            }
            Step::Pip(args) => {
                let mut c = Command::new(&uv);
                c.args(["pip", "install", "--python"]).arg(&py).args(*args);
                c
            }
            Step::Fetch(repo) => {
                let mut c = Command::new(&py);
                c.arg("-c").arg(format!(
                    "from huggingface_hub import snapshot_download; snapshot_download('{repo}', local_dir=r'{}')",
                    dir.display()
                ));
                c
            }
            Step::Script(code) => {
                let mut c = Command::new(&py);
                c.arg("-c").arg(code.replace("{dir}", &dir.to_string_lossy()));
                c
            }
        };
        let mut cmd = cmd;
        if !hf_token.is_empty() {
            cmd.env("HF_TOKEN", hf_token);
        }
        run(cmd, &log).map_err(|e| {
            if e.contains("GatedRepoError") || e.contains("401 Client Error") || std::fs::read_to_string(&log).unwrap_or_default().contains("GatedRepoError") {
                GATED.to_string()
            } else {
                format!("{label}: {e}")
            }
        })?;
    }
    std::fs::write(marker(home, r.env, id), device).map_err(|e| e.to_string())?;
    Ok(())
}

/// Forget an engine. The shared environment is deleted once no engine uses it.
pub fn remove(home: &Path, id: &str) -> Result<(), String> {
    let env = env_for(id).ok_or("unknown engine")?;
    let _ = std::fs::remove_file(marker(home, env, id));
    if let Some(dir) = model_dir(home, id) {
        let _ = std::fs::remove_dir_all(dir);
    }
    let still_used = downloadable().iter().any(|other| *other != id && env_for(other) == Some(env) && is_installed(home, other));
    if !still_used {
        std::fs::remove_dir_all(home.join(env)).map_err(|e| format!("couldn't delete {}: {e}", home.join(env).display()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn torch_build_comes_from_the_installed_version_tag() {
        let home = std::env::temp_dir().join(format!("mimic-torch-build-{}", std::process::id()));
        let site = if cfg!(windows) { home.join("qwen-env").join("Lib").join("site-packages") } else { home.join("qwen-env").join("lib").join("python3.12").join("site-packages") };
        assert_eq!(torch_build(&home, "qwen06"), None);
        for (dir, want) in [("torch-2.11.0+cu128.dist-info", "cuda"), ("torch-2.11.0+rocm7.2.dist-info", "rocm"), ("torch-2.11.0+xpu.dist-info", "xpu"), ("torch-2.11.0+cpu.dist-info", "cpu")] {
            let _ = std::fs::remove_dir_all(&site);
            std::fs::create_dir_all(site.join(dir)).unwrap();
            std::fs::create_dir_all(site.join("torchaudio-2.11.0+cu128.dist-info")).unwrap(); // must not be mistaken for torch
            assert_eq!(torch_build(&home, "qwen06").as_deref(), Some(want), "{dir}");
            assert_eq!(torch_build(&home, "qwen17").as_deref(), Some(want), "shared environment");
        }
        let _ = std::fs::remove_dir_all(&home);
    }
}
