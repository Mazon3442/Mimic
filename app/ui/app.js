// Mimic UI. Talks to the Rust core through Tauri commands and events. Opened in a browser on another device
// (Settings › Use from another device), it sends the same commands and gets the same events over HTTP (remote.rs).
const REMOTE = !window.__TAURI__;
const stream = REMOTE ? new EventSource("/api/events") : null;
const invoke = REMOTE
  ? async (cmd, args = {}) => {
      const r = await fetch(`/api/${cmd}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(args) });
      if (r.status === 401) { location.reload(); throw "This link was replaced. Open the new link from Mimic."; }
      const v = await r.json().catch(() => ({ error: `The PC running Mimic didn't answer (${r.status}).` }));
      if ("error" in v) throw v.error;
      return v.ok;
    }
  : window.__TAURI__.core.invoke;
// The window's drag-and-drop events don't exist in a browser; it uses the page's own drop events instead.
const listen = REMOTE
  ? (name, cb) => { if (!name.startsWith("tauri://")) stream.addEventListener(name, e => cb({ payload: JSON.parse(e.data) })); }
  : window.__TAURI__.event.listen;
const fileSrc = REMOTE ? path => `/api/file?path=${encodeURIComponent(path)}` : window.__TAURI__.core.convertFileSrc;

// Script errors and key actions go to logs/ui.log, since a desktop window has no visible console.
const trace = message => invoke("ui_error", { message });
addEventListener("error", e => trace(`${e.message} at ${e.filename}:${e.lineno}`));
addEventListener("unhandledrejection", e => invoke("ui_error", { message: `Unhandled: ${e.reason}` }));

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const escapeHtml = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ---------- engine catalog ----------
// VRAM figures were measured on an RTX 5070 Ti (Kitten, Qwen) or come from the setup notes (Breeze, Fish).
const ENGINES = {
  // gb: VRAM on a GPU (null = no GPU support). cpuGb: RAM when running on the CPU (null = too heavy for a CPU).
  // Measured on an RTX 5070 Ti and, for cpuGb, on a 16-thread CPU with the GPU hidden.
  kitten:     { name: "Kitten", full: "KittenTTS 2", gb: 8.8, cpuGb: 14.5, transcript: false, license: "Stellon Labs Community", credit: "Powered by Stellon Labs", real: "about 20 s", available: true,
                download: "about 1 GB model + PyTorch", note: "Clones from a clip alone. About 4.7 GB VRAM with built-in voices.",
                tag: t => `<${t}>`, has: ["laugh", "sigh", "breath", "pause"] },
  breeze:     { name: "Breeze", full: "Breeze TTS 2", gb: 8.1, cpuGb: null, transcript: true, license: "non-commercial", real: "35 to 40 s", available: true,
                tag: t => `(${t})`, has: ["laugh", "sigh", "breath"] },
  fish:       { name: "Fish", full: "Fish S2 Pro (WSL server)", gb: 14.3, cpuGb: null, transcript: true, license: "research", real: "about 90 s", available: true,
                windowsOnly: true, tag: t => `<${t}>`, has: ["laugh", "sigh", "pause", "excited", "breath"] },
  qwen06:     { name: "Qwen 0.6B", full: "Qwen3-TTS 0.6B", gb: 2.5, cpuGb: 5.6, transcript: true, license: "Apache 2.0", real: "about 15 s", available: true,
                download: "about 5 GB", note: "Small and quick. Clones from 3 s of audio.", tag: () => "", has: [] },
  qwen17:     { name: "Qwen 1.7B", full: "Qwen3-TTS 1.7B", gb: 4.7, cpuGb: 10.9, transcript: true, license: "Apache 2.0", real: "about 25 s", available: true,
                download: "about 5 GB (shares PyTorch with 0.6B)", note: "Higher quality than 0.6B, slower.", tag: () => "", has: [] },
  chatterbox: { name: "Chatterbox", full: "Chatterbox Turbo, 350M", gb: 3.5, cpuGb: 6.0, transcript: false, minClip: 5, license: "MIT",
                real: "up to a minute", available: true, download: "about 3 GB model + PyTorch",
                note: "Fastest clone: quicker than real time on a GPU, usable on a CPU. Clip of 5 s or more. Adds an inaudible watermark.",
                tag: t => `[${t}]`, has: ["laugh", "chuckle", "sigh", "cough", "gasp"] },
  voxcpm:     { name: "VoxCPM2", full: "VoxCPM2, 2B", gb: 7.0, cpuGb: null, transcript: true, license: "Apache 2.0", real: "about 35 s", available: true,
                download: "about 5 GB model + PyTorch", note: "48 kHz studio-quality output, 30 languages.", tag: () => "", has: [] },
  audio8:     { name: "Audio8", full: "Audio8 TTS Preview, 0.6B", gb: 3.7, cpuGb: 6.1, transcript: true, license: "Apache 2.0", real: "about 20 s", available: true,
                download: "about 2.5 GB model + PyTorch", note: "Preview release. 44.1 kHz, 11 languages. Slower than Qwen.", tag: () => "", has: [] },
  neutts:     { name: "NeuTTS", full: "NeuTTS Air, Q4", gb: null, cpuGb: 1.5, cpuOnly: true, maxClip: 15, transcript: true, license: "Apache 2.0",
                real: "a few seconds", available: true, download: "about 1.5 GB (PyTorch for CPU + model)",
                linuxOnly: true, needsAccount: true,
                note: "Made for laptops: always runs on the CPU in about 1 GB. Clips of 3 to 15 s. Needs a free Hugging Face account.", tag: () => "", has: [] },
  // A 35B mixture-of-experts on audio.cpp: 24 of its 40 expert layers stay in system RAM so it fits a 16 GB card.
  drama3:     { name: "Drama 3", full: "Fish Audio Drama 3, 35B MoE (Q4)", gb: 12.9, cpuGb: null, transcript: true, license: "Fish Audio Community", real: "about a minute", available: true,
                windowsOnly: true, download: "about 24 GB (audio.cpp + model)",
                note: "Acts: tone and sound directions, and scenes with up to 16 voices. Also uses about 11 GB of RAM.",
                tag: t => `[${DRAMA3_TAGS[t] || t}]`, has: ["laugh", "sigh", "pause", "breath", "excited", "chuckle", "cough", "gasp", "whisper", "shout", "angry", "sad"] },
};
// Drama 3 reads free-form directions in brackets ([sighs], [laughs], [whisper] in Fish's examples), so any wording works.
const DRAMA3_TAGS = { laugh: "laughs", sigh: "sighs", breath: "inhales", chuckle: "chuckles", cough: "coughs", gasp: "gasps", shout: "shouting" };
// ---------- controls panel ----------
// What each slider means. Values the user changes are kept per engine in prefs.controls and sent with every take.
const ICONS16 = {
  speed: `<path d="M2.5 11.5a5.5 5.5 0 1 1 11 0"/><path d="M8 11.5l2.6-3.4"/>`,
  temp: `<path d="M6.5 9.3V3a1.5 1.5 0 0 1 3 0v6.3a3 3 0 1 1-3 0z"/><path d="M8 6.5v4.5"/>`,
  funnel: `<path d="M2.5 3h11l-4.2 5v4.5l-2.6 1.2V8z"/>`,
  list: `<path d="M5.5 4h8M5.5 8h8M5.5 12h8"/><circle cx="2.5" cy="4" r=".6"/><circle cx="2.5" cy="8" r=".6"/><circle cx="2.5" cy="12" r=".6"/>`,
  repeat: `<path d="M3 7V6a2 2 0 0 1 2-2h7.5M10.5 2l2 2-2 2M13 9v1a2 2 0 0 1-2 2H3.5M5.5 14l-2-2 2-2"/>`,
  target: `<circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r="2.5"/>`,
  pause: `<path d="M2 8h2.5M11.5 8H14"/><rect x="6" y="4" width="1.4" height="8" rx=".7"/><rect x="8.6" y="4" width="1.4" height="8" rx=".7"/>`,
  dice: `<rect x="2.5" y="2.5" width="11" height="11" rx="2.5"/><circle cx="5.7" cy="5.7" r=".7"/><circle cx="10.3" cy="10.3" r=".7"/><circle cx="8" cy="8" r=".7"/>`,
};
const icon16 = name => `<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${ICONS16[name]}</svg>`;
const CONTROL = {
  speed: { label: "Speed", icon: "speed", min: 0.5, max: 2, step: 0.05, unit: "×", hint: "Faster or slower, without changing the pitch." },
  temperature: { label: "Temperature", icon: "temp", min: 0.1, max: 1.5, step: 0.05, hint: "Higher sounds livelier and less predictable. Lower is steadier." },
  top_p: { label: "Top P", icon: "funnel", min: 0.1, max: 1, step: 0.01, hint: "Only the likeliest sounds are kept. Lower is safer, higher is more varied." },
  top_k: { label: "Top K", icon: "list", min: 0, max: 100, step: 1, digits: 0, hint: "How many choices are weighed at each step. 0 means no limit." },
  repetition_penalty: { label: "Repetition penalty", icon: "repeat", min: 1, max: 2, step: 0.01, hint: "Stops the voice from stalling or looping. Too high clips repeated sounds." },
  // Breeze's plain clone template has no negative prompt, so guidance only exists in Design and Direction.
  cfg: { label: "Guidance (CFG)", icon: "target", min: 1, max: 8, step: 0.1, digits: 1, when: () => state.engine !== "breeze" || state.breezeMode !== "Clone",
         hint: "How strictly it follows the text and voice. Higher is stricter, too high sounds forced." },
  steps: { label: "Quality steps", icon: "target", min: 4, max: 30, step: 1, digits: 0, hint: "Refinement passes for each bit of audio. More is cleaner and slower." },
  gap: { label: "Pause between sentences", icon: "pause", min: 0, max: 1, step: 0.02, unit: " s", hint: "Silence added where sentences are joined." },
};
// Engine defaults, read from each engine's own config. A function default follows the current style or mode.
const kittenPreset = v => () => (state.kittenStyle === "Expressive" ? v[1] : v[0]);
const QWEN_CONTROLS = { temperature: 0.9, top_p: 1, top_k: 50, repetition_penalty: 1.05 };
const ENGINE_CONTROLS = {
  kitten: { temperature: kittenPreset([0.8, 0.9]), top_p: kittenPreset([0.8, 0.9]), top_k: 50, repetition_penalty: 1.1, gap: 0.18 },
  breeze: { cfg: 4, temperature: 0.9, top_p: 1, top_k: 0, repetition_penalty: 1.1 },
  qwen06: QWEN_CONTROLS, qwen17: QWEN_CONTROLS,
  chatterbox: { temperature: 0.8, top_p: 0.95, top_k: 0, repetition_penalty: 1.2, gap: 0.18 },
  voxcpm: { cfg: 2, steps: 10 },
  audio8: { temperature: 0.7, top_p: 0.9, top_k: 50 },
  neutts: { gap: 0.18 },
  drama3: { temperature: 1, top_p: 0.9, top_k: 0 },
};
// Settings an engine is known to break at: the card warns while the value is in range, and so does the composer.
const CONTROL_RISKS = {
  drama3: {
    // Two-voice scenes in testing: 16 of 16 fine at 1.0, 3 of 10 stalled or dropped a line between 0.65 and 0.9.
    temperature: { below: 1, why: "Below 1.0, Drama 3 more often stalls in silence where a new speaker starts. 1.0 is the tested setting." },
    top_k: { from: 1, to: 30, why: "A limit of 30 or less can leave Drama 3 stuck in silence. No limit (0) is safest." },
  },
};
const controlRisk = (engine, key, v) => {
  const r = CONTROL_RISKS[engine]?.[key];
  return r && ((r.below != null && v < r.below - 1e-9) || (r.from != null && v >= r.from && v <= r.to)) ? r.why : null;
};
const riskyControls = engine => ownControls(engine).filter(k => controlRisk(engine, k, controlValue(engine, k)));
const PIN_ICON =`<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M6 2h4l-.6 4 2.6 2.4V10H4V8.4L6.6 6z"/><path d="M8 10v4" stroke-linecap="round"/></svg>`;
const installing = {}; // id -> progress label while a download runs
const ALL = Object.keys(ENGINES);
const SOUNDS = [
  ["laugh", "A short laugh."], ["sigh", "An audible sigh."], ["pause", "A beat of silence."],
  ["breath", "A breath in before the next words."], ["excited", "Reads the next words with energy."],
  ["chuckle", "A quiet chuckle."], ["cough", "A short cough."], ["gasp", "A sharp breath in."],
  ["whisper", "Whispers the next words."], ["shout", "Shouts the next words."],
  ["angry", "Reads the next words angrily."], ["sad", "Reads the next words sadly."],
];
const MODES = {
  breeze: { key: "breezeMode", word: "mode", options: [
    ["Clone", "Copies the voice from the profile's clip."],
    ["Design", "Makes a new voice from a description. The clip isn't used."],
    ["Direction", "The clip's voice, steered by a description."]] },
  kitten: { key: "kittenStyle", word: "style", options: [
    ["Plain", "Reads the text straight. Sounds are skipped."],
    ["Expressive", "Acts out sounds and emotion tags."]] },
};
const ICON = {
  play: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 2.8v10.4a.6.6 0 0 0 .9.5l8.2-5.2a.6.6 0 0 0 0-1L5.4 2.3a.6.6 0 0 0-.9.5z" fill="currentColor"/></svg>`,
  pause: `<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="2.5" width="3" height="11" rx="1" fill="currentColor"/><rect x="9.5" y="2.5" width="3" height="11" rx="1" fill="currentColor"/></svg>`,
  redo: `<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.8"/><path d="M13 2.2v3.4H9.6"/></svg>`,
};

// ---------- state ----------
let prefs = {};
let profiles = [];
let installed = {};
let managed = {}; // engines Mimic downloaded itself (so it may also remove them): the PyTorch build each has, or false
let hw = { gpu: "", vramTotal: 0, vramUsed: 0, ramTotal: 0, ramUsed: 0 };
let takes = [];
const state = {
  engine: "kitten", resident: null, engineState: Object.fromEntries(ALL.map(id => [id, "cold"])),
  voice: null, take: null, blind: false, busy: false, cancelling: false,
  kittenStyle: "Plain", breezeMode: "Clone", seed: 42, nextN: 1, compareN: 1, idleLeft: null,
};
const voiceById = id => profiles.find(p => p.id === id);
const currentVoice = () => voiceById(state.voice) || profiles[0];

function log(msg, error = false) {
  const el = $("#log");
  el.textContent = msg;
  el.classList.toggle("err", error);
}

// ---------- fit and readiness ----------
// Where models run, as decided by the core: "cuda" (NVIDIA), "rocm" (AMD GPU), "xpu" (Intel GPU) or "cpu".
let device = "cuda";
let platform = "windows";
const DEVICE_NAME = { cuda: "GPU", rocm: "AMD GPU", xpu: "Intel GPU", cpu: "CPU" };
// Memory an engine needs where it will run: VRAM on a graphics card, shared RAM on integrated GPUs, RAM on the CPU.
const memFor = id => (device === "cpu" || ENGINES[id].cpuOnly ? ENGINES[id].cpuGb : ENGINES[id].gb);
const onVram = () => (device === "cuda" || device === "rocm") && hw.vramTotal > 0;
function fit(id) {
  const e = ENGINES[id], need = memFor(id);
  if (e.windowsOnly && platform !== "windows") return { ok: false, why: "runs only on Windows for now" };
  if (e.linuxOnly && platform !== "linux") return { ok: false, why: "runs only on Linux for now" };
  if (need == null) return { ok: false, why: device === "cpu" ? "is too heavy to run on a CPU" : "doesn't run on this GPU" };
  if (onVram() && !e.cpuOnly) return hw.vramTotal >= need + 1 ? { ok: true } : { ok: false, why: `needs about ${need.toFixed(1)} GB of VRAM; this GPU has ${hw.vramTotal.toFixed(0)} GB` };
  // Integrated GPUs and the CPU both use system RAM; leave about 3 GB for everything else.
  return hw.ramTotal - 3 >= need ? { ok: true } : { ok: false, why: `needs about ${need.toFixed(1)} GB of RAM; this PC has ${hw.ramTotal.toFixed(0)} GB` };
}
const memText = id => {
  const need = memFor(id);
  if (need == null) return device === "cpu" ? "Needs a GPU" : "CPU only";
  if (ENGINES[id].cpuOnly) return `CPU · about ${need.toFixed(1)} GB RAM`;
  return onVram() ? `GPU · about ${need.toFixed(1)} GB VRAM` : `${DEVICE_NAME[device]} · about ${need.toFixed(1)} GB RAM`;
};
const usable = id => ENGINES[id].available && installed[id] && fit(id).ok;
const tagsFor = id => (id === "kitten" && state.kittenStyle !== "Expressive" ? [] : ENGINES[id].has);

function readiness(v, engine) {
  const e = ENGINES[engine];
  if (!v) return { ok: false, why: "pick a voice" };
  if (v.builtin) return engine === "kitten" ? { ok: true } : { ok: false, why: `${v.name} is a built-in Kitten voice` };
  const minClip = e.minClip || 3;
  if (v.duration < minClip) return { ok: false, why: `the clip is ${v.duration.toFixed(1)} s; ${e.minClip ? e.name : "it"} needs at least ${minClip} s` };
  if (e.maxClip && v.duration > e.maxClip) return { ok: false, why: `the clip is ${v.duration.toFixed(1)} s; ${e.name} needs ${e.maxClip} s or less. Record a shorter clip` };
  if (e.transcript && v.tx === "transcribing") return { ok: false, why: "the transcript is still being written", wait: true };
  if (e.transcript && !v.transcript.trim()) return { ok: false, why: `${e.name} needs the transcript of the clip`, fix: "transcribe" };
  return { ok: true };
}
function profileSummary(v) {
  if (v.builtin) return { text: "Built-in, Kitten only", cls: "" };
  if (v.duration < 3) return { text: "Too short to clone", cls: "warn" };
  if (v.tx === "transcribing") return { text: "Writing transcript…", cls: "busy" };
  const can = ALL.filter(usable);
  const ok = can.filter(e => readiness(v, e).ok);
  if (ok.length === can.length) return { text: `Ready · default ${ENGINES[v.defaults.engine]?.name || "Kitten"}`, cls: "" };
  return { text: `${ok.map(e => ENGINES[e].name).join(", ") || "No engine"} only · no transcript`, cls: "warn" };
}

// ---------- waveforms ----------
const peakCache = new Map();
async function peaksFor(path) {
  if (!peakCache.has(path)) peakCache.set(path, invoke("peaks", { path, bins: 600 }).catch(() => []));
  return peakCache.get(path);
}
const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
function drawWave(canvas, peaks, played = 0) {
  const dpr = devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !peaks) return;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const g = canvas.getContext("2d"); g.scale(dpr, dpr);
  const step = 3, n = Math.floor(w / step);
  const base = cssVar("--wave"), live = cssVar("--live"), ink = cssVar("--ink-2");
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * peaks.length / n), b = Math.max(a + 1, Math.floor((i + 1) * peaks.length / n));
    let p = 0; for (let j = a; j < b; j++) p = Math.max(p, peaks[j] || 0);
    const bh = Math.max(1.5, p * h);
    g.fillStyle = i / n < played ? live : (played > 0 ? ink : base);
    g.beginPath(); g.roundRect(i * step, (h - bh) / 2, 2, bh, 1); g.fill();
  }
}
async function paint(canvas, path, played = 0) { drawWave(canvas, await peaksFor(path), played); }

