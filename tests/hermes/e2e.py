import json
import sys

import host


def say(event):
    sys.stdout.write(json.dumps(event) + "\n")
    sys.stdout.flush()


project = sys.argv[1]
host.grant(True)
hermes = host.FakeHermes()
host.load_plugin().register(hermes)
say({"tools": sorted(hermes.tools)})
with hermes.turn("ses_e2e", "tui", cwd=project):
    sent = hermes.call_tool("plannotator_inbox", {"action": "send_message", "body": "Draft is ready. Ship it?"})
    say({"sent": sent})
    sys.stdin.readline()
woken = hermes.injected_event.wait(30)
say({"injected": hermes.injected if woken else None})
sys.stdin.readline()
