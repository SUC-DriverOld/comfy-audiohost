try:
    import pyaudiohost  # noqa: F401
except Exception as exc:
    import sys

    python = sys.executable
    raise RuntimeError(f'pyaudiohost is required by comfy-audiohost. Install it with "{python} -m pip install pyaudiohost"') from exc

from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

WEB_DIRECTORY = "./web"

__all__ = ("NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS")
