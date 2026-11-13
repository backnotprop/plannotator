from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
from pathlib import Path


def plannotator_command() -> list:
    given = os.environ.get("PLANNOTATOR_BIN", "").strip()
    if given:
        return [given]
    found = shutil.which("plannotator")
    if found:
        return [found]
    fallback = Path.home() / ".local" / "bin" / "plannotator"
    return [str(fallback)] if fallback.exists() else []


class Link:
    def __init__(self, argv: list, on_event, wakes: bool = False):
        self._argv = argv
        self.wakes = wakes
        self._on_event = on_event
        self._write_lock = threading.Lock()
        self._answers: dict = {}
        self._answered = threading.Condition()
        self._ids = 0
        self._ready = threading.Event()
        self._process = None
        self.tool = None
        self.why = None
        self.on = False

    def start(self, timeout: float) -> bool:
        if not self._argv:
            self.why = "the plannotator command is not installed (https://plannotator.ai/docs/getting-started/installation/)"
            return False
        try:
            self._process = subprocess.Popen(
                self._argv,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                encoding="utf-8",
                bufsize=1,
            )
        except OSError as error:
            self.why = f"plannotator did not start ({error})"
            return False
        threading.Thread(target=self._read, name="plannotator-inbox", daemon=True).start()
        if not self._ready.wait(timeout):
            self.why = self.why or "plannotator did not answer in time"
        return self.tool is not None

    def alive(self) -> bool:
        return self._process is not None and self._process.poll() is None

    def stop(self, wait: float = 2.0) -> None:
        process = self._process
        if process is None:
            return
        try:
            if process.stdin is not None:
                process.stdin.close()
        except (OSError, ValueError):
            pass
        try:
            process.wait(wait)
        except subprocess.TimeoutExpired:
            process.terminate()

    def send(self, message: dict) -> bool:
        process = self._process
        if process is None or process.stdin is None:
            return False
        try:
            with self._write_lock:
                process.stdin.write(json.dumps(message) + "\n")
                process.stdin.flush()
            return True
        except (OSError, ValueError):
            return False

    def call(self, session: str, cwd: str, arguments: dict, wakes: bool, timeout: float = 180.0):
        with self._answered:
            self._ids += 1
            call_id = self._ids
        if not self.send({"type": "call", "id": call_id, "session": session, "cwd": cwd, "input": arguments, "wakes": wakes}):
            return "The Plannotator Inbox connection is not running.", True
        with self._answered:
            self._answered.wait_for(lambda: call_id in self._answers or self._process.poll() is not None, timeout)
            answer = self._answers.pop(call_id, None)
        if answer is None:
            return "The Plannotator Inbox did not answer.", True
        return str(answer.get("text") or ""), answer.get("is_error") is True

    def _read(self):
        for line in self._process.stdout:
            try:
                event = json.loads(line)
            except ValueError:
                continue
            kind = event.get("type")
            if kind == "ready":
                self.tool = event.get("tool")
                self.why = event.get("why")
                self.on = event.get("on") is True
                self._ready.set()
            elif kind == "switch":
                self.on = event.get("on") is True
            elif kind == "result":
                with self._answered:
                    self._answers[event.get("id")] = event
                    self._answered.notify_all()
            else:
                threading.Thread(target=self._on_event, args=(self, event), daemon=True).start()
        self._process.stdout.close()
        self._ready.set()
        with self._answered:
            self._answered.notify_all()