// ---------- top bar: the memory bar is the engine picker ----------
// Engines that exist on this OS (Fish needs WSL and Drama 3 a Windows build, so they're Windows-only).
const listed = id => !(ENGINES[id].windowsOnly && platform !== "windows") && !(ENGINES[id].linuxOnly && platform !== "linux");
function engineLabel(id) {
  if (!ENGINES[id].available || !installed[id]) return [ENGINES[id].download ? "not downloaded" : "not set up", "nofit"];
  if (!fit(id).ok) return ["won't fit", "nofit"];
  const s = state.engineState[id];
  return [{ cold: "not loaded", warm: "loaded", loading: "loading", unloading: "unloading", generating: "generating" }[s] || s, s];
}
// The top bar shows pinned engines. Until something is pinned, it shows every engine that's set up.
const pinnedIds = () => (prefs.pinned?.length ? prefs.pinned : ALL.filter(id => ENGINES[id].available && installed[id])).filter(id => ENGINES[id]);
function togglePin(id) {
  const list = pinnedIds();
  prefs.pinned = list.includes(id) ? list.filter(x => x !== id) : ALL.filter(x => x === id || list.includes(x));
  if (!prefs.pinned.length) prefs.pinned = [state.engine];
  persistPrefs(); renderTop(); renderEngines();
}
function renderTop() {
  const shown = pinnedIds().includes(state.engine) ? pinnedIds() : [...pinnedIds(), state.engine];
  $("#engineBtns").innerHTML = ALL.filter(id => shown.includes(id)).map(id => {
    const e = ENGINES[id], [label, s] = engineLabel(id);
    return `<button class="engine" data-engine="${id}" data-fit="${usable(id) ? "yes" : "no"}" aria-pressed="${id === state.engine}"><b>${e.name}</b><span>${memFor(id) == null ? "—" : memFor(id).toFixed(1) + " GB"}</span><span class="state" data-s="${s}">${label}</span></button>`;
  }).join("") + `<button class="engine more" id="moreEngines">Engines…</button>`;
  $$(".engine[data-engine]").forEach(b => {
    const id = b.dataset.engine;
    b.onclick = () => selectEngine(id);
    b.onmouseenter = b.onfocus = () => previewEngine(id);
    b.onmouseleave = b.onblur = () => previewEngine(null);
  });
  $("#moreEngines").onclick = openEngines;
  renderBar();
}
function renderBar() {
  // VRAM when models run on a graphics card; otherwise system RAM (integrated GPUs share it).
  const vram = onVram();
  const total = vram ? hw.vramTotal : hw.ramTotal, used = vram ? hw.vramUsed : hw.ramUsed;
  $(".bar .fill").style.transform = `scaleX(${total ? Math.min(1, used / total) : 0})`;
  const rs = state.resident && state.engineState[state.resident];
  const res = !state.resident ? "nothing loaded" : rs === "loading" ? `loading ${ENGINES[state.resident].name}` : rs === "unloading" ? `unloading ${ENGINES[state.resident].name}` : `${ENGINES[state.resident].name} loaded`;
  const pool = vram ? "VRAM" : device !== "cpu" ? `RAM · ${DEVICE_NAME[device]}` : "RAM · on the CPU";
  $("#vramText").innerHTML = total ? `<b>${used.toFixed(1)}</b> of ${total.toFixed(1)} GB ${pool} · ${res}` : "Reading hardware…";
}
function previewEngine(id) {
  const ghost = $(".bar .ghost"), hint = $("#hint");
  hint.classList.remove("alert");
  if (!id) { ghost.classList.remove("on"); hint.textContent = ""; return; }
  const e = ENGINES[id];
  const f = fit(id);
  if (!f.ok) { hint.textContent = `${e.name} won't fit: it ${f.why}.`; hint.classList.add("alert"); return; }
  if (!installed[id]) { hint.textContent = e.download ? `${e.name} isn't downloaded yet. Open Engines to get it.` : `${e.name} isn't set up in the engines folder (Settings).`; hint.classList.add("alert"); return; }
  const vram = onVram(), total = vram ? hw.vramTotal : hw.ramTotal, used = vram ? hw.vramUsed : hw.ramUsed;
  const need = memFor(id), residentGb = state.resident ? memFor(state.resident) || 0 : 0;
  const after = id === state.resident ? used : Math.max(0, used - residentGb) + need;
  ghost.style.width = `${Math.min(100, after / total * 100)}%`;
  ghost.classList.add("on");
  if (id === state.resident) { hint.textContent = `${e.name} is loaded.`; return; }
  const other = state.resident && ENGINES[state.resident];
  const where = device === "cpu" ? " on the CPU" : "";
  hint.textContent = other ? `${e.name} needs about ${need.toFixed(1)} GB${where}. ${other.name} will be unloaded first.`
                           : `${e.name} needs about ${need.toFixed(1)} GB${where}${e.real && device !== "cpu" ? ` (loading takes ${e.real})` : ""}.`;
  hint.classList.toggle("alert", !!other);
}
function selectEngine(id) {
  if (!usable(id)) { previewEngine(id); return; }
  state.engine = id;
  renderTop(); renderComposer(); renderPreflight(); renderDialect(); renderDetail(); renderCount(); renderControls();
}

