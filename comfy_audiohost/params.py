"""Settable parameter metadata, probed once per plugin and cached on disk."""

import json
import os
import threading

import folder_paths
from pyaudiohost import Plugin

from .spawn import worker_spawn

CACHE_PATH = os.path.join(
    folder_paths.get_user_directory(), "default", "comfy-audiohost", "params.json"
)

_lock = threading.Lock()
_cache = {}  # (path, class id) -> {"version": str, "parameters": [...]}
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


def probe_parameters(description):
    """Return settable parameter metadata as a list of dicts.

    Loads the plugin once in a disposable worker and caches the result on disk
    keyed by path, class id, and version. Each entry carries ``id``, ``name``,
    ``default``, ``steps`` (VST3 only, None when continuous), and ``read_only``;
    values use the plugin's normalized [0, 1] range.
    """
    key = (description.path, description.id)
    with _lock:
        _ensure_loaded()
        entry = _cache.get(key)
        if entry is not None and entry["version"] == description.version:
            return entry["parameters"]
    with worker_spawn():
        plugin = Plugin(description)
    try:
        probed = plugin.parameters()
    finally:
        plugin.close()
    parameters = [
        {
            "id": str(param["id"]),
            "name": param["name"],
            "default": param["default"],
            "steps": param.get("steps"),
            "read_only": bool(param["read_only"]),
        }
        for param in probed
        if not param["read_only"]
    ]
    with _lock:
        _cache[key] = {"version": description.version, "parameters": parameters}
        _save_locked()
    return parameters
