"""Cached catalog of installed effect plugins backing the node's dropdown."""

import json
import os
import threading

import folder_paths
from pyaudiohost import PluginDescription, scan_plugins

from .spawn import worker_spawn

CACHE_PATH = os.path.join(
    folder_paths.get_user_directory(), "default", "comfy-audiohost", "plugins.json"
)
EMPTY_CHOICE = "(no effects scanned yet)"

_write_lock = threading.Lock()


def _load_entries():
    try:
        with open(CACHE_PATH, "r", encoding="utf-8") as handle:
            entries = json.load(handle)["plugins"]
    except (OSError, ValueError, KeyError):
        return {}
    return entries if isinstance(entries, dict) else {}


def plugin_choices():
    return sorted(_load_entries()) or [EMPTY_CHOICE]


def lookup_plugin(label):
    entry = _load_entries().get(label)
    if entry is None:
        raise ValueError(f"Plugin {label!r} is not in the scanned catalog; click 'Refresh Plugin List'")
    return PluginDescription(**entry)


def run_scan():
    """Scan default plugin locations for effects and replace the disk cache.

    scan_plugins() excludes instruments by default and collects per-candidate
    failures instead of aborting, so one broken plugin never empties the list.
    """
    with worker_spawn():
        result = scan_plugins()
    entries = {}
    for description in result.plugins:
        label = f"{description.name} [{description.format.upper()}]"
        candidate, index = label, 2
        while candidate in entries:
            suffix = description.path if index == 2 else f"{index} — {description.path}"
            candidate = f"{label} {suffix}"
            index += 1
        entries[candidate] = description.to_dict()
    payload = json.dumps({"plugins": entries}, ensure_ascii=False, indent=2)
    with _write_lock:
        os.makedirs(os.path.dirname(CACHE_PATH), exist_ok=True)
        temporary = f"{CACHE_PATH}.{os.getpid()}.tmp"
        with open(temporary, "w", encoding="utf-8") as handle:
            handle.write(payload)
        os.replace(temporary, CACHE_PATH)
    return sorted(entries), result.errors


def scan_in_background_if_missing():
    """Populate the cache on first startup so the dropdown is not left empty."""
    if os.path.exists(CACHE_PATH):
        return

    def target():
        try:
            labels, _ = run_scan()
            print(f"[comfy-audiohost] background scan found {len(labels)} effects")
        except Exception as error:
            print(f"[comfy-audiohost] background plugin scan failed: {error}")

    threading.Thread(target=target, name="comfy-audiohost-scan", daemon=True).start()
