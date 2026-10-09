"""Report Hermes's turn state to the Herdr pane it runs in.

Herdr's own Hermes integration (herdr-agent-state) reports only the session id. This adds the
state: ``working`` while a turn runs, ``idle`` when it ends, ``blocked`` while an approval,
clarify question or sudo prompt waits on the human. ``blocked`` is what lets herdr-web-ui show
its answer card and send a "needs input" push.

Does nothing outside Herdr (no ``HERDR_ENV=1``) or on non-interactive platforms.
"""

from __future__ import annotations

import os
import subprocess
import threading
import time

_SOURCE = "hermes-state"  # herdr: prefix is reserved for Herdr's own integrations
_AGENT = "hermes"  # herdr-web-ui routes the chat reader by this label
_INTERACTIVE = {"cli", "tui", "desktop", "acp"}

_lock = threading.Lock()
_turns: set[str] = set()  # sessions with a turn running (subagents included)
_asks: dict[str, str] = {}  # pending human-input request id -> message
_last: tuple[str, str] | None = None


def _pane() -> str | None:
    if os.environ.get("HERDR_ENV") != "1":
        return None
    return os.environ.get("HERDR_PANE_ID", "").strip() or None


def _report() -> None:
    global _last
    pane = _pane()
    if pane is None:
        return
    with _lock:
        if _asks:
            state, message = "blocked", next(reversed(_asks.values()))
        else:
            state, message = ("working" if _turns else "idle"), ""
        if _last == (state, message):
            return
        _last = (state, message)
        seq = str(time.time_ns())
    cmd = [os.environ.get("HERDR_BIN_PATH") or "herdr", "pane", "report-agent", pane,
           "--source", _SOURCE, "--agent", _AGENT, "--state", state, "--seq", seq]
    if message:
        cmd += ["--message", message]
    try:
        subprocess.run(cmd, check=False, timeout=1, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        pass  # Herdr must never slow down or break a turn


def _interactive(kwargs) -> bool:
    return kwargs.get("platform") in _INTERACTIVE


def _turn_started(**kwargs) -> None:
    if not _interactive(kwargs):
        return
    with _lock:
        _turns.add(str(kwargs.get("session_id") or ""))
    _report()


def _turn_ended(**kwargs) -> None:
    if not _interactive(kwargs):
        return
    with _lock:
        _turns.discard(str(kwargs.get("session_id") or ""))
    _report()


def _ask(**kwargs) -> None:
    if not _interactive(kwargs):
        return
    kind = str(kwargs.get("kind") or "input")
    prompt = " ".join(str(kwargs.get("prompt") or "").split())[:160]
    with _lock:
        _asks[str(kwargs.get("request_id"))] = f"{kind}: {prompt}" if prompt else kind
    _report()


def _answered(**kwargs) -> None:
    with _lock:
        _asks.pop(str(kwargs.get("request_id")), None)
    _report()


def _stopped(**kwargs) -> None:
    # an interrupted turn: nothing runs and nothing waits any more
    with _lock:
        _turns.clear()
        _asks.clear()
    _report()


def register(ctx):
    ctx.register_hook("pre_llm_call", _turn_started)
    ctx.register_hook("post_llm_call", _turn_ended)
    ctx.register_hook("on_human_input_request", _ask)
    ctx.register_hook("on_human_input_resolved", _answered)
    ctx.register_hook("agent_loop_stopped", _stopped)
