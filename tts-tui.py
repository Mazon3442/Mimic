"""Terminal GUI for KittenTTS 2 and Breeze TTS 2. Start it with launchers\\tts.cmd (uses tui-env; the models run in their own venvs)."""
import asyncio
import json
import os
import sys
import time
import winsound
from pathlib import Path

import soundfile as sf
from textual.app import App, ComposeResult
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.coordinate import Coordinate
from textual.widgets import (
    Button, Checkbox, DataTable, Footer, Header, Input, Label, RichLog, Select, Static, TabbedContent, TabPane, TextArea,
)

CODE = Path(__file__).resolve().parent  # this repo: the TUI and its workers
ROOT = Path(os.environ.get("TTS_HOME", r"C:\Users\mason\tts"))  # venvs, models, refs/, out/, logs/
REFS = ROOT / "refs"  # converted copies of reference clips
DEFAULT_TEXT = "Hello! This is a quick test of the voice. <laugh> Pretty good, right?"

# Native Windows dialogs run in a throwaway process so Tk never touches the terminal UI.
FILE_DIALOG = (
    "import sys, tkinter as tk\nfrom tkinter import filedialog\n"
    "r = tk.Tk(); r.withdraw(); r.attributes('-topmost', True); r.focus_force()\n"
    "kind, title, start = sys.argv[1:4]\n"
    "if kind == 'dir':\n    p = filedialog.askdirectory(title=title, initialdir=start)\n"
    "else:\n    p = filedialog.askopenfilename(title=title, initialdir=start, filetypes=["
    "('Audio files', '*.wav *.mp3 *.flac *.ogg *.m4a *.aac *.opus *.wma *.mp4'), ('All files', '*.*')])\n"
    "print(p or '')\n"
)


async def run_dialog(kind: str, title: str, start: Path) -> str:
    proc = await asyncio.create_subprocess_exec(
        sys.executable, "-c", FILE_DIALOG, kind, title, str(start), stdout=asyncio.subprocess.PIPE
    )
    out, _ = await proc.communicate()
    return out.decode("utf-8", "replace").strip()


class Engine:
    """One model worker process (its own venv), kept alive so the model loads only once."""

    def __init__(self, name: str, env_dir: str, script: str):
        self.name = name
        self.argv = [str(ROOT / env_dir / "Scripts" / "python.exe"), "-X", "utf8", str(CODE / "tui" / script)]
        self.proc = None
        self.lock = asyncio.Lock()

    @property
    def running(self) -> bool:
        return self.proc is not None and self.proc.returncode is None

    async def start(self) -> dict:
        (ROOT / "logs").mkdir(exist_ok=True)
        err = open(ROOT / "logs" / f"tui-{self.name}.err.log", "ab")
        self.proc = await asyncio.create_subprocess_exec(
            *self.argv, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=err, cwd=str(ROOT)
        )
        return await self._read()

    async def _read(self) -> dict:
        line = await self.proc.stdout.readline()
        if not line:
            raise RuntimeError(f"{self.name} worker exited (see logs/tui-{self.name}.err.log)")
        return json.loads(line)

    async def call(self, payload: dict) -> dict:
        async with self.lock:
            self.proc.stdin.write((json.dumps(payload) + "\n").encode())
            await self.proc.stdin.drain()
            return await self._read()

    async def stop(self):
        if not self.running:
            return
        self.proc.stdin.close()
        try:
            await asyncio.wait_for(self.proc.wait(), 5)
        except asyncio.TimeoutError:
            self.proc.kill()
        self.proc = None


