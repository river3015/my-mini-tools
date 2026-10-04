#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "httpx",
#   "numpy",
#   "pynput",
#   "pyobjc-framework-Cocoa",
#   "sounddevice",
# ]
# ///
"""Push-to-talk dictation for macOS using ElevenLabs Scribe.

Hold the hotkey (right Command by default) while speaking. On release, the
recording is transcribed with keyterms from the config, the replacement
dictionary is applied, and the text is pasted into the frontmost app.
"""

from __future__ import annotations

import argparse
import io
import os
import queue
import subprocess
import sys
import threading
import time
import tomllib
import wave
from dataclasses import dataclass, field
from pathlib import Path

import httpx
import numpy as np
import sounddevice as sd
from AppKit import NSPasteboard, NSPasteboardItem
from pynput import keyboard

STT_URL = "https://api.elevenlabs.io/v1/speech-to-text"
KEYCHAIN_SERVICE = "voice-input-elevenlabs"
CONFIG_PATH = Path.home() / ".config" / "voice-input" / "config.toml"
SAMPLE_RATE = 16_000
MIN_SECONDS = 0.3
HOTKEYS = {
    "cmd_r": keyboard.Key.cmd_r,
    "alt_r": keyboard.Key.alt_r,
    "ctrl_r": keyboard.Key.ctrl_r,
    "shift_r": keyboard.Key.shift_r,
}
# Characters rejected by the keyterms API.
KEYTERM_FORBIDDEN = set("<>{}[]\\")


@dataclass
class Config:
    hotkey: str = "cmd_r"
    language: str = "ja"
    model: str = "scribe_v2"
    no_verbatim: bool = True
    keyterms: list[str] = field(default_factory=list)
    replacements: dict[str, str] = field(default_factory=dict)

    @classmethod
    def load(cls, path: Path) -> Config:
        if not path.exists():
            return cls()
        with path.open("rb") as f:
            data = tomllib.load(f)
        config = cls(**data)
        if config.hotkey not in HOTKEYS:
            raise SystemExit(f"hotkey must be one of: {', '.join(HOTKEYS)}")
        config.keyterms = config.valid_keyterms()
        return config

    def valid_keyterms(self) -> list[str]:
        terms = []
        for term in self.keyterms:
            term = term.strip()
            if not term or len(term) >= 50 or len(term.split()) > 5:
                log(f"skip keyterm (length or word count): {term!r}")
            elif KEYTERM_FORBIDDEN & set(term):
                log(f"skip keyterm (forbidden character): {term!r}")
            else:
                terms.append(term)
        return terms[:1000]


