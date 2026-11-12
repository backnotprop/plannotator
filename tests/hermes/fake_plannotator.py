#!/usr/bin/env python3
import json
import os
import sys

log_path = os.environ["FAKE_PLANNOTATOR_LOG"]


def note(entry):
    with open(log_path, "a", encoding="utf-8") as log:
        log.write(json.dumps(entry) + "\n")


def say(event):
    sys.stdout.write(json.dumps(event) + "\n")
    sys.stdout.flush()


note({"argv": sys.argv[1:]})
tool = {"name": "plannotator_inbox", "description": "The Inbox.", "parameters": {"type": "object", "properties": {"action": {"type": "string"}}}}
say({"type": "ready", "tool": tool})
opened = set()
woken = set()
for line in sys.stdin:
    request = json.loads(line)
    note(request)
    kind = request.get("type")
    session = request.get("session")
    if kind == "call":
        say({"type": "result", "id": request["id"], "text": json.dumps({"signed": session, "action": request["input"].get("action")}), "is_error": False})
    elif kind == "open":
        opened.add(session)
    elif kind == "state" and request.get("busy") is False and session in opened and session not in woken:
        woken.add(session)
        say({"type": "deliver", "session": session, "id": f"msg_reply_{len(woken)}", "text": "Plannotator Inbox: a reply (msg_reply)\nYes, ship it."})
