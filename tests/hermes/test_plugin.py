import json
import os
import stat
import tempfile
import time
import unittest
from pathlib import Path

import host

FAKE = Path(__file__).resolve().parent / "fake_plannotator.py"


def requests(log: Path) -> list:
    if not log.exists():
        return []
    return [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines() if line.strip()]


def until(check, seconds: float = 5.0) -> bool:
    deadline = time.time() + seconds
    while time.time() < deadline:
        if check():
            return True
        time.sleep(0.02)
    return check()


class PluginTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="hermes-plugin-"))
        self.log = self.dir / "log.jsonl"
        FAKE.chmod(FAKE.stat().st_mode | stat.S_IXUSR)
        self.saved = {key: os.environ.get(key) for key in ("PLANNOTATOR_BIN", "FAKE_PLANNOTATOR_LOG", "FAKE_NEVER_RAN", "TELEGRAM_ALLOWED_USERS", "DISCORD_ALLOWED_USERS")}
        os.environ["PLANNOTATOR_BIN"] = str(FAKE)
        os.environ["FAKE_PLANNOTATOR_LOG"] = str(self.log)
        for key in ("TELEGRAM_ALLOWED_USERS", "DISCORD_ALLOWED_USERS"):
            os.environ.pop(key, None)
        host.reset_platforms()
        host.grant(True)
        self.started: list = []

    def tearDown(self):
        for hermes in self.started:
            hermes.unload()
        for key, value in self.saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        host.reset_platforms()
        host.grant(False)

    def start(self, follow: bool = False) -> host.FakeHermes:
        hermes = host.FakeHermes()
        plugin = host.load_plugin()
        if follow:
            plugin.REFRESH_S = 0.05
            plugin.RETRY_S = 0.05
        plugin.register(hermes)
        self.started.append(hermes)
        return hermes

    def connections(self) -> list:
        return [r["argv"] for r in requests(self.log) if "argv" in r]

    def call(self, hermes, key, surface, chat_type="", actor="", action="send_message"):
        with hermes.turn(key, surface, cwd=str(self.dir), chat_type=chat_type, actor=actor):
            return hermes.call_tool("plannotator_inbox", {"action": action, "body": "Ship it?"})

    def calls(self) -> list:
        return [r for r in requests(self.log) if r.get("type") == "call"]

    def test_local_sessions_get_the_tool_signed_as_their_own_session(self):
        hermes = self.start()
        self.assertIn("plannotator_inbox", hermes.tools)
        self.assertEqual(requests(self.log)[0]["argv"], ["inbox", "connection", "--host", "hermes", "--plugin-version", "0.1.0"])
        for surface in ("cli", "tui", "desktop"):
            result = self.call(hermes, f"ses_{surface}", surface)
            self.assertEqual(json.loads(result)["signed"], f"ses_{surface}")
        self.assertEqual([c["session"] for c in self.calls()], ["ses_cli", "ses_tui", "ses_desktop"])

    def test_only_the_owner_direct_messages_reach_the_inbox(self):
        host.platform("telegram", allow_admin_from=["111"])
        hermes = self.start()
        self.assertEqual(json.loads(self.call(hermes, "agent:main:telegram:dm:111", "telegram", "dm", "111"))["signed"], "agent.main.telegram.dm.111")
        for key, chat_type, actor in (
            ("agent:main:telegram:dm:222", "dm", "222"),
            ("agent:main:telegram:group:9", "group", "111"),
            ("agent:main:telegram:dm:111", "dm", ""),
        ):
            refused = json.loads(self.call(hermes, key, "telegram", chat_type, actor))
            self.assertIn("only available in their own sessions", refused["error"])
        self.assertEqual(len(self.calls()), 1)

    def test_a_single_allowlisted_user_is_the_owner_and_a_shared_bot_has_none(self):
        hermes = self.start()
        os.environ["TELEGRAM_ALLOWED_USERS"] = "111"
        self.assertIn("signed", json.loads(self.call(hermes, "k1", "telegram", "dm", "111")))
        os.environ["TELEGRAM_ALLOWED_USERS"] = "111,222"
        self.assertIn("error", json.loads(self.call(hermes, "k2", "telegram", "dm", "111")))
        os.environ["TELEGRAM_ALLOWED_USERS"] = "*"
        self.assertIn("error", json.loads(self.call(hermes, "k3", "telegram", "dm", "111")))
        self.assertIn("error", json.loads(self.call(hermes, "k4", "discord", "dm", "111")))
        self.assertEqual([c["session"] for c in self.calls()], ["k1"])

    def test_a_reply_goes_into_its_own_session_as_a_user_turn_once_it_is_idle(self):
        hermes = self.start()
        self.call(hermes, "ses_tui", "tui")
        self.assertTrue(hermes.injected_event.wait(5))
        self.assertEqual(hermes.injected, [("ses_tui", "Plannotator Inbox: a reply (msg_reply)\nYes, ship it.")])
        self.assertTrue(until(lambda: any(r.get("type") == "delivered" for r in requests(self.log))))
        acks = [r for r in requests(self.log) if r.get("type") in ("delivered", "failed")]
        self.assertEqual(acks, [{"type": "delivered", "session": "ses_tui", "id": "msg_reply_1", "why": None}])
        kinds = [(r.get("type"), r.get("busy")) for r in requests(self.log) if r.get("type") in ("open", "state")]
        self.assertEqual(kinds[:2], [("open", None), ("state", True)])
        self.assertIn(("state", False), kinds)

    def test_a_stranger_session_never_opens_a_wake(self):
        hermes = self.start()
        self.call(hermes, "agent:main:telegram:dm:222", "telegram", "dm", "222")
        self.assertEqual([r for r in requests(self.log) if r.get("type") in ("open", "state")], [])

    def test_without_the_grant_nothing_wakes_and_the_agent_is_told_once(self):
        host.grant(False)
        hermes = self.start()
        self.assertEqual(requests(self.log)[0]["argv"][-1], "--no-wake")
        first = self.call(hermes, "ses_cli", "cli")
        second = self.call(hermes, "ses_cli", "cli")
        self.assertIn("allow_gateway_injection true", first)
        self.assertNotIn("allow_gateway_injection", second)
        self.assertEqual([r for r in requests(self.log) if r.get("type") in ("open", "state")], [])
        self.assertEqual([c["wakes"] for c in self.calls()], [False, False])

    def test_the_grant_given_while_hermes_runs_turns_wakes_on_without_a_restart(self):
        host.grant(False)
        hermes = self.start(follow=True)
        self.assertEqual(self.connections()[-1][-1], "--no-wake")
        host.grant(True)
        self.assertTrue(until(lambda: len(self.connections()) == 2 and self.connections()[-1][-1] != "--no-wake"))
        self.call(hermes, "ses_tui", "tui")
        self.assertTrue(hermes.injected_event.wait(5))
        self.assertEqual(hermes.injected[0][0], "ses_tui")

    def test_an_inbox_first_run_after_hermes_started_brings_the_tool_and_unload_ends_the_connection(self):
        never_ran = self.dir / "never-ran"
        never_ran.write_text("")
        os.environ["FAKE_NEVER_RAN"] = str(never_ran)
        hermes = self.start(follow=True)
        self.assertEqual(hermes.tools, {})
        never_ran.unlink()
        self.assertTrue(until(lambda: "plannotator_inbox" in hermes.tools))
        self.assertEqual(len(hermes.hooks["pre_llm_call"]), 1)
        link = hermes.tools["plannotator_inbox"]["handler"].__self__.link
        hermes.unload()
        self.assertTrue(until(lambda: not link.alive()))

    def test_the_switch_hides_the_tool_and_stops_wakes(self):
        os.environ["FAKE_SWITCH"] = "0"
        try:
            hermes = self.start()
        finally:
            os.environ.pop("FAKE_SWITCH", None)
        self.assertFalse(hermes.tools["plannotator_inbox"]["check_fn"]())
        with hermes.turn("ses_tui", "tui", cwd=str(self.dir)):
            pass
        self.assertEqual([r for r in requests(self.log) if r.get("type") in ("open", "state")], [])

    def test_no_plannotator_means_no_tool(self):
        os.environ["PLANNOTATOR_BIN"] = str(self.dir / "missing")
        hermes = self.start()
        self.assertEqual(hermes.tools, {})


if __name__ == "__main__":
    unittest.main()