def log(message: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {message}", file=sys.stderr, flush=True)


def play(sound: str) -> None:
    subprocess.Popen(
        ["afplay", f"/System/Library/Sounds/{sound}.aiff"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def load_api_key() -> str:
    if key := os.environ.get("ELEVENLABS_API_KEY"):
        return key
    result = subprocess.run(
        ["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode == 0 and result.stdout.strip():
        return result.stdout.strip()
    raise SystemExit(
        "ElevenLabs API key not found. Store it in the Keychain:\n"
        f'  security add-generic-password -s {KEYCHAIN_SERVICE} -a "$USER" -w'
    )


def to_wav(frames: np.ndarray) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(frames.tobytes())
    return buf.getvalue()


def transcribe(
    client: httpx.Client,
    api_key: str,
    config: Config,
    audio: bytes,
    filename: str = "audio.wav",
) -> str:
    data: list[tuple[str, str]] = [
        ("model_id", config.model),
        ("language_code", config.language),
        ("tag_audio_events", "false"),
        ("no_verbatim", str(config.no_verbatim).lower()),
    ]
    data += [("keyterms", term) for term in config.keyterms]
    response = client.post(
        STT_URL,
        headers={"xi-api-key": api_key},
        data=data,
        files={"file": (filename, audio)},
        timeout=60,
    )
    response.raise_for_status()
    return response.json()["text"].strip()


def apply_replacements(text: str, replacements: dict[str, str]) -> str:
    for src, dst in replacements.items():
        text = text.replace(src, dst)
    return text


def paste(text: str) -> None:
    """Paste via the clipboard, then restore the previous clipboard contents."""
    pasteboard = NSPasteboard.generalPasteboard()
    saved = []
    for item in pasteboard.pasteboardItems() or []:
        copy = NSPasteboardItem.alloc().init()
        for kind in item.types():
            if (value := item.dataForType_(kind)) is not None:
                copy.setData_forType_(value, kind)
        saved.append(copy)

    pasteboard.clearContents()
    pasteboard.setString_forType_(text, "public.utf8-plain-text")
    controller = keyboard.Controller()
    with controller.pressed(keyboard.Key.cmd):
        controller.tap("v")
    # Give the target app time to read the clipboard before restoring it.
    time.sleep(0.5)
    pasteboard.clearContents()
    if saved:
        pasteboard.writeObjects_(saved)


class Recorder:
    def __init__(self) -> None:
        self._chunks: list[np.ndarray] = []
        self._stream: sd.InputStream | None = None
        self._started = 0.0

    def start(self) -> None:
        self._chunks = []
        self._started = time.monotonic()
        # Open the stream per recording so the mic is not held while idle.
        self._stream = sd.InputStream(
            samplerate=SAMPLE_RATE,
            channels=1,
            dtype="int16",
            callback=lambda indata, *_: self._chunks.append(indata.copy()),
        )
        self._stream.start()

    def stop(self) -> tuple[np.ndarray, float]:
        assert self._stream is not None
        self._stream.stop()
        self._stream.close()
        self._stream = None
        duration = time.monotonic() - self._started
        if not self._chunks:
            return np.zeros(0, dtype=np.int16), duration
        return np.concatenate(self._chunks), duration


class Dictation:
    def __init__(self, config: Config, api_key: str, paste_enabled: bool) -> None:
        self.config = config
        self.api_key = api_key
        self.paste_enabled = paste_enabled
        self.hotkey = HOTKEYS[config.hotkey]
        self.recorder = Recorder()
        self.recording = False
        self.cancelled = False
        self.jobs: queue.Queue[np.ndarray] = queue.Queue()
        self.client = httpx.Client()

    def on_press(self, key: keyboard.Key | keyboard.KeyCode | None) -> None:
        if key == self.hotkey and not self.recording:
            self.recording = True
            self.cancelled = False
            self.recorder.start()
            play("Tink")
        elif self.recording:
            # Another key while holding the hotkey means a normal shortcut.
            self.cancelled = True

    def on_release(self, key: keyboard.Key | keyboard.KeyCode | None) -> None:
        if key != self.hotkey or not self.recording:
            return
        self.recording = False
        frames, duration = self.recorder.stop()
        if self.cancelled or duration < MIN_SECONDS:
            return
        play("Pop")
        self.jobs.put(frames)

    def worker(self) -> None:
        while True:
            frames = self.jobs.get()
            started = time.monotonic()
            try:
                raw = transcribe(self.client, self.api_key, self.config, to_wav(frames))
            except httpx.HTTPError as e:
                detail = getattr(getattr(e, "response", None), "text", "")
                log(f"transcription failed: {e} {detail}")
                play("Basso")
                continue
            text = apply_replacements(raw, self.config.replacements)
            log(f"{time.monotonic() - started:.1f}s: {text}")
            if text and self.paste_enabled:
                paste(text)

    def run(self) -> None:
        threading.Thread(target=self.worker, daemon=True).start()
        log(f"ready. hold {self.config.hotkey} to dictate (Ctrl+C to quit)")
        with keyboard.Listener(
            on_press=self.on_press, on_release=self.on_release
        ) as listener:
            listener.join()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--config", type=Path, default=CONFIG_PATH)
    parser.add_argument(
        "--no-paste", action="store_true", help="print only, do not paste"
    )
    parser.add_argument("--file", type=Path, help="transcribe an audio file and exit")
    args = parser.parse_args()

    config = Config.load(args.config)
    api_key = load_api_key()

    if args.file:
        with httpx.Client() as client:
            raw = transcribe(
                client, api_key, config, args.file.read_bytes(), args.file.name
            )
        print(apply_replacements(raw, config.replacements))
        return

    try:
        Dictation(config, api_key, paste_enabled=not args.no_paste).run()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