class TTSApp(App):
    TITLE = "Mimic"
    SUB_TITLE = "Local voice cloning"
    CSS = """
    VerticalScroll { padding: 0 1; }
    Label { margin-top: 1; color: $text-muted; }
    #text { height: 7; }
    #breeze-panel { display: none; height: auto; }
    #kitten-panel { height: auto; }
    .buttons { height: 3; margin-top: 1; }
    .buttons Button { margin-right: 1; }
    #summary, #ref-path, #ref-info, #out-folder { margin-top: 1; }
    #summary { color: $accent; }
    #clips { height: 14; margin-top: 1; }
    #log { height: 10; margin-top: 1; border: round $primary; }
    #status { height: 1; padding: 0 1; background: $boost; }
    """
    BINDINGS = [
        ("f1", "tab('create')", "Create"),
        ("f2", "tab('cloning')", "Cloning"),
        ("f3", "tab('output')", "Output"),
        ("ctrl+g", "generate", "Generate"),
        ("ctrl+l", "play", "Play last"),
        ("ctrl+x", "stop_audio", "Stop sound"),
        ("ctrl+q", "quit", "Quit"),
    ]

    def __init__(self):
        super().__init__()
        self.engines = {
            "kitten": Engine("kitten", "kitten-env", "kitten_worker.py"),
            "breeze": Engine("breeze", "breeze-env", "breeze_worker.py"),
        }
        self.out_dir = ROOT / "out"
        self.last_output = None
        self.busy = False
        self.ref_original = None  # what the user picked
        self.ref_path = None  # wav actually sent to the models
        self.last_dir = Path.home() / "Downloads"

    # ---------------------------------------------------------------- layout
    def compose(self) -> ComposeResult:
        yield Header()
        with TabbedContent(initial="create"):
            with TabPane("Create  (F1)", id="create"):
                with VerticalScroll():
                    yield Label("Model")
                    yield Select(
                        [("KittenTTS 2  - built-in voices, clone from a clip", "kitten"),
                         ("Breeze TTS 2 - voice design, clone, or direction", "breeze")],
                        value="kitten", allow_blank=False, id="model",
                    )
                    yield Label("Text to speak")
                    yield TextArea(DEFAULT_TEXT, id="text")
                    with Vertical(id="kitten-panel"):
                        yield Label("Built-in voice (ignored while cloning is on)")
                        yield Select([("Bruno", "Bruno")], value="Bruno", allow_blank=False, id="voice")
                        yield Checkbox("Expressive preset  ([joyful] at the start, <laugh>, (((emphasis))))", id="expressive")
                    with Vertical(id="breeze-panel"):
                        yield Label("Voice description - designs a voice, or steers a cloned one (blank = plain clone)")
                        yield Input(placeholder="A warm, thoughtful young woman with a calm delivery.", id="b-instr")
                        with Horizontal():
                            yield Input(placeholder="cfg scale (auto: 4 with description, else 1)", id="b-cfg")
                            yield Input(placeholder="seed (42)", id="b-seed")
                    yield Static("", id="summary")
                    yield Label("Output file name (blank = automatic)")
                    yield Input(placeholder="my_clip.wav", id="outname")
                    yield Checkbox("Play automatically when done", value=True, id="autoplay")
                    with Horizontal(classes="buttons"):
                        yield Button("Generate  ^G", id="gen", variant="success")
                        yield Button("Play last  ^L", id="play")
                        yield Button("Stop sound  ^X", id="stop")
                        yield Button("Unload models", id="unload", variant="warning")
            with TabPane("Cloning  (F2)", id="cloning"):
                with VerticalScroll():
                    yield Label("Voice clip to clone - 5 to 30 seconds of one person talking, clean audio")
                    with Horizontal(classes="buttons"):
                        yield Button("Browse for voice clip...", id="browse-ref", variant="primary")
                        yield Button("Play clip", id="play-ref")
                        yield Button("Clear", id="clear-ref")
                    yield Static("No clip selected.", id="ref-path")
                    yield Static("", id="ref-info")
                    yield Checkbox("Clone this voice when generating", id="use-clone")
                    yield Label("Exact words spoken in the clip (Breeze requires this; Kitten ignores it)")
                    yield Input(placeholder="Type or paste exactly what is said in the clip.", id="transcript")
            with TabPane("Output  (F3)", id="output"):
                with VerticalScroll():
                    yield Static("", id="out-folder")
                    with Horizontal(classes="buttons"):
                        yield Button("Play selected", id="play-sel", variant="primary")
                        yield Button("Open folder", id="open-out")
                        yield Button("Change folder...", id="change-out")
                        yield Button("Refresh", id="refresh")
                    yield DataTable(id="clips", cursor_type="row", zebra_stripes=True)
                    yield Label("Activity")
                    yield RichLog(id="log", wrap=True, markup=False)
        yield Static("", id="status")
        yield Footer()

    def on_mount(self) -> None:
        table = self.query_one("#clips", DataTable)
        table.add_columns("Clip", "Length", "Size", "Created")
        self.refresh_clips()
        self.refresh_summary()
        self.say("Ready. Type text on Create and press Ctrl+G. The first clip per model loads it (30-40 s); after that it is fast.")

    # ---------------------------------------------------------------- helpers
    def say(self, message: str) -> None:
        self.query_one("#log", RichLog).write(f"[{time.strftime('%H:%M:%S')}] {message}")
        self.query_one("#status", Static).update(message)

    def value(self, widget_id: str) -> str:
        return self.query_one(widget_id, Input).value.strip()

    def cloning(self) -> bool:
        return self.query_one("#use-clone", Checkbox).value and self.ref_path is not None

    def refresh_summary(self) -> None:
        if self.cloning():
            text = f"Voice: cloning {self.ref_original.name}   (change it on the Cloning tab)"
        elif self.query_one("#model", Select).value == "kitten":
            text = f"Voice: built-in {self.query_one('#voice', Select).value}   (clone a voice on the Cloning tab)"
        else:
            text = "Voice: designed from the description above   (clone a voice on the Cloning tab)"
        self.query_one("#summary", Static).update(text)

    def refresh_clips(self) -> None:
        self.query_one("#out-folder", Static).update(f"Saving to: {self.out_dir}")
        table = self.query_one("#clips", DataTable)
        table.clear()
        files = sorted(self.out_dir.glob("*.wav"), key=lambda p: p.stat().st_mtime, reverse=True)[:150]
        for path in files:
            try:
                length = f"{sf.info(str(path)).duration:.1f}s"
            except Exception:
                length = "?"
            stat = path.stat()
            table.add_row(path.name, length, f"{stat.st_size / 1024:.0f} KB",
                          time.strftime("%m-%d %H:%M:%S", time.localtime(stat.st_mtime)), key=str(path))

    def play_file(self, path) -> None:
        if path and Path(path).is_file():
            winsound.PlaySound(str(path), winsound.SND_FILENAME | winsound.SND_ASYNC)
        else:
            self.say("Nothing to play.")

    # ---------------------------------------------------------------- events
    def action_tab(self, tab: str) -> None:
        self.query_one(TabbedContent).active = tab

    def on_select_changed(self, event: Select.Changed) -> None:
        if event.select.id == "model":
            self.query_one("#kitten-panel").display = event.value == "kitten"
            self.query_one("#breeze-panel").display = event.value == "breeze"
        self.refresh_summary()

    def on_checkbox_changed(self, event: Checkbox.Changed) -> None:
        if event.checkbox.id == "use-clone":
            if event.value and self.ref_path is None:
                self.say("Pick a voice clip first (Browse for voice clip...).")
                event.checkbox.value = False
            self.refresh_summary()

    def on_data_table_row_selected(self, event: DataTable.RowSelected) -> None:
        self.play_file(event.row_key.value)

    def on_button_pressed(self, event: Button.Pressed) -> None:
        bid = event.button.id
        if bid == "gen":
            self.action_generate()
        elif bid == "play":
            self.action_play()
        elif bid == "stop":
            self.action_stop_audio()
        elif bid == "unload":
            self.run_worker(self.unload(), exclusive=False)
        elif bid == "browse-ref":
            self.run_worker(self.browse_reference(), exclusive=True, group="dialog")
        elif bid == "play-ref":
            self.play_file(self.ref_path)
        elif bid == "clear-ref":
            self.clear_reference()
        elif bid == "play-sel":
            table = self.query_one("#clips", DataTable)
            if table.row_count:
                self.play_file(table.coordinate_to_cell_key(Coordinate(table.cursor_row, 0)).row_key.value)
        elif bid == "open-out":
            self.out_dir.mkdir(parents=True, exist_ok=True)
            os.startfile(self.out_dir)
        elif bid == "refresh":
            self.refresh_clips()
        elif bid == "change-out":
            self.run_worker(self.change_output_folder(), exclusive=True, group="dialog")

    # ---------------------------------------------------------------- cloning tab
    async def browse_reference(self) -> None:
        self.say("Choose your voice clip in the file window (it may open behind this one)...")
        picked = await run_dialog("file", "Choose a voice clip to clone", self.last_dir)
        if not picked:
            self.say("No file chosen.")
            return
        await self.set_reference(Path(picked))

    async def set_reference(self, source: Path) -> None:
        self.last_dir = source.parent
        try:
            info = sf.info(str(source))
            duration, rate, channels = info.duration, info.samplerate, info.channels
            if source.suffix.lower() == ".wav" and channels == 1:
                target = source
            else:
                target = None
        except Exception:
            duration = rate = channels = None
            target = None
        note = ""
        if target is None:  # mp3/m4a/stereo etc: make a mono 24 kHz wav the models can read
            REFS.mkdir(exist_ok=True)
            target = REFS / (source.stem + ".wav")
            proc = await asyncio.create_subprocess_exec(
                "ffmpeg", "-y", "-loglevel", "error", "-i", str(source), "-ac", "1", "-ar", "24000",
                "-c:a", "pcm_s16le", str(target), stderr=asyncio.subprocess.PIPE,
            )
            _, err = await proc.communicate()
            if proc.returncode != 0 or not target.is_file():
                self.say(f"Could not read that audio file: {err.decode('utf-8', 'replace').strip()[:200]}")
                return
            note = "  (converted to mono 24 kHz wav)"
        if duration is None:
            duration = sf.info(str(target)).duration
        self.ref_original, self.ref_path = source, str(target)
        warning = ""
        if duration < 3:
            warning = "  WARNING: very short; 5-30 s works best."
        elif duration > 30:
            warning = "  WARNING: longer than 30 s; trim it for best results (and the transcript must cover all of it)."
        self.query_one("#ref-path", Static).update(f"Clip: {source}")
        self.query_one("#ref-info", Static).update(f"{duration:.1f} s{note}{warning}")
        transcript = self.query_one("#transcript", Input)
        for sidecar in (source.with_suffix(".reference.txt"), source.with_suffix(".txt")):
            if sidecar.is_file():
                transcript.value = sidecar.read_text(encoding="utf-8", errors="replace").strip()
                self.say(f"Loaded transcript from {sidecar.name}")
                break
        self.query_one("#use-clone", Checkbox).value = True
        self.refresh_summary()
        self.say(f"Voice clip set: {source.name} ({duration:.1f} s){note}")

    def clear_reference(self) -> None:
        self.ref_original = self.ref_path = None
        self.query_one("#use-clone", Checkbox).value = False
        self.query_one("#ref-path", Static).update("No clip selected.")
        self.query_one("#ref-info", Static).update("")
        self.refresh_summary()
        self.say("Voice clip cleared.")

    async def change_output_folder(self) -> None:
        picked = await run_dialog("dir", "Choose where to save clips", self.out_dir)
        if picked:
            self.out_dir = Path(picked)
            self.refresh_clips()
            self.say(f"Saving clips to {self.out_dir}")

    # ---------------------------------------------------------------- generating
    async def unload(self) -> None:
        for engine in self.engines.values():
            await engine.stop()
        self.say("Models unloaded, GPU memory freed.")

    def action_generate(self) -> None:
        if self.busy:
            self.say("Still working on the previous clip.")
            return
        self.run_worker(self.generate(), exclusive=False)

    def action_play(self) -> None:
        self.play_file(self.last_output)

    def action_stop_audio(self) -> None:
        winsound.PlaySound(None, winsound.SND_PURGE)

    async def action_quit(self) -> None:
        await self.unload()
        self.exit()

    async def generate(self) -> None:
        model = self.query_one("#model", Select).value
        text = self.query_one("#text", TextArea).text.strip()
        if not text:
            self.say("Type some text first.")
            return
        clone = self.cloning()
        transcript = self.value("#transcript")
        if self.query_one("#use-clone", Checkbox).value and not clone:
            self.say("Cloning is on but no clip is chosen (Cloning tab).")
            return
        if model == "breeze" and clone and not transcript:
            self.say("Breeze needs the exact words spoken in the clip: type them on the Cloning tab (F2).")
            return
        self.out_dir.mkdir(parents=True, exist_ok=True)
        name = self.value("#outname") or f"{model}_{'clone_' if clone else ''}{time.strftime('%Y%m%d_%H%M%S')}"
        output = self.out_dir / (name if name.lower().endswith(".wav") else name + ".wav")
        if model == "kitten":
            payload = {
                "text": text, "output": str(output),
                "voice": self.query_one("#voice", Select).value,
                "reference": self.ref_path if clone else "",
                "expressive": self.query_one("#expressive", Checkbox).value,
            }
        else:
            payload = {
                "text": text, "output": str(output),
                "instruction": self.value("#b-instr"),
                "ref_audio": self.ref_path if clone else "", "ref_text": transcript if clone else "",
                "cfg": self.value("#b-cfg"), "seed": self.value("#b-seed"),
            }
        engine = self.engines[model]
        self.busy = True
        self.query_one("#gen", Button).disabled = True
        try:
            if not engine.running:
                self.say(f"Loading {model} model (about 30-40 s the first time)...")
                ready = await engine.start()
                if model == "kitten":
                    voices = ready.get("voices", [])
                    voice_select = self.query_one("#voice", Select)
                    chosen = payload["voice"]
                    voice_select.set_options([(v, v) for v in voices])
                    voice_select.value = chosen if chosen in voices else voices[0]
                    payload["voice"] = voice_select.value
                self.say(f"{model} loaded.")
            self.say(f"Generating with {model}{' (cloning ' + self.ref_original.name + ')' if clone else ''}...")
            result = await engine.call(payload)
            if result.get("event") == "done":
                self.last_output = result["output"]
                self.say(f"Saved {result['output']}  ({result['seconds']:.1f}s of audio in {result['elapsed']:.1f}s)")
                self.refresh_clips()
                if self.query_one("#autoplay", Checkbox).value:
                    self.action_play()
            else:
                self.say(f"Error: {result.get('message')}")
        except Exception as error:
            self.say(f"Error: {type(error).__name__}: {error}")
        finally:
            self.busy = False
            try:
                self.query_one("#gen", Button).disabled = False
            except Exception:  # app is shutting down
                pass


if __name__ == "__main__":
    TTSApp().run()
