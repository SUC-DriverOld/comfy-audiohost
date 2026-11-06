"""Spawn pyaudiohost workers without re-importing ComfyUI's main.py in children.

multiprocessing-spawn children reconstruct the parent's __main__ module before
running the pickled worker target. Under ComfyUI that re-executes main.py,
which dies on argv parsing (--multiprocessing-fork is not a ComfyUI option)
and on the legacy comfy/ sys.path entry shadowing the top-level utils package.
pyaudiohost's worker entry point lives in its own importable module, so while
a worker starts we point __main__ at itself (spec name "__main__"); the child
then skips main-module reconstruction entirely and only unpickles the target.
"""

import sys
import types
from contextlib import contextmanager

_SHIM = types.ModuleType("__main__")
_SHIM.__spec__ = types.SimpleNamespace(name="__main__")


@contextmanager
def worker_spawn():
    """Swap in a lightweight __main__ while a pyaudiohost worker process starts."""
    original = sys.modules["__main__"]
    sys.modules["__main__"] = _SHIM
    try:
        yield
    finally:
        sys.modules["__main__"] = original
