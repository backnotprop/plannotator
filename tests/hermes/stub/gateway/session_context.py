import os
from contextvars import ContextVar

_UNSET = object()

_NAMES = (
    "HERMES_SESSION_PLATFORM", "HERMES_SESSION_SOURCE", "HERMES_SESSION_CHAT_ID",
    "HERMES_SESSION_CHAT_TYPE", "HERMES_SESSION_CHAT_NAME", "HERMES_SESSION_THREAD_ID",
    "HERMES_SESSION_USER_ID", "HERMES_SESSION_USER_ID_ALT", "HERMES_SESSION_USER_NAME",
    "HERMES_SESSION_SCOPE_ID", "HERMES_SESSION_KEY", "HERMES_SESSION_ID",
    "HERMES_UI_SESSION_ID", "HERMES_SESSION_MESSAGE_ID", "HERMES_SESSION_PROFILE",
    "HERMES_CRON_SESSION", "HERMES_SESSION_PARENT_CHAT_ID",
    "HERMES_SESSION_ACTOR_ID", "HERMES_SESSION_ACTOR_NAME",
)
_VARS = {name: ContextVar(name, default=_UNSET) for name in _NAMES}
_FIELDS = (
    "platform", "source", "chat_id", "chat_type", "chat_name", "thread_id", "user_id", "user_id_alt",
    "user_name", "scope_id", "session_key", "session_id", "ui_session_id", "message_id", "profile",
    "cron_session", "parent_chat_id", "actor_id", "actor_name",
)


def set_session_vars(**values):
    if values.get("actor_id") is None:
        values["actor_id"] = values.get("user_id", "")
    if values.get("actor_name") is None:
        values["actor_name"] = values.get("user_name", "")
    return [_VARS[name].set(str(values.get(field, "") or "")) for name, field in zip(_NAMES, _FIELDS)]


def clear_session_vars(tokens):
    for var in _VARS.values():
        var.set("")


def bound_session_key():
    value = _VARS["HERMES_SESSION_KEY"].get()
    return "" if value is _UNSET else value


def get_session_env(name, default=""):
    var = _VARS.get(name)
    value = _UNSET if var is None else var.get()
    if value is not _UNSET:
        return value
    return os.getenv(name, default)
