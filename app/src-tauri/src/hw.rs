//! What this PC has: GPU, VRAM, CPU and RAM, and where models should run. Sent to the UI every couple of seconds.

use crate::worker::hidden;
use serde::Serialize;
use std::process::Command;
use std::sync::OnceLock;
use sysinfo::System;

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Hardware {
    /// GPU name, e.g. "NVIDIA GeForce RTX 5070 Ti" or "Intel Iris Xe Graphics". Empty if none was found.
    pub gpu: String,
    /// "nvidia" | "intel" | "amd" | ""
    pub vendor: String,
    /// The best place for models on this PC: "cuda" | "xpu" | "cpu".
    pub accel: String,
    pub vram_total: f64,
    pub vram_used: f64,
    pub cpu: String,
    pub cores: usize,
    pub ram_total: f64,
    pub ram_used: f64,
}

#[derive(Clone, Default)]
struct Fixed {
    gpu: String,
    vendor: String,
    accel: String,
    cpu: String,
    cores: usize,
}

const GIB: f64 = 1024.0 * 1024.0 * 1024.0;

/// GPU and CPU identity never change while Mimic runs, so they're read once.
fn fixed(sys: &mut System) -> Fixed {
    static FIXED: OnceLock<Fixed> = OnceLock::new();
    FIXED
        .get_or_init(|| {
            sys.refresh_cpu_all();
            let cpu = sys.cpus().first().map(|c| c.brand().trim().to_string()).unwrap_or_default();
            let cores = sys.cpus().len();
            if let Some((name, _, _)) = nvidia_smi() {
                return Fixed { gpu: name, vendor: "nvidia".into(), accel: "cuda".into(), cpu, cores };
            }
            let name = other_gpu().unwrap_or_default();
            let lower = name.to_lowercase();
            let vendor = if lower.contains("intel") { "intel" } else if lower.contains("amd") || lower.contains("radeon") { "amd" } else { "" };
            // PyTorch's Intel GPU build is validated on Arc-class graphics (Arc cards, Core Ultra).
            // Older Iris Xe / UHD graphics stay on the CPU.
            let accel = if vendor == "intel" && lower.contains("arc") { "xpu" } else { "cpu" };
            Fixed { gpu: name, vendor: vendor.into(), accel: accel.into(), cpu, cores }
        })
        .clone()
}

pub fn snapshot(sys: &mut System) -> Hardware {
    let f = fixed(sys);
    sys.refresh_memory();
    let (vram_total, vram_used) = if f.vendor == "nvidia" { nvidia_smi().map(|(_, t, u)| (t, u)).unwrap_or_default() } else { (0.0, 0.0) };
    Hardware {
        gpu: f.gpu,
        vendor: f.vendor,
        accel: f.accel,
        vram_total,
        vram_used,
        cpu: f.cpu,
        cores: f.cores,
        ram_total: sys.total_memory() as f64 / GIB,
        ram_used: sys.used_memory() as f64 / GIB,
    }
}

/// (name, total GiB, used GiB) of the first NVIDIA GPU, or None without one.
fn nvidia_smi() -> Option<(String, f64, f64)> {
    let mut cmd = Command::new("nvidia-smi");
    cmd.args(["--query-gpu=name,memory.total,memory.used", "--format=csv,noheader,nounits"]);
    hidden(&mut cmd);
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut parts = text.lines().next()?.split(',').map(str::trim);
    let name = parts.next()?.to_string();
    let total: f64 = parts.next()?.parse().ok()?;
    let used: f64 = parts.next()?.parse().ok()?;
    Some((name, total / 1024.0, used / 1024.0))
}

/// Name of a non-NVIDIA GPU (usually integrated graphics).
#[cfg(unix)]
fn other_gpu() -> Option<String> {
    // lspci gives a readable name: "... VGA compatible controller: Intel Corporation TigerLake-LP GT2 [Iris Xe Graphics]"
    if let Ok(out) = Command::new("lspci").output() {
        let text = String::from_utf8_lossy(&out.stdout);
        if let Some(line) = text.lines().find(|l| l.contains("VGA compatible controller") || l.contains("Display controller") || l.contains("3D controller")) {
            return line.splitn(2, ": ").nth(1).map(|s| s.trim().to_string());
        }
    }
    // Without lspci, the vendor id in sysfs still tells Intel from AMD.
    for entry in std::fs::read_dir("/sys/class/drm").ok()?.flatten() {
        if let Ok(v) = std::fs::read_to_string(entry.path().join("device/vendor")) {
            match v.trim() {
                "0x8086" => return Some("Intel graphics".into()),
                "0x1002" => return Some("AMD graphics".into()),
                _ => {}
            }
        }
    }
    None
}

#[cfg(windows)]
fn other_gpu() -> Option<String> {
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-Command", "(Get-CimInstance Win32_VideoController).Name"]);
    hidden(&mut cmd);
    let out = cmd.output().ok()?;
    String::from_utf8_lossy(&out.stdout).lines().map(str::trim).find(|l| !l.is_empty() && !l.contains("Microsoft Basic")).map(String::from)
}

/// Where models run, from the setting ("Automatic" | "GPU" | "CPU") and what this PC has.
pub fn resolve_device(setting: &str, hw: &Hardware) -> String {
    match setting {
        "CPU" => "cpu".into(),
        _ => if hw.accel.is_empty() { "cpu".into() } else { hw.accel.clone() },
    }
}
