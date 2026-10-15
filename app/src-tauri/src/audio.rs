//! WAV helpers: waveform peaks, duration, and ffmpeg conversions.

use crate::worker::hidden;
use std::path::Path;
use std::process::Command;

/// Peak amplitude (0..1) per bin, for drawing waveforms.
pub fn peaks(path: &Path, bins: usize) -> Result<Vec<f32>, String> {
    let mut reader = hound::WavReader::open(path).map_err(|e| format!("can't read {}: {e}", path.display()))?;
    let spec = reader.spec();
    let channels = spec.channels.max(1) as usize;
    let samples: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader.samples::<f32>().filter_map(Result::ok).collect(),
        hound::SampleFormat::Int => {
            let scale = (1i64 << (spec.bits_per_sample - 1)) as f32;
            reader.samples::<i32>().filter_map(Result::ok).map(|s| s as f32 / scale).collect()
        }
    };
    let frames = samples.len() / channels;
    let bins = bins.max(1);
    let mut out = vec![0f32; bins];
    if frames == 0 {
        return Ok(out);
    }
    for (i, frame) in samples.chunks(channels).enumerate() {
        let b = i * bins / frames;
        let v = frame.iter().fold(0f32, |m, s| m.max(s.abs()));
        if v > out[b] {
            out[b] = v;
        }
    }
    let max = out.iter().cloned().fold(0f32, f32::max).max(1e-4);
    Ok(out.into_iter().map(|v| (v / max).min(1.0)).collect())
}

pub fn duration(path: &Path) -> Result<f64, String> {
    let reader = hound::WavReader::open(path).map_err(|e| format!("can't read {}: {e}", path.display()))?;
    let spec = reader.spec();
    Ok(reader.duration() as f64 / spec.sample_rate as f64)
}

/// Run ffmpeg quietly. `args` go between the input and the output.
pub fn ffmpeg(src: &Path, args: &[&str], dst: &Path) -> Result<(), String> {
    let mut cmd = Command::new("ffmpeg");
    cmd.arg("-y").arg("-loglevel").arg("error").arg("-i").arg(src).args(args).arg(dst);
    hidden(&mut cmd);
    let out = cmd.output().map_err(|e| format!("ffmpeg isn't available ({e}). Install it and restart Mimic."))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!("ffmpeg failed: {}", String::from_utf8_lossy(&out.stderr).trim()))
    }
}

/// Speed a take up or slow it down in place without changing its pitch. 1.0 leaves the file alone.
pub fn set_speed(path: &Path, speed: f64) -> Result<(), String> {
    if (speed - 1.0).abs() < 0.005 {
        return Ok(());
    }
    let tmp = path.with_extension("speed.wav");
    ffmpeg(path, &["-filter:a", &format!("atempo={:.2}", speed.clamp(0.5, 2.0))], &tmp)?;
    std::fs::rename(&tmp, path).map_err(|e| format!("can't write the take: {e}"))
}

/// Any audio file -> mono 24 kHz 16-bit WAV, the format every engine accepts.
pub fn to_reference_wav(src: &Path, dst: &Path) -> Result<(), String> {
    ffmpeg(src, &["-ac", "1", "-ar", "24000", "-sample_fmt", "s16"], dst)
}
