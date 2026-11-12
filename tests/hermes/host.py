import contextvars
import importlib.util
import inspect
import sys
import threading
from contextlib import contextmanager
from pathlib import Path

STUB = Path(__file__).resolve().parent / "stub"
PLUGIN = Path(__file__).resolve().parents[2] / "apps" / "hermes-plugin"
if str(STUB) not in sys.path:
    sys.path.insert(0, str(STUB))

from gateway import config as gateway_config
from gateway.session_context import clear_session_vars, set_session_vars
from hermes_cli import config as hermes_config

_surface = contextvars.ContextVar("surface", default="")
_cwd = contextvars.ContextVar("cwd", default="")


def load_plugin(name: str = "plannotator_under_test"):
    for loaded in [key for key in sys.modules if key == name or key.startswith(f"{name}.")]:
        del sys.modules[loaded]
    spec = importlib.util.spec_from_file_location(name, PLUGIN / "__init__.py", submodule_search_locations=[str(PLUGIN)])
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def grant(on: bool = True, plugin_id: str = "plannotator") -> None:
    hermes_config.CURRENT.clear()
    if on:
        hermes_config.CURRENT.update({"plugins": {"entries": {plugin_id: {"allow_gateway_injection": True}}}})


def platform(name: str, **extra) -> None:
    gateway_config.CURRENT.platforms[gateway_config.Platform(name)] = gateway_config.PlatformConfig(enabled=True, extra=extra)


def reset_platforms() -> None:
    gateway_config.CURRENT.platforms.clear()


class FakeHermes:
    plugin_id = "plannotator"

    def __init__(self):
        self.tools: dict = {}
        self.hooks: dict = {}
        self.injected: list = []
        self.live: set = set()
        self.injected_event = threading.Event()

    def register_tool(self, name, toolset, schema, handler, check_fn=None, requires_env=None, is_async=False, description="", emoji="", override=False):
        self.tools[name] = {"toolset": toolset, "schema": schema, "handler": handler}

    def register_hook(self, hook_name, callback, *, hold_stream=False):
        self.hooks.setdefault(hook_name, []).append(callback)

    def inject_message(self, content, role="user", *, session_key=None, origin=None):
        msg = content if role == "user" else f"[{role}] {content}"
        if session_key and origin is not None:
            return False
        entry = ((hermes_config.CURRENT.get("plugins") or {}).get("entries") or {}).get(self.plugin_id) or {}
        if entry.get("allow_gateway_injection") is not True:
            return False
        if session_key not in self.live:
            return False
        self.injected.append((session_key, msg))
        self.injected_event.set()
        return True

    def session_surface(self):
        return _surface.get()

    def session_cwd(self):
        return _cwd.get()

    def fire(self, hook_name, **kwargs):
        results = []
        for callback in self.hooks.get(hook_name, []):
            accepted = inspect.signature(callback).parameters
            takes_all = any(p.kind is inspect.Parameter.VAR_KEYWORD for p in accepted.values())
            results.append(callback(**{k: v for k, v in kwargs.items() if takes_all or k in accepted}))
        return results

    @contextmanager
    def turn(self, key, surface, cwd="", chat_type="", actor="", session_id=None):
        self.live.add(key)
        tokens = set_session_vars(platform=surface, session_key=key, session_id=session_id or key, chat_type=chat_type, user_id=actor)
        surface_token = _surface.set(surface)
        cwd_token = _cwd.set(cwd)
        try:
            self.fire("pre_llm_call", session_id=session_id or key, user_message="", conversation_history=[], is_first_turn=False, model="m", platform=surface)
            yield self
            self.fire("on_session_end", session_id=session_id or key, completed=True, interrupted=False, model="m", platform=surface)
        finally:
            _cwd.reset(cwd_token)
            _surface.reset(surface_token)
            clear_session_vars(tokens)

    def call_tool(self, name, args):
        handler = self.tools[name]["handler"]
        context = contextvars.copy_context()
        out = {}
        worker = threading.Thread(target=lambda: out.update(result=context.run(handler, args, task_id="t1", session_id="s1")))
        worker.start()
        worker.join(60)
        return out.get("result")