// ---------- profiles ----------
function renderVoices() {
  const list = $("#voiceList");
  list.innerHTML = "";
  $("#voiceCount").textContent = profiles.length;
  // Until a voice has been cloned, the list says how to clone one.
  if (!profiles.some(p => !p.builtin)) {
    const card = document.createElement("div");
    card.className = "onboard";
    card.innerHTML = `<b>Clone your first voice</b><p>Record yourself reading a short passage, or bring an audio clip of anyone speaking. You can also drop audio files on this window.</p>
      <div class="row"><button class="btn small" data-nv="record">Record</button><button class="btn small" data-nv="import">Import a file</button></div>`;
    card.querySelector('[data-nv="record"]').onclick = openRecorder;
    card.querySelector('[data-nv="import"]').onclick = () => importClip();
    list.append(card);
  }
  for (const v of profiles) {
    const s = profileSummary(v);
    const b = document.createElement("button");
    b.className = "voice"; b.setAttribute("role", "option"); b.setAttribute("aria-selected", v.id === state.voice); b.dataset.id = v.id;
    b.innerHTML = `<span class="voice-top"><span class="voice-name">${escapeHtml(v.name)}</span><span class="voice-dur">${v.builtin ? "" : v.duration.toFixed(1) + " s"}</span></span>
      ${v.builtin ? "" : "<canvas></canvas>"}<span class="voice-ready ${s.cls}">${s.text}</span>`;
    b.onclick = () => selectProfile(v.id);
    list.append(b);
    const c = b.querySelector("canvas"); if (c) requestAnimationFrame(() => paint(c, v.clip));
  }
  renderDetail();
}
const currentSettings = () => ({ engine: state.engine, kittenStyle: state.kittenStyle, breezeMode: state.breezeMode, seed: state.seed });
const sameSettings = (a, b) => a.engine === b.engine && a.kittenStyle === b.kittenStyle && a.breezeMode === b.breezeMode && a.seed === b.seed;
function describe(d) {
  const extra = d.engine === "kitten" ? ` · ${d.kittenStyle}` : d.engine === "breeze" ? ` · ${d.breezeMode}` : "";
  return escapeHtml(`${ENGINES[d.engine]?.name || d.engine}${extra} · seed ${d.seed}`); // profile fields can come from another device
}
function selectProfile(id) {
  state.voice = id;
  const d = voiceById(id).defaults;
  Object.assign(state, { kittenStyle: d.kittenStyle, breezeMode: d.breezeMode, seed: d.seed });
  if (usable(d.engine)) state.engine = d.engine;
  prefs.lastProfile = id; persistPrefs();
  renderTop(); renderVoices(); renderComposer(); renderDialect(); renderPreflight(); renderControls();
}
let txTimer = null;
function renderDetail() {
  const v = currentVoice(), d = $("#voiceDetail");
  if (!v) { d.innerHTML = `<p style="color:var(--ink-2)">No voices yet. Press New voice to clone one.</p>`; return; }
  const changed = !sameSettings(v.defaults, currentSettings());
  const defaults = `<div class="defaults"><span>Defaults: <b>${describe(v.defaults)}</b></span>
    <button class="btn small" id="saveDefaults" ${changed ? "" : "disabled"}>${changed ? "Save current" : "Saved"}</button></div>`;
  const actions = `<div class="row links">${v.builtin ? "<span></span>" : `<button class="link" id="playClip">Play clip</button>`}
    <button class="link danger" id="delProfile">Delete profile</button></div>`;
  if (v.builtin) {
    d.innerHTML = `<input class="name" id="pname" value="${escapeHtml(v.name)}" aria-label="Profile name">
      <p style="color:var(--ink-2)">Built-in KittenTTS 2 voice. No clip or transcript needed.</p>${defaults}${actions}`;
  } else {
    const status = v.tx === "transcribing" ? `<span class="busy">Writing it now, on this PC…</span>`
      : v.tx === "auto" ? `<span class="ok">Written automatically</span>`
      : v.tx === "read" ? `<span class="ok">From the passage you read</span>`
      : v.tx === "edited" ? `<span class="ok">Edited by you</span>` : `<span class="no">Missing</span>`;
    d.innerHTML = `<input class="name" id="pname" value="${escapeHtml(v.name)}" aria-label="Profile name">
      <label for="tx"><span>Transcript</span>${status}</label>
      <textarea class="transcript" id="tx" ${v.tx === "transcribing" ? "disabled" : ""} placeholder="What is said in the clip.">${escapeHtml(v.transcript)}</textarea>
      ${defaults}${actions}`;
    $("#tx").oninput = e => {
      v.transcript = e.target.value; v.tx = v.transcript.trim() ? "edited" : "none";
      renderSummaries(); renderPreflight();
      clearTimeout(txTimer); txTimer = setTimeout(() => saveProfile(v), 500);
    };
    $("#playClip").onclick = () => playPath(v.clip, `clip:${v.id}`);
  }
  $("#pname").onchange = e => { v.name = e.target.value.trim() || v.name; saveProfile(v).then(renderVoices); };
  $("#saveDefaults").onclick = () => { v.defaults = currentSettings(); saveProfile(v); renderDetail(); renderSummaries(); log(`Saved ${describe(v.defaults)} as ${v.name}'s defaults.`); };
  $("#delProfile").onclick = async () => {
    if (!confirm(`Delete the profile "${v.name}"? Its clip is removed too. Saved takes stay.`)) return;
    await invoke("delete_profile", { id: v.id });
    profiles = profiles.filter(p => p.id !== v.id);
    state.voice = profiles[0]?.id || null;
    renderVoices(); renderComposer(); renderPreflight();
  };
}
function renderSummaries() {
  $$(".voice").forEach(b => { const v = voiceById(b.dataset.id); if (!v) return; const s = profileSummary(v); const el = b.querySelector(".voice-ready"); el.textContent = s.text; el.className = `voice-ready ${s.cls}`; });
}
async function saveProfile(v) {
  try { Object.assign(v, await invoke("save_profile", { profile: v })); }
  catch (e) { log(String(e), true); }
}
function replaceProfile(p) {
  const i = profiles.findIndex(x => x.id === p.id);
  if (i >= 0) profiles[i] = p; else profiles.unshift(p);
}
// Speech-to-text runs locally as soon as a clip arrives; nobody presses a button.
async function transcribe(v) {
  if (!installed.stt) {
    log("Speech-to-text isn't installed. Open Engines to download it (about 300 MB), or type the transcript.", true);
    return;
  }
  v.tx = "transcribing"; v.transcript = "";
  renderVoices(); renderPreflight();
  log(`Writing the transcript for ${v.name} on the CPU (the first time also downloads the speech-to-text model)…`);
  try {
    replaceProfile(await invoke("transcribe", { id: v.id }));
    log(`Transcript for ${v.name} is ready.`);
  } catch (e) {
    v.tx = "none";
    log(String(e), true);
  }
  renderVoices(); renderPreflight();
}
// With a path (dropped files, test runs) or a File (in a browser) the clip is imported directly; without one, a file picker opens.
async function importClip(src) {
  if (!(await consented())) return;
  try {
    if (REMOTE && !src) [src] = await pickFiles();
    if (REMOTE && !src) return;
    const p = src instanceof File ? await uploadClip(src) : typeof src === "string" ? await invoke("import_path", { path: src }) : await invoke("import_clip");
    if (!p) return;
    replaceProfile(p); selectProfile(p.id);
    $("#pname")?.select();
    await transcribe(voiceById(p.id));
  } catch (e) { log(String(e), true); }
}
// Drop audio files anywhere on the window to make profiles from them.
const AUDIO = /\.(wav|mp3|flac|ogg|m4a|aac|opus|wma|mp4)$/i;
listen("tauri://drag-enter", ({ payload }) => document.body.classList.toggle("dropping", (payload.paths || []).some(p => AUDIO.test(p))));
listen("tauri://drag-leave", () => document.body.classList.remove("dropping"));
listen("tauri://drag-drop", async ({ payload }) => {
  document.body.classList.remove("dropping");
  const clips = (payload.paths || []).filter(p => AUDIO.test(p));
  if (clips.length) closeNewVoice();
  for (const path of clips) await importClip(path);
});
// In a browser: a file picker, uploads, and the page's own drop events.
function pickFiles() {
  return new Promise(done => {
    const input = Object.assign(document.createElement("input"), { type: "file", accept: "audio/*,video/mp4" });
    input.onchange = () => done([...input.files]); input.oncancel = () => done([]);
    input.click();
  });
}
async function uploadClip(file) {
  log(`Sending ${file.name} to the PC running Mimic…`);
  const r = await fetch(`/api/upload?name=${encodeURIComponent(file.name)}`, { method: "POST", body: file });
  const v = await r.json().catch(() => ({ error: `Upload failed (${r.status}).` }));
  if ("error" in v) throw v.error;
  return v.ok;
}
if (REMOTE) {
  addEventListener("dragover", e => { e.preventDefault(); document.body.classList.toggle("dropping", [...e.dataTransfer.items].some(i => i.kind === "file")); });
  addEventListener("dragleave", e => { if (!e.relatedTarget) document.body.classList.remove("dropping"); });
  addEventListener("drop", async e => {
    e.preventDefault(); document.body.classList.remove("dropping");
    const clips = [...e.dataTransfer.files].filter(f => AUDIO.test(f.name));
    if (clips.length) closeNewVoice();
    for (const f of clips) await importClip(f);
  });
}

// The one way in to cloning: record a clip or bring a file.
function openNewVoice() { $("#newVoiceDlg").classList.add("open"); $("#nvRecord").focus(); }
function closeNewVoice() { $("#newVoiceDlg").classList.remove("open"); }

// ---------- script ----------
// Drama 3 scenes: speaker chips in the script switch voices. The selected profile is speaker 0 and opens the scene;
// the other profiles become speakers 1, 2, ... in the order they first appear.
const SCENE_ENGINES = ["drama3"];
const sceneCast = () => [...new Set($$("#script [data-voice]").map(n => n.dataset.voice))].filter(id => id !== currentVoice()?.id);
const speakerIndex = id => (id === currentVoice()?.id ? 0 : 1 + sceneCast().indexOf(id));
// Walks the whole script, chips included. Pressing Enter wraps lines in their own elements, so chips can sit
// at any depth; line breaks become spaces.
function scriptParts(chip) {
  let out = "";
  const walk = node => node.childNodes.forEach(n => {
    if (n.dataset?.voice || n.dataset?.tag) out += chip(n);
    else if (n.nodeType === Node.TEXT_NODE) out += n.textContent;
    else { if (/^(BR|DIV|P)$/.test(n.nodeName)) out += " "; walk(n); }
  });
  walk($("#script"));
  return out;
}
function scriptText(engine) {
  const has = tagsFor(engine);
  const out = scriptParts(n => n.dataset.voice
    ? (SCENE_ENGINES.includes(engine) ? ` <|speaker:${speakerIndex(n.dataset.voice)}|> ` : " ")
    : (has.includes(n.dataset.tag) ? ` ${ENGINES[engine].tag(n.dataset.tag)} ` : " "));
  // Each speaker's turn starts on its own line: on one line, Drama 3 keeps the first voice for the whole scene.
  return out.replace(/\s+/g, " ").replace(/ ?<\|speaker:/g, "\n<|speaker:").trim();
}
function neutralText() {
  return scriptParts(n => (n.dataset.voice ? ` ${n.textContent}: ` : ` [${n.dataset.tag}] `)).replace(/\s+/g, " ").trim();
}
// A sound the current engine can't make is struck through, right where it sits in the script.
function renderDialect() {
  const e = ENGINES[state.engine], has = tagsFor(state.engine);
  $$("#script .tag").forEach(t => {
    if (t.dataset.voice) {
      const ok = SCENE_ENGINES.includes(state.engine);
      t.classList.toggle("skip", !ok);
      t.title = ok ? `${voiceById(t.dataset.voice)?.name || "A deleted profile"} speaks from here` : `${e.name} reads with one voice, so speaker changes are skipped.`;
      return;
    }
    const ok = has.includes(t.dataset.tag);
    t.classList.toggle("skip", !ok);
    t.title = ok ? `${e.name} reads this as ${e.tag(t.dataset.tag)}`
      : state.engine === "kitten" && e.has.includes(t.dataset.tag) ? `Kitten only makes sounds in Expressive style.`
      : `${e.name} can't do "${t.dataset.tag}", so it's skipped. Other engines may.`;
  });
}
let lastCaret = null;
document.addEventListener("selectionchange", () => {
  const s = getSelection();
  if (s.rangeCount && $("#script").contains(s.anchorNode)) lastCaret = s.getRangeAt(0).cloneRange();
});
function insertTag(tag) {
  const span = document.createElement("span");
  span.dataset.tag = tag; span.textContent = tag;
  insertChip(span);
}
function insertSpeaker(id) {
  const span = document.createElement("span");
  span.classList.add("speaker"); span.dataset.voice = id; span.textContent = voiceById(id).name;
  insertChip(span);
}
function insertChip(span) {
  span.classList.add("tag"); span.contentEditable = "false";
  const sel = getSelection(), el = $("#script"), r = lastCaret;
  if (r && el.contains(r.startContainer)) {
    r.deleteContents(); r.insertNode(document.createTextNode(" ")); r.insertNode(span);
    r.setStartAfter(span); r.collapse(true); el.focus(); sel.removeAllRanges(); sel.addRange(r);
  } else el.append(" ", span, " ");
  renderDialect(); renderCount(); renderPreflight();
}
const renderCount = () => ($("#charCount").textContent = `${scriptText(state.engine).length} characters`);

// ---------- composer ----------
function renderComposer() {
  closeMenu();
  const e = ENGINES[state.engine], v = currentVoice(), m = MODES[state.engine];
  const design = state.engine === "breeze" && state.breezeMode === "Design";
  const tok = (menu, text) => `<button class="token" data-menu="${menu}" aria-expanded="false">${escapeHtml(text)}</button>`;
  $("#recipe").innerHTML = (design ? "Say it as a new voice" : `Say it as ${tok("voice", v ? v.name : "…")}`)
    + ` with ${tok("engine", e.name)}` + (m ? ` in ${tok("mode", state[m.key])} ${m.word}` : "");
  const instr = $("#instr");
  instr.hidden = !(state.engine === "breeze" && state.breezeMode !== "Clone");
  instr.placeholder = design ? "Describe the new voice, e.g. warm, slow, a little husky" : "How should it sound? e.g. tired and quiet";
}
function blocker(engine) {
  const v = currentVoice(), e = ENGINES[engine];
  if (!e.available) return { why: `${e.name} isn't in this version of Mimic yet.` };
  if (!installed[engine]) return { why: `${e.name} isn't set up in the engines folder.`, fix: "settings" };
  if (!fit(engine).ok) return { why: `${e.name} won't fit on this PC: it ${fit(engine).why}.` };
  if (!scriptText(engine)) return { why: "The script is empty." };
  if (state.busy) return { why: "Wait for the current take, or press Esc to cancel it." };
  const design = engine === "breeze" && state.breezeMode === "Design";
  if (engine === "breeze" && state.breezeMode !== "Clone" && !$("#instr").value.trim()) return { why: "Describe the voice first." };
  if (design) return null;
  const r = readiness(v, engine);
  if (!r.ok) return { why: r.wait ? `Waiting for ${v.name}'s transcript. It takes a few seconds.` : `Can't use ${v?.name || "this voice"} with ${e.name}: ${r.why}.`, fix: r.fix, wait: r.wait };
  if (!SCENE_ENGINES.includes(engine)) return null;
  const cast = sceneCast();
  if (cast.length > 15) return { why: "A scene can have up to 16 voices." };
  for (const id of cast) {
    const p = voiceById(id);
    if (!p) return { why: "A speaker in the script was deleted. Remove its chip." };
    const pr = readiness(p, engine);
    if (!pr.ok) return { why: `${p.name} can't speak in the scene: ${pr.why}.`, wait: pr.wait };
  }
  return null;
}
const compareSet = () => ALL.filter(id => !blocker(id));
function renderPreflight() {
  const e = ENGINES[state.engine], v = currentVoice(), b = blocker(state.engine), p = $("#preflight");
  $("#genBtn").disabled = !!b;
  const n = compareSet().length;
  $("#compareBtn").disabled = state.busy || n < 2;
  $("#compareBtn").textContent = n >= 2 ? `Compare ${n} engines` : "Compare engines";
  $("#compareBtn").title = n >= 2 ? `Makes one take with each of: ${compareSet().map(id => ENGINES[id].name).join(", ")}` : "Needs two engines that can use this voice";
  p.className = "preflight" + (b ? (b.wait ? " wait" : " block") : "");
  if (b) {
    p.innerHTML = escapeHtml(b.why) + (b.fix === "transcribe" ? ` <button id="pfFix">Write it now</button>` : b.fix === "settings" ? ` <button id="pfFix">Open Settings</button>` : "");
    const fix = $("#pfFix"); if (fix) fix.onclick = () => (b.fix === "transcribe" ? transcribe(v) : openSettings());
    return;
  }
  const how = state.engine === "breeze" && state.breezeMode === "Design" ? "New voice from your description"
    : v.builtin ? "Built-in voice" : `${v.duration.toFixed(1)} s clip${e.transcript ? " + transcript" : ""}`;
  const load = state.resident === state.engine ? "loaded, starts now" : `loads first (${e.real})`;
  const risky = riskyControls(state.engine);
  if (!risky.length) { p.textContent = `${how} · ${load}`; return; }
  // Settings known to break this engine don't block a take, but the fix is one click away.
  p.className = "preflight risk";
  p.innerHTML = escapeHtml(`${risky.map(k => `${CONTROL[k].label} ${fmtControl(k, controlValue(state.engine, k))}`).join(" and ")} can leave silent gaps with ${e.name}.`)
    + ` <button id="pfFix">Use recommended</button>`;
  $("#pfFix").onclick = () => {
    risky.forEach(k => setControl(state.engine, k, null)); persistPrefs(); renderControls(); renderPreflight();
    log(`${risky.map(k => CONTROL[k].label).join(" and ")} back to ${e.name}'s recommended settings.`);
  };
}

