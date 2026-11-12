from __future__ import annotations

import hashlib
import os
import re

HOST = "hermes"
GRANT_COMMAND = "hermes config set plugins.entries.plannotator.allow_gateway_injection true"
LOCAL_SURFACES = frozenset({"cli", "tui", "desktop", "acp"})
DIRECT_CHAT_TYPES = frozenset({"dm", "direct", "private"})


def session_value(name: str) -> str:
    from gateway.session_context import get_session_env

    return (get_session_env(name, "") or "").strip()


def session_key() -> str:
    return session_value("HERMES_SESSION_KEY")


def inbox_session(key: str) -> str:
    readable = key.replace(":", ".")
    if "." not in key and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", readable):
        return readable
    return f"hermes-{hashlib.sha256(key.encode('utf-8')).hexdigest()[:32]}"


def _ids(raw) -> set:
    if raw is None:
        return set()
    items = raw if isinstance(raw, (list, tuple, set, frozenset)) else str(raw).split(",")
    return {str(item).strip() for item in items if str(item).strip()}


def owner_ids(platform: str) -> set:
    extra = {}
    try:
        from gateway.config import Platform, load_gateway_config

        extra = getattr(load_gateway_config().platforms.get(Platform(platform)), "extra", None) or {}
    except Exception:
        extra = {}
    admins = _ids(extra.get("allow_admin_from"))
    if admins:
        return admins
    allowed = _ids(os.environ.get(f"{platform.upper()}_ALLOWED_USERS")) | _ids(extra.get("allow_from"))
    return allowed if len(allowed) == 1 and "*" not in allowed else set()


def owner_session(ctx) -> bool:
    if not session_key():
        return False
    surface = (ctx.session_surface() or "").strip().lower()
    if surface in LOCAL_SURFACES:
        return True
    if not surface or session_value("HERMES_SESSION_CHAT_TYPE").lower() not in DIRECT_CHAT_TYPES:
        return False
    actor = session_value("HERMES_SESSION_ACTOR_ID")
    return bool(actor) and actor in owner_ids(surface)


def injection_granted(ctx) -> bool:
    try:
        from hermes_cli.config import load_config

        entries = ((load_config() or {}).get("plugins") or {}).get("entries") or {}
        return (entries.get(ctx.plugin_id) or {}).get("allow_gateway_injection") is True
    except Exception:
        return False


def wake(ctx, key: str, text: str) -> bool:
    return bool(ctx.inject_message(text, role="user", session_key=key))
