"""Negotiated audio bus layouts, probed once per plugin and cached on disk."""

import json
import os
import threading

import folder_paths
from pyaudiohost import Plugin

from .spawn import worker_spawn

CACHE_PATH = os.path.join(
    folder_paths.get_user_directory(), "default", "comfy-audiohost", "buses.json"
)

_lock = threading.Lock()
_cache = {}  # (path, class id) -> {"version": str, "buses": {"inputs": [...], "outputs": [...]}}
_loaded = False


def _ensure_loaded():
    global _loaded
    if _loaded:
        return
    _loaded = True
    try:
        with open(CACHE_PATH, "r", encoding="utf-8") as handle:
            entries = json.load(handle)["entries"]
    except (OSError, ValueError, KeyError):
        return
    for entry in entries:
        _cache[(entry["path"], entry["id"])] = entry


def _save_locked():
    entries = [
        {"path": key[0], "id": key[1], **entry} for key, entry in _cache.items()
    ]
    payload = json.dumps({"entries": entries}, ensure_ascii=False, indent=2)
    os.makedirs(os.path.dirname(CACHE_PATH), exist_ok=True)
    temporary = f"{CACHE_PATH}.{os.getpid()}.tmp"
    with open(temporary, "w", encoding="utf-8") as handle:
        handle.write(payload)
    os.replace(temporary, CACHE_PATH)


def probe_buses(description):
    """Return the plugin's native bus layout as {"inputs": [...], "outputs": [...]}.

    Loads the plugin once in a disposable worker and caches the result on disk
    keyed by path, class id, and version, so selection changes, workflow
    reloads, and queued runs do not pay the probe cost again.
    """
    key = (description.path, description.id)
    with _lock:
        _ensure_loaded()
        entry = _cache.get(key)
        if entry is not None and entry["version"] == description.version:
            return entry["buses"]
    with worker_spawn():
        plugin = Plugin(description)
    try:
        layout = plugin.audio_buses()
    finally:
        plugin.close()
    buses = {
        direction: [
            {
                "index": bus["index"],
                "name": bus["name"],
                "channels": bus["channels"],
                "main": bus["main"],
            }
            for bus in layout[direction]
        ]
        for direction in ("inputs", "outputs")
    }
    with _lock:
        _cache[key] = {"version": description.version, "buses": buses}
        _save_locked()
    return buses


def sidechain_inputs(buses):
    """List the probe's input buses that can receive sidechain audio."""
    return [bus for bus in buses["inputs"] if not bus["main"] and bus["channels"] > 0]