// ---------- menus (open from their trigger) ----------
let menuFor = null;
function menuHtml(kind) {
  const e = ENGINES[state.engine];
  if (kind === "voice") return `<p class="menu-title">Voice profile</p>` + profiles.map(v =>
    `<button class="mi" data-v="${v.id}" aria-checked="${v.id === state.voice}"><b>${escapeHtml(v.name)}<em>${v.builtin ? "built-in" : v.duration.toFixed(1) + " s"}</em></b><span>${profileSummary(v).text}</span></button>`).join("")
    + `<div class="menu-sep"></div><button class="mi" data-newvoice><b>New voice…</b><span>Record a clip or import an audio file</span></button>`;
  if (kind === "engine") return `<p class="menu-title">Engine</p>` + ALL.filter(id => ENGINES[id].available && listed(id)).map(id => {
    const x = ENGINES[id], [label] = engineLabel(id);
    return `<button class="mi" data-e="${id}" aria-checked="${id === state.engine}" ${usable(id) ? "" : "disabled"}><b>${x.name}<em>${label}</em></b><span>${memText(id)} · ${x.transcript ? "clip + transcript" : "clip only"}</span></button>`;
  }).join("") + `<div class="menu-sep"></div><button class="mi" data-engines><b>More engines…</b><span>Smaller engines for other PCs</span></button>`;
  if (kind === "mode") { const m = MODES[state.engine]; return `<p class="menu-title">${e.name} ${m.word}</p>` + m.options.map(([o, d]) =>
    `<button class="mi" data-mode="${o}" aria-checked="${state[m.key] === o}"><b>${o}</b><span>${d}</span></button>`).join(""); }
  if (kind === "sound") {
    // Scene engines list speakers first: switching voices is the reason to open this menu with them.
    const scene = SCENE_ENGINES.includes(state.engine);
    const speakers = scene
      ? `<p class="menu-title">Switch speaker</p>` + profiles.filter(p => !p.builtin).map(p =>
          `<button class="mi" data-speaker="${p.id}"><b>${escapeHtml(p.name)}<em>${p.id === state.voice ? "speaker 0" : "joins the scene"}</em></b><span>Speaks the words after this point</span></button>`).join("")
        + `<div class="menu-sep"></div>`
      : SCENE_ENGINES.some(usable) ? `<p class="menu-title">Several voices in one take? Switch the engine to ${SCENE_ENGINES.filter(usable).map(id => ENGINES[id].name).join(" or ")}.</p>` : "";
    return speakers + `<p class="menu-title">Add at the cursor${scene ? ", or type any direction in brackets, like [nervous laugh]" : ""}</p>` + SOUNDS.map(([s, d]) => {
      const ok = tagsFor(state.engine).includes(s);
      return `<button class="mi" data-sound="${s}"><b>${s[0].toUpperCase() + s.slice(1)}<em>${ok ? escapeHtml(e.tag(s)) : `${e.name} skips it`}</em></b><span>${d}</span></button>`;
    }).join("");
  }
  return "";
}
function openMenu(kind, trigger) {
  if (menuFor === trigger) return closeMenu();
  closeMenu();
  const m = $("#menu");
  m.innerHTML = menuHtml(kind);
  m.style.maxHeight = "";
  m.classList.add("open");
  menuFor = trigger; trigger.setAttribute("aria-expanded", "true");
  const r = trigger.getBoundingClientRect(), mw = m.offsetWidth;
  const want = kind === "sound" ? r.right - mw : r.left;
  const left = Math.max(12, Math.min(want, innerWidth - mw - 12));
  // A menu taller than the room on either side opens on the roomier side and scrolls.
  const roomAbove = r.top - 20, roomBelow = innerHeight - r.bottom - 20;
  const above = m.offsetHeight <= roomAbove || (m.offsetHeight > roomBelow && roomAbove > roomBelow);
  m.style.maxHeight = `${above ? roomAbove : roomBelow}px`;
  const mh = m.offsetHeight;
  m.style.left = `${left}px`;
  m.style.top = `${above ? r.top - mh - 8 : r.bottom + 8}px`;
  m.style.setProperty("--origin", `${r.left - left + r.width / 2}px ${above ? "100%" : "0"}`);
}
function closeMenu() {
  if (!menuFor) return;
  menuFor.setAttribute("aria-expanded", "false"); menuFor = null;
  $("#menu").classList.remove("open");
}
$("#menu").onclick = ev => {
  const b = ev.target.closest(".mi"); if (!b || b.disabled) return;
  if (b.dataset.v) { closeMenu(); selectProfile(b.dataset.v); }
  else if (b.dataset.e) { closeMenu(); selectEngine(b.dataset.e); }
  else if (b.dataset.mode) { state[MODES[state.engine].key] = b.dataset.mode; renderComposer(); renderPreflight(); renderDetail(); renderDialect(); renderCount(); renderControls(); }
  else if ("engines" in b.dataset) { closeMenu(); openEngines(); }
  else if ("newvoice" in b.dataset) { closeMenu(); openNewVoice(); }
  else if (b.dataset.sound) { closeMenu(); insertTag(b.dataset.sound); }
  else if (b.dataset.speaker) { closeMenu(); insertSpeaker(b.dataset.speaker); }
};
document.addEventListener("click", ev => {
  const t = ev.target.closest("[data-menu]");
  if (t) return openMenu(t.dataset.menu, t);
  if (menuFor && !ev.target.closest("#menu")) closeMenu();
});

// ---------- controls drawer ----------
// Every engine gets Speed (applied after generation); the rest are the engine's own sampling knobs.
// Only controls that apply in the current mode are shown and sent; the others keep their saved values for later.
const ownControls = engine => Object.keys(ENGINE_CONTROLS[engine] || {}).filter(k => CONTROL[k].when?.() ?? true);
function controlDefault(engine, key) {
  const d = key === "speed" ? 1 : ENGINE_CONTROLS[engine][key];
  return typeof d === "function" ? d() : d;
}
const changedControls = engine => prefs.controls?.[engine] || {};
const sentControls = engine => Object.fromEntries(Object.entries(changedControls(engine)).filter(([k]) => k === "speed" || ownControls(engine).includes(k)));
const controlValue = (engine, key) => changedControls(engine)[key] ?? controlDefault(engine, key);
const fmtControl = (key, v) => (key === "top_k" && v === 0 ? "no limit" : `${v.toFixed(CONTROL[key].digits ?? 2)}${CONTROL[key].unit || ""}`);
function setControl(engine, key, value) {
  prefs.controls ||= {};
  const mine = { ...changedControls(engine) };
  if (value == null || Math.abs(value - controlDefault(engine, key)) < 1e-9) delete mine[key]; else mine[key] = value;
  if (Object.keys(mine).length) prefs.controls[engine] = mine; else delete prefs.controls[engine];
}
const sliderPct = (key, v) => `${((v - CONTROL[key].min) / (CONTROL[key].max - CONTROL[key].min)) * 100}%`;
function controlCard(key) {
  const c = CONTROL[key], e = state.engine, v = controlValue(e, key), changed = key in changedControls(e);
  return `<div class="ctl" data-ctl="${key}">
    <div class="ctl-top">${icon16(c.icon)}<b id="ctl-${key}">${c.label}</b>
      ${changed ? `<button class="ctl-reset" data-reset="${key}" title="Back to ${fmtControl(key, controlDefault(e, key))}">Reset</button>` : ""}
      <span class="ctl-val ${changed ? "" : "def"}">${fmtControl(key, v)}</span></div>
    <input class="slider" type="range" min="${c.min}" max="${c.max}" step="${c.step}" value="${v}" aria-labelledby="ctl-${key}" style="--pct:${sliderPct(key, v)}">
    <p class="ctl-warn" ${controlRisk(e, key, v) ? "" : "hidden"}>${controlRisk(e, key, v) || ""}</p>
    <p>${c.hint} <span class="ctl-rec">Recommended for ${ENGINES[e].name}: ${fmtControl(key, controlDefault(e, key))}.</span></p></div>`;
}
function renderControls() {
  const e = ENGINES[state.engine], changed = Object.keys(changedControls(state.engine)).length;
  $("#controlsBtn .dot").hidden = !changed;
  if (!$("#controls").classList.contains("open")) return;
  const own = ownControls(state.engine);
  $("#controlsFor").textContent = `${e.full} · saved for this engine`;
  $("#controlsReset").disabled = !changed;
  $("#controlsBody").innerHTML = controlCard("speed")
    + (own.length ? `<p class="ctl-group">${e.name} sampling</p>` + own.map(controlCard).join("") : `<p class="ctl-none">${e.name} has no other settings to tweak yet.</p>`)
    + `<p class="ctl-group">Every engine</p><div class="ctl"><div class="ctl-top">${icon16("dice")}<b>Seed</b></div>
      <div class="row"><input class="num" id="seed" value="${state.seed}" inputmode="numeric" aria-label="Seed"><button class="btn small" id="reseed">New seed</button></div>
      <p>The same seed and text give the same take. A new seed gives a different reading of the same line. Saved with a voice's defaults.</p></div>`;
  $("#seed").oninput = ev => { state.seed = parseInt(ev.target.value, 10) || 0; renderDetail(); };
  $("#reseed").onclick = () => { state.seed = Math.floor(Math.random() * 99999); $("#seed").value = state.seed; renderDetail(); };
}
$("#controlsBody").addEventListener("input", e => {
  const card = e.target.closest("[data-ctl]"); if (!card || !e.target.matches(".slider")) return;
  const key = card.dataset.ctl, v = parseFloat(e.target.value);
  setControl(state.engine, key, v);
  e.target.style.setProperty("--pct", sliderPct(key, v));
  const val = card.querySelector(".ctl-val");
  val.textContent = fmtControl(key, v); val.classList.toggle("def", !(key in changedControls(state.engine)));
  const warn = card.querySelector(".ctl-warn"), why = controlRisk(state.engine, key, v);
  warn.hidden = !why; warn.textContent = why || "";
});
// Saving and the Reset links wait until the slider is let go, so dragging doesn't rebuild the card under the pointer.
$("#controlsBody").addEventListener("change", e => {
  if (!e.target.matches(".slider")) return;
  const key = e.target.closest("[data-ctl]").dataset.ctl;
  persistPrefs(); renderControls(); renderPreflight();
  $(`[data-ctl="${key}"] .slider`)?.focus({ preventScroll: true }); // arrow keys keep working after the rebuild
});
$("#controlsBody").addEventListener("click", e => {
  const r = e.target.closest("[data-reset]"); if (!r) return;
  setControl(state.engine, r.dataset.reset, null); persistPrefs(); renderControls(); renderPreflight();
});
$("#controlsReset").onclick = () => { delete prefs.controls?.[state.engine]; persistPrefs(); renderControls(); renderPreflight(); log(`${ENGINES[state.engine].name} is back to its default controls.`); };
function openControls() {
  closeMenu();
  const d = $("#controls"); d.classList.add("open"); d.inert = false;
  $("#controlsBtn").setAttribute("aria-expanded", "true");
  renderControls();
  d.querySelector(".slider")?.focus({ preventScroll: true });
}
function closeControls() {
  const d = $("#controls"); if (!d.classList.contains("open")) return;
  d.classList.remove("open"); d.inert = true;
  $("#controlsBtn").setAttribute("aria-expanded", "false");
}
const toggleControls = () => ($("#controls").classList.contains("open") ? closeControls() : openControls());

