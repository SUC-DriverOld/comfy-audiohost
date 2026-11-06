"""Live editor sessions: one hosted effect per graph node, for state capture.

The queue never touches these handles. They exist only so the editor can be
opened, tweaked, and read back with save_state(); the captured blob travels
through the node's plugin_state widget and is restored in fresh workers at
execution time.

Lifecycle: a session lives only while its editor window is open. The web
extension closes the session when the node's plugin selection changes or when
it notices the editor window was closed, and the reaper thread below removes
any session whose editor is gone anyway (closed browser tab, deleted workflow,
crashed worker), so no plugin worker process outlives its usefulness.
"""

import threading
import time

from pyaudiohost import Plugin

from .spawn import worker_spawn

REAP_INTERVAL_SECONDS = 30.0

_lock = threading.Lock()
_sessions = {}  # node id -> {"label": catalog label, "key": (format, path, id), "plugin": Plugin}


def open_session(node_id, label, description, state):
    """Load the effect for one node, reusing a matching live handle, and open its editor.

    State is restored only when a session is created: reusing a live handle
    keeps any editor tweaks that have not been captured into the widget yet.
    """
    key = (description.format, description.path, description.id)
    with _lock:
        session = _sessions.get(node_id)
        plugin = session["plugin"] if session is not None else None
        if plugin is not None and (plugin.closed or session["key"] != key):
            plugin.close()
            plugin = None
        if plugin is None:
            with worker_spawn():
                plugin = Plugin(description)
            _sessions[node_id] = {"label": label, "key": key, "plugin": plugin}
            if state:
                plugin.load_state(state)
        plugin.open_editor()
        return label


def capture_state(node_id):
    """Return (label, blob, editor_open, {parameter id: value}) or None."""
    with _lock:
        session = _sessions.get(node_id)
        if session is None:
            return None
        plugin = session["plugin"]
        values = {str(param["id"]): param["value"] for param in plugin.parameters()}
        return session["label"], plugin.save_state(), plugin.editor_is_open, values


def set_parameter(node_id, parameter_id, value):
    """Apply one normalized parameter override to the node's live editor session.

    Raises KeyError when the node has no session; the worker's own validation
    (ValueError/AudioHostError) propagates for bad ids and values.
    """
    with _lock:
        session = _sessions.get(node_id)
        if session is None:
            raise KeyError(node_id)
        session["plugin"].set_parameter(parameter_id, value)


def close_session(node_id):
    """Close and forget one node's session; safe to call repeatedly."""
    with _lock:
        session = _sessions.pop(node_id, None)
        if session is not None:
            session["plugin"].close()


def reap_closed_editors():
    """Drop sessions whose editor window is gone or whose worker failed.

    Settings only change while an editor is open, so a session without one is
    dead weight holding a native worker process. Worker requests run outside
    the sessions lock (the worker serializes its own requests) and a session is
    only removed if the exact handle checked above is still registered.
    """
    with _lock:
        snapshot = [(node_id, session["plugin"]) for node_id, session in _sessions.items()]
    for node_id, plugin in snapshot:
        try:
            still_open = plugin.editor_is_open
        except Exception:
            still_open = False
        if still_open:
            continue
        with _lock:
            current = _sessions.get(node_id)
            if current is not None and current["plugin"] is plugin:
                del _sessions[node_id]
        plugin.close()


def _reap_loop():
    while True:
        time.sleep(REAP_INTERVAL_SECONDS)
        reap_closed_editors()


def start_reaper():
    threading.Thread(target=_reap_loop, name="comfy-audiohost-reaper", daemon=True).start()
