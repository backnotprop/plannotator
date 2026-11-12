from __future__ import annotations

import json
import logging
import threading
from pathlib import Path

from . import hermes
from .link import Link, plannotator_command

logger = logging.getLogger(__name__)

NOT_OWNER = "The Plannotator Inbox belongs to the person who runs this Hermes. It is only available in their own sessions: the terminal, the TUI, the Desktop app, and their own direct messages."
NO_WAKE = f"Replies will not come back into this session by themselves: Hermes has not allowed the Plannotator plugin to start turns. Read them later with read_thread, or tell the person to run: {hermes.GRANT_COMMAND}"
START_TIMEOUT_S = 5.0


def plugin_version() -> str:
    try:
        for line in (Path(__file__).parent / "plugin.yaml").read_text(encoding="utf-8").splitlines():
            if line.startswith("version:"):
                return line.split(":", 1)[1].strip()
    except OSError:
        pass
    return ""


class InboxPlugin:
    def __init__(self, ctx):
        self.ctx = ctx
        self.link = None
        self.opened: set = set()
        self.keys: dict = {}
        self.told: set = set()
        self.lock = threading.Lock()

    def start(self) -> None:
        wakes = hermes.injection_granted(self.ctx)
        argv = plannotator_command()
        if argv:
            argv = [*argv, "inbox", "connection", "--host", hermes.HOST, "--plugin-version", plugin_version()]
            if not wakes:
                argv.append("--no-wake")
        self.link = Link(argv, self.on_event)
        if not self.link.start(START_TIMEOUT_S):
            logger.info("plannotator: no Inbox tool (%s)", self.link.why)
            return
        tool = self.link.tool
        self.ctx.register_tool(
            name=tool["name"],
            toolset="plannotator",
            schema={"name": tool["name"], "description": tool["description"], "parameters": tool["parameters"]},
            handler=self.handle,
            description=tool["description"],
        )
        self.ctx.register_hook("pre_llm_call", self.turn_started)
        self.ctx.register_hook("on_session_end", self.turn_ended)
        self.ctx.register_hook("on_session_finalize", self.session_closed)

    def watch(self, key: str) -> None:
        with self.lock:
            self.opened.add(key)
        self.link.send({"type": "open", "session": key, "cwd": self.ctx.session_cwd() or ""})

    def handle(self, args, **kwargs):
        if not hermes.owner_session(self.ctx):
            return json.dumps({"error": NOT_OWNER})
        key = hermes.session_key()
        wakes = hermes.injection_granted(self.ctx)
        if wakes:
            self.watch(key)
        text, is_error = self.link.call(key, self.ctx.session_cwd() or "", args if isinstance(args, dict) else {}, wakes)
        if is_error:
            return json.dumps({"error": text})
        if not wakes and key not in self.told and (args or {}).get("action") == "send_message":
            self.told.add(key)
            text = f"{text}\n\n{NO_WAKE}"
        return text

    def turn_started(self, session_id=None, **kwargs):
        if not hermes.owner_session(self.ctx) or not hermes.injection_granted(self.ctx):
            return None
        key = hermes.session_key()
        if session_id:
            self.keys[session_id] = key
        self.watch(key)
        self.link.send({"type": "state", "session": key, "busy": True})
        return None

    def turn_ended(self, session_id=None, **kwargs):
        key = self.keys.get(session_id) or hermes.session_key()
        if key in self.opened:
            self.link.send({"type": "state", "session": key, "busy": False})

    def session_closed(self, session_id=None, **kwargs):
        key = self.keys.pop(session_id, None)
        if key and key in self.opened:
            self.opened.discard(key)
            self.link.send({"type": "close", "session": key})

    def on_event(self, event: dict) -> None:
        session = event.get("session") or ""
        if event.get("type") == "deliver":
            try:
                ok = hermes.wake(self.ctx, session, str(event.get("text") or ""))
            except Exception as error:
                ok = False
                logger.warning("plannotator: a reply could not go into %s (%s)", session, error)
            self.link.send({"type": "delivered" if ok else "failed", "session": session, "id": event.get("id"), "why": None if ok else "Hermes did not take it"})
        elif event.get("type") == "notify":
            logger.info("plannotator: %s", event.get("text"))


def register(ctx):
    InboxPlugin(ctx).start()