// ---------- takes ----------
const takeLabel =t => (state.blind && t.group ? `Take ${String.fromCharCode(65 + t.groupIndex)}` : `Take ${t.n}`);
function fileStem(t) {
  const v = voiceById(t.voice)?.name || "voice", e = ENGINES[t.engine].name;
  const date = new Date().toISOString().slice(0, 10);
  return { "date-voice-take": `${date} ${v} take ${t.n}`, take: `Take ${t.n}` }[prefs.names] || `${v} - ${e} - take ${t.n}`;
}
function renderTakes(revealId) {
  if (revealId && document.body.dataset.tab !== "takes" && phone.matches) $(".tab-dot").hidden = false;
  const list = $("#takeList");
  list.innerHTML = "";
  const unsaved = takes.filter(t => !t.pending && !t.saved).length;
  $("#unsaved").textContent = unsaved ? `${unsaved} unsaved` : "";
  if (!takes.length) { list.innerHTML = `<p class="empty">No takes yet. Write a script, pick a voice and press Ctrl Enter.</p>`; return; }
  let lastGroup = null;
  for (const t of [...takes].reverse()) {
    if (t.group && t.group !== lastGroup) {
      const g = document.createElement("div"); g.className = "group";
      g.textContent = `Comparison ${t.group}${state.blind ? " · engines hidden until you save one" : ""}`;
      list.append(g);
    }
    lastGroup = t.group || null;
    const v = voiceById(t.voice);
    const el = document.createElement("div");
    el.className = "take"; el.setAttribute("role", "option"); el.tabIndex = -1;
    el.dataset.id = t.id; el.setAttribute("aria-selected", t.id === state.take);
    const hide = state.blind && t.group && !t.saved;
    const who = `<span class="who">· ${hide ? "hidden" : ENGINES[t.engine].name} · ${escapeHtml(t.design ? "new voice" : v?.name || "deleted voice")}</span>`;
    if (t.pending) {
      const phase = { loading: `Loading ${ENGINES[t.engine].name} (${ENGINES[t.engine].real})`, unloading: "Freeing memory", generating: "Generating" }[state.engineState[t.engine]] || "Queued";
      el.innerHTML = `<div class="take-top"><span class="take-name">${takeLabel(t)} ${who}</span><span class="take-dur" data-elapsed></span></div>
        <div class="progress busy"><span></span></div><span class="take-status">${state.cancelling ? "Cancelling…" : phase} · Esc cancels</span>`;
    } else {
      el.innerHTML = `<div class="take-top"><span class="take-name">${takeLabel(t)} ${who}${t.saved ? `<span class="badge saved">Saved</span>` : ""}</span>
          <span class="take-dur">${t.seconds.toFixed(1)} s${hide ? "" : ` · made in ${t.elapsed.toFixed(1)} s`}</span></div>
        <canvas class="${t.id === revealId ? "reveal" : ""}"></canvas>
        <p class="take-text">${escapeHtml(hide ? t.shown : t.text)}</p>
        ${t.saved ? `<p class="take-path">${escapeHtml(t.saved)}</p>` : ""}
        <div class="take-actions">
          <button class="btn icon" data-act="play" title="${player.key === t.id && !audio.paused ? "Pause" : "Play"} (Space)" aria-label="Play or pause">${player.key === t.id && !audio.paused ? ICON.pause : ICON.play}</button>
          <button class="btn small" data-act="save" title="Ctrl S" ${t.saved ? "disabled" : ""}>${t.saved ? "Saved" : "Save"}</button>
          ${REMOTE ? "" : `<button class="btn small" data-act="saveas" title="Ctrl Shift S">Save as…</button>`}
          <button class="btn icon" data-act="again" title="Redo with a new seed" aria-label="Redo with a new seed" ${t.design ? "disabled" : ""}>${ICON.redo}</button>
          <button class="btn small" data-act="delete">Delete</button>
        </div>`;
    }
    el.onclick = e => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (act) return takeAction(t, act);
      if (e.target.tagName === "CANVAS" && t.id === state.take) { const r = e.target.getBoundingClientRect(); seek(t, (e.clientX - r.left) / r.width); return; }
      selectTake(t.id);
    };
    list.append(el);
    const c = el.querySelector("canvas"); if (c) requestAnimationFrame(() => paint(c, t.path, playedFraction(t.id)));
  }
}
const visibleTakes = () => [...takes].reverse().filter(t => !t.pending);
function selectTake(id) {
  if (player.key && player.key !== id && String(player.key).startsWith("clip:") === false) stopAudio();
  state.take = id; renderTakes();
  document.querySelector(`.take[data-id="${id}"]`)?.scrollIntoView({ block: "nearest" });
}
async function saveTake(t, as) {
  if (!t || t.pending) return;
  if (REMOTE) {
    // The take comes to this device as a download, converted to the format in Settings.
    const a = Object.assign(document.createElement("a"), { href: `/api/download?path=${encodeURIComponent(t.path)}&name=${encodeURIComponent(fileStem(t))}`, download: "" });
    document.body.append(a); a.click(); a.remove();
    t.saved = `Downloaded to this device as ${fileStem(t)}.${(prefs.format || "WAV").toLowerCase()}`;
    log(t.saved); renderTakes();
    return;
  }
  if (!as && t.saved) return;
  try {
    const path = await invoke(as ? "save_take_as" : "save_take", { path: t.path, name: fileStem(t) });
    if (!path) return;
    t.saved = path;
    log(state.blind && t.group ? `Saved ${takeLabel(t)}. It was ${ENGINES[t.engine].name}. ${path}` : `Saved to ${path}`);
    renderTakes();
  } catch (e) { log(String(e), true); }
}
async function takeAction(t, act) {
  trace(`take ${t.n}: ${act}`);
  if (act === "play") return togglePlay(t);
  if (act === "save") return saveTake(t, false);
  if (act === "saveas") return saveTake(t, true);
  if (act === "again") { state.seed = Math.floor(Math.random() * 99999); return generate(t.engine, { text: t.text, shown: t.shown, voice: t.voice, cast: t.cast }); }
  if (act === "delete") {
    if (player.key === t.id) stopAudio();
    takes = takes.filter(x => x !== t);
    if (!t.saved) invoke("delete_take", { path: t.path });
    state.take = visibleTakes()[0]?.id;
    renderTakes();
    log(t.saved ? `Removed Take ${t.n} from the list. The saved file stays.` : `Deleted Take ${t.n}.`);
  }
}

// ---------- playback ----------
const audio = new Audio();
const player = { key: null, path: null };
async function applyOutput() { if (prefs.output && audio.setSinkId) { try { await audio.setSinkId(prefs.output); } catch { /* device gone: keep default */ } } }
function playPath(path, key, from = 0) {
  if (player.key === key && !audio.paused) { audio.pause(); renderTakes(); return; }
  if (player.key !== key) { audio.src = fileSrc(path); player.key = key; player.path = path; }
  if (from) audio.currentTime = from * (audio.duration || 0);
  audio.play().catch(e => log(`Can't play: ${e.message}`, true));
  renderTakes(); tick();
}
function togglePlay(t) { playPath(t.path, t.id); }
function stopAudio() { audio.pause(); audio.currentTime = 0; player.key = null; renderTakes(); }
function seek(t, f) {
  if (player.key !== t.id) return playPath(t.path, t.id, f);
  if (audio.duration) audio.currentTime = f * audio.duration;
}
const playedFraction = id => (player.key === id && audio.duration ? audio.currentTime / audio.duration : 0);
function tick() {
  const t = takes.find(x => x.id === player.key);
  const c = t && document.querySelector(`.take[data-id="${t.id}"] canvas`);
  if (c) paint(c, t.path, playedFraction(t.id));
  if (!audio.paused) requestAnimationFrame(tick);
}
audio.onended = () => { player.key = null; renderTakes(); };

// ---------- generation ----------
async function generate(engine, opts = {}) {
  if (blocker(engine)) return;
  showTab("takes"); // on a phone, follow the take as it's made
  const v = voiceById(opts.voice) || currentVoice();
  const design = engine === "breeze" && state.breezeMode === "Design";
  state.busy = true; state.cancelling = false; renderPreflight(); logoBusy(true);
  const t = { id: `t${Date.now()}${Math.random()}`, n: state.nextN++, engine, voice: v.id, pending: true, design, saved: null,
              text: opts.text || scriptText(engine), shown: opts.shown || neutralText(), group: opts.group, groupIndex: opts.groupIndex,
              cast: opts.cast || (SCENE_ENGINES.includes(engine) ? sceneCast() : []) };
  takes.push(t); state.take = t.id; renderTakes();
  trace(`generate take ${t.n} with ${engine}${opts.group ? ` (comparison ${opts.group})` : ""}`);
  const t0 = performance.now();
  const timer = setInterval(() => { const el = document.querySelector(`.take[data-id="${t.id}"] [data-elapsed]`); if (el) el.textContent = `${((performance.now() - t0) / 1000).toFixed(0)} s`; }, 250);
  try {
    const r = await invoke("generate", { req: { engine, profileId: v.id, text: t.text, kittenStyle: state.kittenStyle, breezeMode: state.breezeMode, instruction: $("#instr").value.trim(), seed: state.seed, controls: sentControls(engine), cast: t.cast } });
    Object.assign(t, { pending: false, path: r.path, seconds: r.seconds, elapsed: r.elapsed });
    log(`${takeLabel(t)} is ready (${r.seconds.toFixed(1)} s of audio in ${r.elapsed.toFixed(1)} s).${matchMedia("(pointer: coarse)").matches ? "" : " Ctrl S saves it."}`);
    renderTakes(t.id);
    if (prefs.autoplay) playPath(t.path, t.id);
    return true;
  } catch (e) {
    takes = takes.filter(x => x !== t); state.take = visibleTakes()[0]?.id;
    log(String(e) === "Cancelled" ? "Cancelled. The engine will reload on the next take." : String(e), String(e) !== "Cancelled");
    renderTakes();
    return false;
  } finally {
    clearInterval(timer); state.busy = false; state.cancelling = false; renderPreflight(); logoBusy(false);
  }
}
async function compareAll() {
  const ids = compareSet();
  if (ids.length < 2) return;
  const group = state.compareN++;
  ids.sort((a, b) => (b === state.resident) - (a === state.resident)); // start with what's loaded
  const letters = ids.map((_, i) => i).sort(() => Math.random() - 0.5); // shuffled so order doesn't give it away
  for (let i = 0; i < ids.length; i++) {
    const ok = await generate(ids[i], { text: scriptText(ids[i]), group, groupIndex: letters[i] });
    if (!ok) break;
  }
}
function cancel() { if (!state.busy) return; state.cancelling = true; renderTakes(); invoke("cancel"); }

