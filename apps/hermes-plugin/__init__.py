from __future__ import annotations

import json
import logging
import threading
import time
from pathlib import Path

from . import hermes
from .link import Link, plannotator_command

logger = logging.getLogger(__name__)

NOT_OWNER = "The Plannotator Inbox belongs to the person who runs this Hermes. It is only available in their own sessions: the terminal, the TUI, the Desktop app, and their own direct messages."
NO_WAKE = f"Replies will not come back into this session by themselves: Hermes has not allowed the Plannotator plugin to start turns. Read them later with read_thread, or tell the person to run: {hermes.GRANT_COMMAND}"
START_TIMEOUT_S = 5.0
REFRESH_S = 5.0
RETRY_S = 30.0


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
        self.opened: dict = {}
        self.keys: dict = {}
        self.routes: dict = {}
        self.told: set = set()
        self.lock = threading.Lock()
        self.hooked = False
        self.tried = None
        self.said = None
        self.stopped = threading.Event()

    def start(self) -> None:
        self.refresh()
        on_unload = getattr(self.ctx, "on_unload", None)
        if callable(on_unload):
            on_unload(self.stop)
        threading.Thread(target=self.follow, name="plannotator-follow", daemon=True).start()

    def stop(self) -> None:
        self.stopped.set()
        link, self.link = self.link, None
        if link is not None:
            link.stop()

    def follow(self) -> None:
        while not self.stopped.wait(REFRESH_S):
            try:
                self.refresh()
            except Exception as error:
                logger.warning("plannotator: %s", error)

    def refresh(self) -> None:
        wakes = hermes.injection_granted(self.ctx)
        link = self.link
        healthy = link is not None and link.tool is not None and link.alive()
        if healthy and link.wakes == wakes:
            return
        if not healthy and self.tried is not None and time.monotonic() - self.tried < RETRY_S:
            return
        self.tried = time.monotonic()
        argv = plannotator_command()
        if argv:
            argv = [*argv, "inbox", "connection", "--host", hermes.HOST, "--plugin-version", plugin_version()]
            if not wakes:
                argv.append("--no-wake")
        fresh = Link(argv, self.on_event, wakes)
        if not fresh.start(START_TIMEOUT_S):
            fresh.stop()
            if fresh.why != self.said:
                self.said = fresh.why
                logger.info("plannotator: no Inbox tool (%s)", fresh.why)
            return
        if self.stopped.is_set():
            fresh.stop()
            return
        self.said = None
        self.link = fresh
        self.offer(fresh.tool)
        if wakes:
            with self.lock:
                opened = list(self.opened.items())
            for key, cwd in opened:
                fresh.send({"type": "open", "session": self.inbox_session(key), "cwd": cwd})
        if link is not None:
            link.stop()

    def offer(self, tool: dict) -> None:
        self.ctx.register_tool(
            name=tool["name"],
            toolset="plannotator",
            schema={"name": tool["name"], "description": tool["description"], "parameters": tool["parameters"]},
            handler=self.handle,
            check_fn=self.switched_on,
            description=tool["description"],
        )
        if not self.hooked:
            self.hooked = True
            self.ctx.register_hook("pre_llm_call", self.turn_started)
            self.ctx.register_hook("on_session_end", self.turn_ended)
            self.ctx.register_hook("on_session_finalize", self.session_closed)

    def switched_on(self) -> bool:
        link = self.link
        return link is not None and link.on

    def inbox_session(self, key: str) -> str:
        session = hermes.inbox_session(key)
        self.routes[session] = key
        return session

    def watch(self, link, key: str) -> None:
        cwd = self.ctx.session_cwd() or ""
        with self.lock:
            self.opened[key] = cwd
        link.send({"type": "open", "session": self.inbox_session(key), "cwd": cwd})

    def handle(self, args, **kwargs):
        if not hermes.owner_session(self.ctx):
            return json.dumps({"error": NOT_OWNER})
        link = self.link
        if link is None:
            return json.dumps({"error": "The Plannotator Inbox connection is not running."})
        key = hermes.session_key()
        wakes = hermes.injection_granted(self.ctx)
        if wakes:
            self.watch(link, key)
        text, is_error = link.call(self.inbox_session(key), self.ctx.session_cwd() or "", args if isinstance(args, dict) else {}, wakes)
        if is_error:
            return json.dumps({"error": text})
        if not wakes and key not in self.told and (args or {}).get("action") == "send_message":
            self.told.add(key)
            text = f"{text}\n\n{NO_WAKE}"
        return text

    def turn_started(self, session_id=None, **kwargs):
        link = self.link
        if link is None or not link.on or not hermes.owner_session(self.ctx) or not hermes.injection_granted(self.ctx):
            return None
        key = hermes.session_key()
        if session_id:
            self.keys[session_id] = key
        self.watch(link, key)
        link.send({"type": "state", "session": self.inbox_session(key), "busy": True})
        return None

    def turn_ended(self, session_id=None, **kwargs):
        key = self.keys.get(session_id) or hermes.session_key()
        link = self.link
        if link is not None and key in self.opened:
            link.send({"type": "state", "session": self.inbox_session(key), "busy": False})

    def session_closed(self, session_id=None, **kwargs):
        key = self.keys.pop(session_id, None)
        link = self.link
        if key and key in self.opened:
            with self.lock:
                self.opened.pop(key, None)
            if link is not None:
                link.send({"type": "close", "session": self.inbox_session(key)})

    def on_event(self, link, event: dict) -> None:
        session = event.get("session") or ""
        if event.get("type") == "deliver":
            try:
                ok = session in self.routes and hermes.wake(self.ctx, self.routes[session], str(event.get("text") or ""))
            except Exception as error:
                ok = False
                logger.warning("plannotator: a reply could not go into %s (%s)", session, error)
            link.send({"type": "delivered" if ok else "failed", "session": session, "id": event.get("id"), "why": None if ok else "Hermes did not take it"})
        elif event.get("type") == "notify":
            logger.info("plannotator: %s", event.get("text"))


def register(ctx):
    InboxPlugin(ctx).start()