// ---------- recording ----------
let rec = null;
// Before the first clone (record, import, drop or upload): voices need their owner's permission. Asked once.
function consented() {
  if (prefs.consent) return Promise.resolve(true);
  return new Promise(done => {
    const finish = ok => {
      $("#consentDlg").classList.remove("open");
      if (ok) { prefs.consent = new Date().toISOString().slice(0, 10); persistPrefs(); }
      done(ok);
    };
    $("#ccOk").onclick = () => finish(true);
    $("#ccCancel").onclick = () => finish(false);
    $("#consentDlg").onkeydown = e => { if (e.key === "Escape") { e.stopPropagation(); finish(false); } };
    $("#consentDlg").classList.add("open"); $("#ccOk").focus();
  });
}
// The passage starts with the reader's name, so the clip is natural speech ("Hey, it's Mason.") and the name becomes the profile's.
function remembered(key) { try { return localStorage.getItem(key) || ""; } catch { return ""; } }
function remember(key, value) { try { localStorage.setItem(key, value); } catch { /* storage off: just not remembered */ } }
function renderPassageName() {
  const name = $("#recName").value.trim(), who = $("#recWho");
  who.textContent = name || "[Name]"; who.classList.toggle("empty", !name);
  $(".rec-name").classList.remove("missing");
}
// What the reader actually says: numbers as words ("6:30" is read "six thirty"), so the transcript matches the audio.
const spokenPassage = () => [...$("#passage").childNodes].map(n => n.dataset?.say ?? n.textContent).join("").replace(/\s+/g, " ").trim();
async function openRecorder() {
  if (!(await consented())) return;
  $("#recName").value = remembered("recName"); renderPassageName();
  $("#recorder").classList.add("open");
  ($("#recName").value ? $("#recToggle") : $("#recName")).focus();
}
function closeRecorder() {
  if (rec) { rec.stream.getTracks().forEach(t => t.stop()); rec.ctx.close(); clearInterval(rec.timer); rec = null; }
  $("#recorder").classList.remove("open");
  $("#recToggle").textContent = "Start recording"; $("#recTime").textContent = "0.0 s of 8 to 20 s"; $("#level").style.transform = "scaleX(0)";
}
async function toggleRecord() {
  if (!rec) {
    if (!navigator.mediaDevices) { log("Browsers only allow the microphone over HTTPS. On the PC running Mimic, share through Tailscale to record from this device.", true); return; }
    if (!$("#recName").value.trim()) { $(".rec-name").classList.add("missing"); $("#recName").focus(); log("Type the name you'll say first: the passage starts with it.", true); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: prefs.mic ? { exact: prefs.mic } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const node = ctx.createScriptProcessor(4096, 1, 1);
      const chunks = [];
      let level = 0;
      node.onaudioprocess = e => {
        const d = e.inputBuffer.getChannelData(0); chunks.push(new Float32Array(d));
        let s = 0; for (const x of d) s += x * x; level = Math.sqrt(s / d.length);
      };
      src.connect(node); node.connect(ctx.destination);
      const t0 = performance.now();
      rec = { stream, ctx, chunks, t0, timer: setInterval(() => {
        $("#recTime").textContent = `${((performance.now() - t0) / 1000).toFixed(1)} s of 8 to 20 s`;
        $("#level").style.transform = `scaleX(${Math.min(1, level * 6)})`;
      }, 90) };
      $("#recToggle").textContent = "Stop";
    } catch (e) { log(`The microphone isn't available: ${e.message}`, true); }
    return;
  }
  const { chunks, ctx } = rec, rate = ctx.sampleRate;
  const secs = (performance.now() - rec.t0) / 1000;
  const name = $("#recName").value.trim(), transcript = spokenPassage();
  closeRecorder();
  if (secs < 3) { log("That recording was under 3 seconds. Read the whole passage.", true); return; }
  remember("recName", name);
  try {
    const p = await invoke("save_recording", { wav: wavBase64(chunks, rate), transcript, name });
    replaceProfile(p); selectProfile(p.id);
    log(`Saved the voice "${p.name}". The transcript came from the passage you read.`);
  } catch (e) { log(String(e), true); }
}
function wavBase64(chunks, rate) {
  const n = chunks.reduce((a, c) => a + c.length, 0);
  const buf = new DataView(new ArrayBuffer(44 + n * 2));
  const str = (o, s) => [...s].forEach((c, i) => buf.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF"); buf.setUint32(4, 36 + n * 2, true); str(8, "WAVE"); str(12, "fmt ");
  buf.setUint32(16, 16, true); buf.setUint16(20, 1, true); buf.setUint16(22, 1, true); buf.setUint32(24, rate, true);
  buf.setUint32(28, rate * 2, true); buf.setUint16(32, 2, true); buf.setUint16(34, 16, true); str(36, "data"); buf.setUint32(40, n * 2, true);
  let o = 44;
  for (const c of chunks) for (const x of c) { buf.setInt16(o, Math.max(-1, Math.min(1, x)) * 0x7fff, true); o += 2; }
  const bytes = new Uint8Array(buf.buffer);
  let bin = ""; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// ---------- engines dialog ----------
function openEngines() { $("#enginesDlg").classList.add("open"); renderEngines(); }
function closeEngines() { $("#enginesDlg").classList.remove("open"); }
function renderEngines() {
  if (!$("#enginesDlg").classList.contains("open")) return;
  const gpu = hw.vramTotal ? `${hw.gpu}, ${hw.vramTotal.toFixed(0)} GB VRAM` : hw.gpu || "no dedicated GPU";
  $("#machine").innerHTML = `This PC: <b>${escapeHtml(gpu)}</b>, <b>${escapeHtml(hw.cpu || "CPU")}</b>, ${hw.ramTotal.toFixed(0)} GB RAM. `
    + `Engines run on the <b>${DEVICE_NAME[device]}</b> (Settings › Run engines on). ${hw.note ? escapeHtml(hw.note) + " " : ""}Pin the ones you want in the top bar.`;
  const pins = pinnedIds();
  $("#engList").innerHTML = ALL.filter(listed).map(id => {
    const e = ENGINES[id], f = fit(id);
    const clone = e.transcript ? "Clones from clip + transcript" : "Clones from clip only";
    // Downloaded for another device (the setting changed): it runs on the CPU until it gets this device's PyTorch.
    const stale = typeof managed[id] === "string" && !e.cpuOnly && device !== "cpu" && managed[id] !== device;
    let fitText, cls;
    if (installing[id]) { fitText = installing[id]; cls = "busy"; }
    else if (!e.available) { fitText = e.note || "Not in this version yet"; cls = "na"; }
    else if (!f.ok) { fitText = `Won't fit: it ${f.why}`; cls = "no"; }
    else if (!installed[id]) { fitText = e.download ? `Fits this PC · ${e.note || ""}` : "Isn't set up in the engines folder"; cls = e.download ? "yes" : "no"; }
    else if (stale) { fitText = `Downloaded for the ${DEVICE_NAME[managed[id]] || managed[id]}, so it runs on the CPU until it gets the ${DEVICE_NAME[device]} build`; cls = "no"; }
    else { fitText = state.resident === id ? "Loaded" : `Ready${e.note ? " · " + e.note : ""}`; cls = "yes"; }
    const pin = installed[id] && e.available
      ? `<button class="btn icon" data-pin="${id}" aria-pressed="${pins.includes(id)}" title="${pins.includes(id) ? "Unpin from" : "Pin to"} the top bar">${PIN_ICON}</button>` : "";
    let action = "";
    if (installing[id]) action = `<button class="btn small" disabled>Downloading…</button>`;
    else if (stale) action = `<button class="btn small" data-install="${id}" title="Download PyTorch for the ${DEVICE_NAME[device]} into this engine">Get ${DEVICE_NAME[device]} build</button>`;
    else if (e.download && managed[id]) action = `<button class="btn small" data-remove="${id}">Remove</button>`;
    else if (e.download && !installed[id]) action = `<button class="btn small" data-install="${id}" ${f.ok ? "" : "disabled"}>Download</button>`;
    return `<div class="eng-row"><div><div class="n">${e.full}</div><div class="sub">${e.license} license${e.credit ? ` · ${e.credit}` : ""}${e.download && !installed[id] ? ` · ${e.download}` : ""}</div></div>
      <div><div>${memText(id)}</div><div class="sub">${clone}</div></div><div class="fit ${cls}">${escapeHtml(fitText)}</div><div class="row">${pin}${action}</div></div>`;
  }).join("");
  const stt = installing.stt ? `<span class="fit busy">${escapeHtml(installing.stt)}</span>`
    : installed.stt ? "Transcripts are written by local speech-to-text (faster-whisper) on the CPU. It never touches the GPU."
    : `Speech-to-text isn't installed, so clips need typed transcripts. <button class="btn small" data-install="stt">Download it (about 300 MB)</button>`;
  $("#sttLine").innerHTML = stt;
  $$("[data-pin]").forEach(b => (b.onclick = () => togglePin(b.dataset.pin)));
  $$("[data-install]").forEach(b => (b.onclick = () => installEngine(b.dataset.install)));
  $$("[data-remove]").forEach(b => (b.onclick = () => removeEngine(b.dataset.remove)));
}

const engineTitle = id => (id === "stt" ? "Speech-to-text" : ENGINES[id].full);
async function installEngine(id) {
  installing[id] = "Starting the download…"; renderEngines();
  log(`Downloading ${engineTitle(id)} for the ${DEVICE_NAME[device]}. This can take a while; you can keep using Mimic.`);
  try {
    ({ installed, managed } = await invoke("install_engine", { id }));
    delete installing[id];
    if (id !== "stt" && prefs.pinned?.length && !prefs.pinned.includes(id)) { prefs.pinned = [...prefs.pinned, id]; persistPrefs(); }
    log(`${engineTitle(id)} is ready.`);
  } catch (err) {
    delete installing[id];
    log(`Couldn't download ${engineTitle(id)}: ${err}`, true);
  }
  renderEngines(); renderTop(); renderVoices(); renderPreflight();
}
async function removeEngine(id) {
  if (!confirm(`Remove ${engineTitle(id)}? Its files are deleted from the engines folder. You can download it again later.`)) return;
  try { ({ installed, managed } = await invoke("remove_engine", { id })); log(`Removed ${engineTitle(id)}.`); }
  catch (err) { log(String(err), true); }
  if (state.engine === id) state.engine = ALL.find(usable) || state.engine;
  renderEngines(); renderTop(); renderVoices(); renderComposer(); renderPreflight();
}
listen("install", ({ payload }) => {
  installing[payload.id] = `Step ${payload.step} of ${payload.steps}: ${payload.label}`;
  renderEngines();
});

// ---------- settings ----------
async function persistPrefs() {
  // A browser's microphone and speakers are its own; the PC running Mimic keeps its choices.
  if (REMOTE) { remember("mic", prefs.mic || ""); remember("output", prefs.output || ""); }
  try { installed = await invoke("save_settings", { settings: prefs }); } catch (e) { log(String(e), true); }
}
const idleMinutes = () => ({ "5 minutes": 5, "10 minutes": 10, "30 minutes": 30 }[prefs.idle] ?? null);
// Caelestia's live Material You scheme (read from ~/.local/state/caelestia/scheme.json by the core).
let caelestia = null;
const CAELESTIA_MAP = {
  "--ground": "surface", "--surface": "surfaceContainerLow", "--surface-2": "surfaceContainer", "--surface-3": "surfaceContainerHighest",
  "--ink": "onSurface", "--ink-2": "onSurfaceVariant", "--ink-3": "outline", "--live": "primary", "--live-ink": "onPrimary",
  "--ready": "tertiary", "--warn": "error", "--wave": "outlineVariant", "--vram-os": "surfaceVariant",
  "--field": "surfaceContainerLowest", "--field-line": "outlineVariant",
};
function applyCaelestia(on) {
  const root = document.documentElement.style;
  for (const [token, key] of Object.entries(CAELESTIA_MAP)) {
    const value = on && caelestia?.colors?.[key];
    value ? root.setProperty(token, value) : root.removeProperty(token);
  }
}
function applyTheme() {
  const useCaelestia = prefs.theme === "Caelestia" && caelestia;
  const dark = useCaelestia ? caelestia.mode !== "light"
    : prefs.theme === "Dark" || (prefs.theme === "System" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  applyCaelestia(useCaelestia);
  document.documentElement.style.setProperty("--script-size", { Small: "28px", Medium: "34px", Large: "42px" }[prefs.scriptSize] || "34px");
  renderVoices(); renderTakes();
}
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => prefs.theme === "System" && applyTheme());
function toggleTheme() { prefs.theme = document.documentElement.dataset.theme === "light" ? "Dark" : "Light"; applyTheme(); persistPrefs(); }

const SET = {
  seg: (key, opts) => `<div class="seg" data-pref="${key}">${opts.map(o => `<button aria-pressed="${prefs[key] === o}">${o}</button>`).join("")}</div>`,
  sel: (key, opts) => `<select class="sel" data-pref="${key}">${opts.map(([v, l]) => `<option value="${escapeHtml(v)}" ${prefs[key] === v ? "selected" : ""}>${escapeHtml(l)}</option>`).join("")}</select>`,
  sw: key => `<button class="switch" role="switch" data-pref="${key}" aria-checked="${!!prefs[key]}"></button>`,
  secret: (key, placeholder) => `<input class="num secret" type="password" autocomplete="off" spellcheck="false" data-pref-text="${key}" value="${escapeHtml(prefs[key] || "")}" placeholder="${placeholder}">`,
  path: (key, title) => `<span class="path">${escapeHtml(prefs[key])}</span><button class="btn small" data-change="${key}" data-title="${title}">Change…</button>`,
};
const pairs = list => list.map(x => [x, x]);
const row = (t, d, control) => `<div class="set-row"><div><div class="t">${t}</div>${d ? `<div class="d">${d}</div>` : ""}</div><div class="row">${control}</div></div>`;
const section = (title, body) => `<section class="set-section"><h4>${title}</h4><div class="set-group">${body}</div></section>`;
let devices = { in: [], out: [] };
async function loadDevices() {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    const label = (d, i, kind) => d.label || `${kind} ${i + 1}`;
    devices.in = all.filter(d => d.kind === "audioinput" && d.deviceId !== "default" && d.deviceId !== "communications").map((d, i) => [d.deviceId, label(d, i, "Microphone")]);
    devices.out = all.filter(d => d.kind === "audiooutput" && d.deviceId !== "default" && d.deviceId !== "communications").map((d, i) => [d.deviceId, label(d, i, "Output")]);
  } catch { /* no devices */ }
}
function renderSettings() {
  const date = new Date().toISOString().slice(0, 10);
  $("#settingsBody").innerHTML =
    section("Appearance",
      row("Theme", caelestia ? "Caelestia follows your shell's colors and wallpaper." : `Dark, light, or follow ${platform === "windows" ? "Windows" : "the system"}.`,
        SET.seg("theme", caelestia ? ["Caelestia", "Dark", "Light", "System"] : ["Dark", "Light", "System"])) +
      row("Script text size", "How big the words you're writing look.", SET.seg("scriptSize", ["Small", "Medium", "Large"]))) +
    section("Commands",
      row("Command palette", "Every action in one searchable list.", `<button class="btn small" data-open="palette">Open <kbd>Ctrl K</kbd></button>`) +
      `<div class="keys"><span>Generate</span><kbd>Ctrl Enter</kbd><span>Play or pause the selected take</span><kbd>Space</kbd>
        <span>Save take / Save as</span><kbd>Ctrl S · Ctrl Shift S</kbd><span>Jump to a take</span><kbd>1-9 · J · K</kbd>
        <span>Blind comparison</span><kbd>B</kbd><span>Stop playback or cancel a take</span><kbd>Esc</kbd><span>Settings</span><kbd>Ctrl ,</kbd></div>`) +
    section("Saving takes",
      (REMOTE ? "" : row("Save folder", "Where Save puts takes. Save as… asks every time.", SET.path("saveDir", "Choose where Save puts takes"))) +
      row("File names", "", SET.sel("names", [["voice-engine-take", "Mason - Breeze - take 4"], ["date-voice-take", `${date} Mason take 4`], ["take", "Take 4"]])) +
      row("Format", "WAV keeps full quality. MP3 is smaller.", SET.seg("format", ["WAV", "FLAC", "MP3"])) +
      row("Warn about unsaved takes when closing", "", SET.sw("warnUnsaved"))) +
    section("Playback",
      row("Output device", "", SET.sel("output", [["", REMOTE ? "Default" : "Windows default"], ...devices.out])) +
      row("Play each take when it's ready", "", SET.sw("autoplay"))) +
    section("Engines and memory",
      row("Run engines on", `Automatic picks the ${DEVICE_NAME[hw.accel || "cpu"]} on this PC${hw.gpu ? ` (${escapeHtml(hw.gpu)})` : ""}. `
        + `${hw.note ? escapeHtml(hw.note) + " " : ""}After switching, Engines offers each downloaded engine's build for the new choice.`
        + `${hw.fix ? `<div class="fix">${escapeHtml(hw.fix)}</div>` : ""}`,
        SET.seg("device", hw.gpuAccel ? ["Automatic", "GPU", "CPU"] : ["Automatic", "CPU"])) +
      row("Unload the engine when idle for", "Frees memory for games and other apps.", SET.sel("idle", pairs(["5 minutes", "10 minutes", "30 minutes", "Never"]))) +
      row("Load the default engine when Mimic starts", "The first take comes faster, but memory is used right away.", SET.sw("preload")) +
      (REMOTE ? "" : row("Engines folder", "Model files and their Python environments.", SET.path("enginesDir", "Choose the engines folder")) +
        row("Hugging Face token", "Only for engines that need a free account (NeuTTS). Create a read token at huggingface.co › Settings › Access Tokens. It stays on this PC.", SET.secret("hfToken", "hf_…"))) +
      row("Engines", "", `<button class="btn small" data-open="engines">Open</button>`)) +
    section("Recording and transcripts",
      row("Microphone", "", SET.sel("mic", [["", REMOTE ? "Default" : "Windows default"], ...devices.in])) +
      row("Speech-to-text model", "Bigger is more accurate, smaller is faster. Runs on the CPU.", SET.sel("stt", pairs(["Automatic", "tiny", "base", "small", "medium"]))) +
      row("Transcript language", "", SET.sel("lang", [["English", "English"], ["Auto", "Detect automatically"]]))) +
    (REMOTE ? "" : shareSection() + section("About",
      row(`Mimic ${escapeHtml(version)}`, (update ? `Version ${escapeHtml(update.version)} is available.` : "Mimic checks GitHub for a new version each time it starts.")
        + " MIT license. KittenTTS is powered by Stellon Labs; every engine keeps its own license (see Engines).",
        update ? `<button class="btn small" data-update="open">Install ${escapeHtml(update.version)}</button>` : `<button class="btn small" data-update="check">Check for updates</button>`)));
}

// ---------- use from another device ----------
// Nothing is shared until one of these buttons is pressed. The link carries a secret; "New link" replaces it.
let share = { on: false };
function shareSection() {
  if (!share.on) {
    return section("Use from another device",
      row("Share this PC's Mimic", "Open Mimic in a browser on a laptop or phone, with this PC's GPU doing the work. Nothing is shared until you start it, and it stops when Mimic closes.",
        `<button class="btn small" data-share="lan" ${share.busy ? "disabled" : ""}>This network</button><button class="btn small" data-share="tailscale" ${share.busy ? "disabled" : ""}>Anywhere (Tailscale)</button>`) +
      (share.error ? `<p class="share-error" role="alert">${withTailscaleLinks(share.error)}</p>`
        : `<p class="share-note">${share.busy ? escapeHtml(share.busy) : "<b>This network</b> works on the same Wi-Fi but isn't encrypted: others on that Wi-Fi could see your text and audio, or take over the session. Browsers also only allow the microphone over HTTPS, so record on this PC. <b>Anywhere</b> needs Tailscale signed in on both devices and is encrypted, so it's the one to use on shared Wi-Fi, and recording works there too."}</p>`) +
      tailscaleGuide());
  }
  const where = share.mode === "lan" ? "on this network" : "through Tailscale";
  const who = share.devices === 1 ? "1 device is connected" : `${share.devices || "No"} devices are connected`;
  const plain = share.mode === "lan" ? " This connection isn't encrypted, so use it only on a Wi-Fi you trust." : "";
  return section("Use from another device",
    row(`Sharing ${where}`, `${who}. Anyone with the link can use Mimic on this PC, so send it only to your own devices.${plain}`, `<button class="btn small" data-share="stop">Stop sharing</button>`) +
    `<div class="share-link"><input readonly value="${escapeHtml(share.url)}" aria-label="Link"><button class="btn small" data-share="copy">Copy</button><button class="btn small" data-share="new" title="The old link stops working">New link</button></div>`);
}
// Tailscale's pages in an error ("Get it from https://tailscale.com/download") become buttons that open the browser.
const withTailscaleLinks = text => escapeHtml(text).replace(/https:\/\/(login\.)?tailscale\.com\/[^\s"<]*[^\s"<.,]/g,
  url => `<button class="link" data-url="${url}">${url.includes("download") ? "Download Tailscale" : "Turn on HTTPS"}</button>`);
// The button doesn't install Tailscale or sign anyone in (that needs an administrator and an account); it only
// gives Mimic an HTTPS address on the tailnet. This says what to do first. Open when Tailscale is the problem.
function tailscaleGuide() {
  const open = share.error && share.errorMode === "tailscale" ? "open" : "";
  return `<details class="share-help" ${open}><summary>How to set up Anywhere (Tailscale)</summary><ol>
    <li><b>Install Tailscale</b> on this PC and on your laptop or phone. <button class="link" data-url="https://tailscale.com/download">Download Tailscale</button></li>
    <li><b>Sign in with the same account</b> on both. Your devices can then reach each other from any network.</li>
    ${platform === "linux" ? `<li><b>Let Mimic set up sharing</b> by running this once: <code>sudo tailscale set --operator=$USER</code></li>` : ""}
    <li><b>Press Anywhere (Tailscale).</b> The first time, Tailscale asks you to turn on HTTPS for your devices; Mimic shows that link here.</li>
  </ol><p>Mimic doesn't install Tailscale or sign you in. It only adds an HTTPS address for itself while sharing is on, and removes it when you stop.</p></details>`;
}
async function shareAction(act) {
  try {
    if (act === "copy") {
      await navigator.clipboard.writeText(share.url).catch(() => { $(".share-link input").select(); document.execCommand("copy"); });
      return log("Copied the link. Open it on your other device.");
    }
    if (act === "lan" || act === "tailscale") {
      share = { on: false, busy: act === "lan" ? "Starting…" : "Setting up Tailscale…" }; renderSettings();
      share = await invoke("remote_start", { mode: act });
      log("Sharing is on. Copy the link and open it on your other device.");
    }
    if (act === "stop") { share = await invoke("remote_stop"); log("Stopped sharing."); }
    if (act === "new") { share = await invoke("remote_new_link"); log("Made a new link. The old one no longer works."); }
  } catch (e) {
    share = { ...(await invoke("remote_status")), error: String(e), errorMode: act };
    log(String(e), true);
  }
  renderSettings();
}
listen("remote", ({ payload }) => { share = payload; if ($("#settingsDlg").classList.contains("open")) renderSettings(); });
async function openSettings() {
  await loadDevices();
  if (!REMOTE) share = await invoke("remote_status");
  renderSettings(); $("#settingsDlg").classList.add("open");
}
function closeSettings() { $("#settingsDlg").classList.remove("open"); }
$("#settingsBody").addEventListener("click", async e => {
  const segBtn = e.target.closest(".seg[data-pref] button");
  if (segBtn) { prefs[segBtn.parentElement.dataset.pref] = segBtn.textContent; return afterPref(segBtn.parentElement.dataset.pref); }
  const sw = e.target.closest(".switch"); if (sw) { prefs[sw.dataset.pref] = !prefs[sw.dataset.pref]; return afterPref(sw.dataset.pref); }
  const ch = e.target.closest("[data-change]");
  if (ch) { const p = await invoke("pick_folder", { title: ch.dataset.title }); if (p) { prefs[ch.dataset.change] = p; afterPref(ch.dataset.change); } return; }
  const op = e.target.closest("[data-open]"); if (op) { closeSettings(); op.dataset.open === "palette" ? openPalette() : openEngines(); }
  const sh = e.target.closest("[data-share]"); if (sh) return shareAction(sh.dataset.share);
  const url = e.target.closest("[data-url]"); if (url) return invoke("open_tailscale_page", { url: url.dataset.url }).catch(err => log(String(err), true));
  const up = e.target.closest("[data-update]");
  if (up) {
    if (up.dataset.update === "open") { closeSettings(); return openUpdate(); }
    up.disabled = true; up.textContent = "Checking…";
    await checkUpdate(true);
    if (update) { closeSettings(); openUpdate(); } else { renderSettings(); log("Mimic is up to date."); }
  }
});
$("#settingsBody").addEventListener("change", e => {
  const t = e.target.closest("[data-pref-text]");
  if (t) { prefs[t.dataset.prefText] = t.value.trim(); persistPrefs(); log("Saved the Hugging Face token."); return; } const s = e.target.closest("select[data-pref]"); if (s) { prefs[s.dataset.pref] = s.value; afterPref(s.dataset.pref); } });
async function afterPref(key) {
  if (key === "theme" || key === "scriptSize") applyTheme();
  if (key === "output") applyOutput();
  await persistPrefs();
  if (key === "device") {
    // The loaded engine is on the old device; drop it and re-read where models run now.
    await invoke("unload");
    ({ device } = await invoke("bootstrap"));
    log(`Engines now run on the ${DEVICE_NAME[device]}.`);
  }
  if (key === "enginesDir" || key === "device") { renderTop(); renderVoices(); renderComposer(); renderPreflight(); }
  renderSettings();
}

// ---------- command palette ----------
const COMMANDS = () => [
  { label: "Generate", key: "Ctrl Enter", run: () => generate(state.engine) },
  { label: "Save take", key: "Ctrl S", run: () => saveTake(takes.find(x => x.id === state.take), false) },
  { label: "Save take as…", key: "Ctrl Shift S", run: () => saveTake(takes.find(x => x.id === state.take), true) },
  { label: "Compare engines", key: "", run: compareAll },
  ...ALL.filter(usable).map(id => ({ label: `Switch to ${ENGINES[id].name}`, key: "", run: () => selectEngine(id) })),
  { label: "Unload engine (free memory)", key: "", run: () => invoke("unload") },
  { label: "New voice", key: "", run: openNewVoice },
  { label: "Record a voice", key: "", run: openRecorder },
  { label: "Import a clip", key: "", run: () => importClip() },
  { label: "Controls (speed, sampling, seed)", key: "", run: openControls },
  { label: "Check for updates", key: "", run: () => checkUpdate(false) },
  { label: "Engines", key: "", run: openEngines },
  { label: state.blind ? "Show engine names" : "Blind comparison", key: "B", run: toggleBlind },
  { label: "Switch theme", key: "", run: toggleTheme },
  { label: "Settings", key: "Ctrl ,", run: openSettings },
];
let palIndex = 0;
function openPalette() { $("#palette").classList.add("open"); $("#paletteInput").value = ""; palIndex = 0; renderPalette(); $("#paletteInput").focus(); }
const closePalette = () => $("#palette").classList.remove("open");
const paletteItems = () => { const q = $("#paletteInput").value.toLowerCase(); return COMMANDS().filter(c => c.label.toLowerCase().includes(q)); };
function renderPalette() {
  const items = paletteItems(); palIndex = Math.min(palIndex, Math.max(0, items.length - 1));
  $("#paletteList").innerHTML = items.map((c, i) => `<li aria-selected="${i === palIndex}" data-i="${i}"><span>${c.label}</span><span>${c.key}</span></li>`).join("") || `<li><span>No command matches.</span></li>`;
}
function runPalette(i) { const c = paletteItems()[i]; closePalette(); if (c) { trace(`palette: ${c.label}`); c.run(); } }

function toggleBlind() { state.blind = !state.blind; $("#blindBtn").setAttribute("aria-pressed", state.blind); $("#blindBtn").firstChild.textContent = state.blind ? "Blind on " : "Blind "; renderTakes(); }

// ---------- wiring ----------
$("#script").addEventListener("input", () => { renderCount(); renderPreflight(); });
$("#instr").oninput = renderPreflight;
$("#genBtn").onclick = e => { trace(`Generate button (${e.detail ? "mouse" : "keyboard"}, focus ${document.activeElement?.id || document.activeElement?.tagName})`); generate(state.engine); };
$("#compareBtn").onclick = compareAll;
$("#blindBtn").onclick = toggleBlind;
$("#settingsBtn").onclick = openSettings;
$("#settingsClose").onclick = closeSettings;
$("#newVoiceBtn").onclick = openNewVoice;
$("#nvRecord").onclick = () => { closeNewVoice(); openRecorder(); };
$("#nvImport").onclick = () => { closeNewVoice(); importClip(); };
$("#nvCancel").onclick = closeNewVoice;
$("#controlsBtn").onclick = toggleControls;
$("#controlsClose").onclick = closeControls;
$("#updateBtn").onclick = openUpdate;
$("#upLater").onclick = closeUpdate;
$("#upInstall").onclick = installUpdate;
$("#recToggle").onclick = toggleRecord;
$("#recCancel").onclick = closeRecorder;
$("#recName").oninput = renderPassageName;
$("#recName").onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); toggleRecord(); } };
$("#paletteInput").oninput = () => { palIndex = 0; renderPalette(); };
$("#paletteList").onclick = e => { const li = e.target.closest("li[data-i]"); if (li) runPalette(+li.dataset.i); };
for (const [id, close] of [["palette", closePalette], ["recorder", closeRecorder], ["enginesDlg", closeEngines], ["settingsDlg", closeSettings], ["newVoiceDlg", closeNewVoice], ["updateDlg", closeUpdate]])
  $("#" + id).onclick = e => { if (e.target.id === id) close(); };

document.addEventListener("keydown", e => {
  const typing = e.target.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName);
  const key = e.key.toLowerCase();
  if (menuFor && e.key === "Escape") { const t = menuFor; closeMenu(); t.focus(); return; }
  if (e.ctrlKey && key === "k") { e.preventDefault(); $("#palette").classList.contains("open") ? closePalette() : openPalette(); return; }
  if ($("#palette").classList.contains("open")) {
    if (e.key === "Enter") trace(`palette Enter with "${$("#paletteInput").value}"`);
    const n = paletteItems().length;
    if (e.key === "Escape") closePalette();
    else if (e.key === "ArrowDown") { palIndex = (palIndex + 1) % n; renderPalette(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { palIndex = (palIndex - 1 + n) % n; renderPalette(); e.preventDefault(); }
    else if (e.key === "Enter") runPalette(palIndex);
    return;
  }
  if ($("#recorder").classList.contains("open")) { if (e.key === "Escape") closeRecorder(); return; }
  if ($("#newVoiceDlg").classList.contains("open")) { if (e.key === "Escape") closeNewVoice(); return; }
  if ($("#updateDlg").classList.contains("open")) { if (e.key === "Escape") closeUpdate(); return; }
  if ($("#enginesDlg").classList.contains("open")) { if (e.key === "Escape") closeEngines(); return; }
  if (e.ctrlKey && e.key === ",") { e.preventDefault(); openSettings(); return; }
  if ($("#settingsDlg").classList.contains("open")) { if (e.key === "Escape") closeSettings(); return; }
  if (e.ctrlKey && key === "s") { e.preventDefault(); saveTake(takes.find(x => x.id === state.take), e.shiftKey); return; }
  if (e.ctrlKey && e.key === "Enter") { e.preventDefault(); trace(`Ctrl+Enter (repeat ${e.repeat})`); generate(state.engine); return; }
  if (e.key === "Escape" && $("#controls").contains(e.target)) { closeControls(); $("#controlsBtn").focus(); return; }
  if (e.key === "Escape") { if (state.busy) cancel(); else if ($("#controls").classList.contains("open")) closeControls(); else stopAudio(); if (typing) e.target.blur(); return; }
  if (typing) return;
  const vis = visibleTakes(), i = vis.findIndex(t => t.id === state.take);
  if (e.key === " ") { e.preventDefault(); const t = takes.find(x => x.id === state.take); if (t && !t.pending) togglePlay(t); }
  else if (/^[1-9]$/.test(e.key) && vis[+e.key - 1]) selectTake(vis[+e.key - 1].id);
  else if (key === "j" && vis[i + 1]) selectTake(vis[i + 1].id);
  else if (key === "k" && i > 0) selectTake(vis[i - 1].id);
  else if (key === "b") toggleBlind();
});
addEventListener("resize", () => { renderVoices(); renderTakes(); });

// ---------- phone layout: one panel at a time ----------
const phone = matchMedia("(max-width: 959px)"); // phones and tablets in portrait; matches style.css
function showTab(tab) {
  if (!phone.matches) return;
  document.body.dataset.tab = tab;
  $$(".tabs [data-tab]").forEach(b => b.setAttribute("aria-pressed", b.dataset.tab === tab));
  if (tab === "takes") $(".tab-dot").hidden = true;
  if (tab === "voices") renderVoices(); // canvases drawn while hidden have no size
  if (tab === "takes") renderTakes();
}
document.body.dataset.tab = "script";
$$(".tabs [data-tab]").forEach(b => (b.onclick = () => showTab(b.dataset.tab)));

// ---------- events from the core ----------
listen("engine", ({ payload }) => {
  state.engineState[payload.id] = payload.state;
  if (payload.state === "warm" || payload.state === "generating" || payload.state === "loading") state.resident = payload.id;
  if (payload.state === "cold" && state.resident === payload.id) state.resident = null;
  renderTop(); renderPreflight();
  if (state.busy) renderTakes();
});
listen("hardware", ({ payload }) => {
  const gpuChanged = Math.round(payload.hardware.vramTotal) !== Math.round(hw.vramTotal);
  hw = payload.hardware;
  state.idleLeft = payload.idleLeft;
  if (gpuChanged) { renderTop(); renderVoices(); renderPreflight(); } else renderBar();
  const s = state.idleLeft, r = state.resident;
  $("#idle").textContent = r && s != null && !state.busy ? `${ENGINES[r].name} unloads after ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} idle` : "";
});
listen("log", ({ payload }) => log(payload));
// An engine asked for the GPU but its PyTorch couldn't use it, so it loaded on the CPU. Say why and how to fix it.
listen("fallback", ({ payload }) => {
  const name = ENGINES[payload.id]?.name || payload.id, build = payload.fallback.build, target = DEVICE_NAME[device];
  log(build !== device
    ? `${name} is running on the CPU: it was downloaded for the ${DEVICE_NAME[build] || build}. Open Engines and choose "Get ${target} build".`
    : `${name} is running on the CPU: PyTorch couldn't reach the ${target}. ${hw.fix || "Check that the GPU's driver is installed and working, then restart Mimic."}`, true);
});
listen("caelestia", ({ payload }) => { caelestia = payload; if (prefs.theme === "Caelestia") applyTheme(); });

// ---------- logo: the M talks now and then, and keeps talking while a take is made ----------
const calm = matchMedia("(prefers-reduced-motion: reduce)");
const talk = () => { if (!calm.matches) $("#logoMark").classList.add("talk"); };
// The loop repeats while a take is being made and stops at the end of a loop, where the bars spell M again.
$("#logoMark").addEventListener("animationiteration", e => {
  if (e.target === $("#logoMark").firstElementChild && !state.busy) $("#logoMark").classList.remove("talk");
});
const logoBusy = on => on && talk();
(function idleTalk() { setTimeout(() => { if (!document.hidden) talk(); idleTalk(); }, 25000 + Math.random() * 20000); })();

// ---------- startup splash ----------
const shownAt = performance.now();
function hideSplash() {
  const s = $("#splash"); if (!s) return;
  setTimeout(() => {
    s.classList.add("out");
    s.addEventListener("transitionend", () => s.remove(), { once: true });
    setTimeout(() => s.remove(), 600); // in case the transition never runs
  }, Math.max(0, 1100 - (performance.now() - shownAt)));
}

// ---------- updates ----------
let update = null; // { version, current, notes } when a newer release exists
function notesHtml(md) {
  // Release notes are Markdown; headings and bullet lists are enough here.
  let html = "", list = false;
  for (const line of md.split("\n")) {
    const bullet = /^\s*[-*]\s+(.*)/.exec(line), head = /^#{1,6}\s+(.*)/.exec(line);
    if (list && !bullet) { html += "</ul>"; list = false; }
    if (bullet) { if (!list) { html += "<ul>"; list = true; } html += `<li>${escapeHtml(bullet[1])}</li>`; }
    else if (head) html += `<h5>${escapeHtml(head[1])}</h5>`;
    else if (line.trim()) html += `<p>${escapeHtml(line)}</p>`;
  }
  return html + (list ? "</ul>" : "");
}
async function checkUpdate(quiet) {
  try { update = await invoke("check_update"); }
  catch (e) { if (!quiet) log(String(e), true); return; }
  $("#updateBtn").hidden = !update;
  if (update) {
    $("#updateBtn").textContent = `Update to ${update.version}`;
    if (!quiet) openUpdate();
  } else if (!quiet) log("Mimic is up to date.");
}
function openUpdate() {
  if (!update) return;
  const unsaved = takes.filter(t => !t.pending && !t.saved).length;
  const pm = update.packageManager; // e.g. "pacman": that package manager updates Mimic, not Mimic itself
  $("#upTitle").textContent = pm ? `Mimic ${update.version} is out` : `Mimic ${update.version} is ready to install`;
  $("#upCurrent").textContent = pm
    ? `You have ${update.current}, installed with ${pm}. Update it the same way: set pkgver=${update.version} in packaging/arch/PKGBUILD, then run makepkg -si there.`
    : `You have ${update.current}. Mimic downloads the new version, installs it and opens again.`;
  $("#upInstall").hidden = !!pm;
  $("#upLater").textContent = pm ? "Close" : "Later";
  $("#upNotes").innerHTML = notesHtml(update.notes || "");
  $("#upWarn").hidden = !unsaved || !!pm;
  $("#upWarn").textContent = `${unsaved} unsaved take${unsaved === 1 ? " is" : "s are"} cleared when Mimic restarts. Save ${unsaved === 1 ? "it" : "them"} first if you want to keep ${unsaved === 1 ? "it" : "them"}.`;
  $("#upStatus").textContent = ""; $(".up-progress").hidden = true;
  $("#upInstall").disabled = false; $("#upLater").disabled = false;
  $("#updateDlg").classList.add("open");
  (pm ? $("#upLater") : $("#upInstall")).focus();
}
function closeUpdate() { if (!$("#upInstall").disabled) $("#updateDlg").classList.remove("open"); }
async function installUpdate() {
  $("#upInstall").disabled = true; $("#upLater").disabled = true;
  $(".up-progress").hidden = false; $("#upBar").style.transform = "scaleX(0)";
  $("#upStatus").textContent = "Downloading…";
  trace(`installing update ${update.version}`);
  try {
    await invoke("install_update"); // restarts Mimic when it's done
    $("#upStatus").textContent = "Restarting…";
  } catch (e) {
    $("#upStatus").textContent = String(e);
    $("#upInstall").disabled = false; $("#upLater").disabled = false;
  }
}
listen("update-progress", ({ payload }) => {
  if (!payload.total) { $("#upStatus").textContent = `Downloading… ${(payload.done / 1e6).toFixed(1)} MB`; return; }
  $("#upBar").style.transform = `scaleX(${payload.done / payload.total})`;
  $("#upStatus").textContent = payload.done >= payload.total ? "Installing…" : `Downloading… ${Math.round(payload.done / payload.total * 100)}%`;
});

// Ask before closing with unsaved takes (a browser shows its own "leave this page?" prompt).
const unsavedCount = () => takes.filter(t => !t.pending && !t.saved).length;
if (REMOTE) addEventListener("beforeunload", e => { if (prefs.warnUnsaved && unsavedCount()) e.preventDefault(); });
else window.__TAURI__.window.getCurrentWindow().onCloseRequested(e => {
  const unsaved = unsavedCount();
  if (prefs.warnUnsaved && unsaved && !confirm(`${unsaved} take${unsaved > 1 ? "s are" : " is"} not saved and will be lost. Close Mimic anyway?`)) e.preventDefault();
});

// ---------- start ----------
let version = "";
async function start() {
  const b = await invoke("bootstrap");
  version = b.version || "";
  prefs = b.settings; profiles = b.profiles; installed = b.installed; hw = b.hardware;
  if (REMOTE) { prefs.mic = remembered("mic"); prefs.output = remembered("output"); document.title = "Mimic (remote)"; }
  managed = b.managed || {}; device = b.device || "cpu"; platform = b.platform || "windows"; caelestia = b.caelestia || null;
  if (b.resident) { state.resident = b.resident; state.engineState[b.resident] = "warm"; }
  state.voice = voiceById(prefs.lastProfile) ? prefs.lastProfile : profiles[0]?.id;
  const d = currentVoice()?.defaults;
  if (d) Object.assign(state, { kittenStyle: d.kittenStyle, breezeMode: d.breezeMode, seed: d.seed, engine: usable(d.engine) ? d.engine : state.engine });
  if (!usable(state.engine)) state.engine = ALL.find(usable) || "kitten";
  applyTheme(); applyOutput();
  renderTop(); renderComposer(); renderDialect(); renderCount(); renderPreflight(); renderTakes(); renderControls();
  hideSplash();
  // Clips that were mid-transcription when Mimic last closed get another go.
  profiles.filter(p => p.tx === "transcribing").forEach(transcribe);
  const ready = ALL.filter(usable).map(id => ENGINES[id].name);
  // A GPU that could run models with one more install (driver, runtime, group) is worth saying at startup.
  const gpuFix = hw.fix ? ` ${hw.note} ${hw.fix}` : "";
  const where = REMOTE ? `Connected to the PC running Mimic${hw.gpu ? ` (${hw.gpu})` : ""}. Engines there` : "Engines on this PC";
  log(ready.length ? `Ready. ${where}: ${ready.join(", ")}.${gpuFix}` : `No engines found. Check the engines folder in Settings.${gpuFix}`, !ready.length);
  if (prefs.preload && usable(state.engine) && !state.resident) invoke("preload", { engine: state.engine }).catch(e => log(String(e), true));
}
// Scripted test runs (MIMIC_TEST="engine:kitten;voice:Bruno;generate;save") drive the UI from inside,
// so testing never has to send keystrokes to the desktop.
async function selfTest(script) {
  prefs.consent ||= "test run";
  for (const step of script.split(";").map(s => s.trim()).filter(Boolean)) {
    const [cmd, arg] = step.split(/:(.*)/s);
    trace(`test: ${step}`);
    if (cmd === "import") await importClip(arg);
    else if (cmd === "delete-voice") { const v = profiles.find(p => p.name.toLowerCase().includes(arg.toLowerCase())); if (v) { await invoke("delete_profile", { id: v.id }); profiles = profiles.filter(p => p !== v); state.voice = profiles[0]?.id; renderVoices(); } }
    else if (cmd === "pin") togglePin(arg);
    else if (cmd === "engine") selectEngine(arg);
    else if (cmd === "voice") { const v = profiles.find(p => p.name.toLowerCase().includes(arg.toLowerCase())); if (v) selectProfile(v.id); }
    else if (cmd === "text") { $("#script").textContent = arg; renderCount(); renderPreflight(); }
    else if (cmd === "add") $("#script").append(` ${arg}`);
    else if (cmd === "sound") insertTag(arg);
    else if (cmd === "speaker") { const v = profiles.find(p => p.name.toLowerCase().includes(arg.toLowerCase())); if (v) insertSpeaker(v.id); }
    else if (cmd === "type") { // types like a person, for demo recordings
      $("#script").textContent = "";
      for (const ch of arg) { $("#script").textContent += ch; renderCount(); await new Promise(r => setTimeout(r, 38)); }
      renderPreflight();
    }
    else if (cmd === "play") { const t = takes.find(x => x.id === state.take); if (t) togglePlay(t); }
    else if (cmd === "theme") { prefs.theme = arg; applyTheme(); }
    else if (cmd === "generate") { const ok = await generate(state.engine); trace(`test: generate -> ${ok} ${$("#log").textContent}`); }
    else if (cmd === "compare") { await compareAll(); trace(`test: compare -> ${takes.length} takes`); }
    else if (cmd === "save") await saveTake(takes.find(x => x.id === state.take), false);
    else if (cmd === "engines") openEngines();
    else if (cmd === "mode") { state[MODES[state.engine].key] = arg; renderComposer(); renderPreflight(); renderControls(); }
    else if (cmd === "instr") { $("#instr").value = arg; renderPreflight(); }
    else if (cmd === "newvoice") openNewVoice();
    else if (cmd === "controls") openControls();
    else if (cmd === "control") { const [k, v] = arg.split("="); setControl(state.engine, k, v === "" ? null : parseFloat(v)); persistPrefs(); renderControls(); }
    else if (cmd === "update" || cmd === "update-pacman") { update = { version: "9.9.9", current: version, notes: (arg || "").replaceAll("|", "\n"), packageManager: cmd === "update-pacman" ? "pacman" : null }; $("#updateBtn").hidden = false; $("#updateBtn").textContent = "Update to 9.9.9"; openUpdate(); } // debug builds never see a real one
    else if (cmd === "settings") await openSettings();
    else if (cmd === "share") await shareAction(arg);
    else if (cmd === "scroll") [...$$(".set-row .t")].find(t => t.textContent === arg)?.scrollIntoView({ block: "center" });
    else if (cmd === "recorder") { await openRecorder(); if (arg) { $("#recName").value = arg; renderPassageName(); } }
    else if (cmd === "consent") prefs.consent = arg; // "consent:" shows the notice again
    else if (cmd === "wait") await new Promise(r => setTimeout(r, +arg || 1000));
  }
  trace("test: done");
}
start().then(async () => {
  const s = await invoke("test_script");
  if (s) selfTest(s); else if (!REMOTE) checkUpdate(true);
}).catch(e => { hideSplash(); log(`Mimic couldn't start: ${e}`, true); });
