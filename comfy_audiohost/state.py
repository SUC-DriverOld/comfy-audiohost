"""Workflow-facing encoding for opaque native plugin state blobs."""

import base64
import json
import zlib


class StateMismatch(ValueError):
    """Saved state belongs to a different plugin than requested."""


def encode_state(label, blob):
    """Serialize one effect's native state blob into a workflow-safe string.

    The result is a JSON object carrying the catalog label the blob belongs to
    and a base64 payload, zlib-compressed when that makes it smaller. The label
    guards against restoring a blob captured from a different plugin.
    """
    packed = zlib.compress(blob)
    prefix, data = ("z:", packed) if len(packed) < len(blob) else ("b:", blob)
    return json.dumps(
        {"plugin": label, "state": prefix + base64.b64encode(data).decode("ascii")},
        ensure_ascii=False,
    )


def decode_state(text, label):
    """Return the native state blob captured for ``label``.

    Raises ValueError when the text is malformed or was captured for another
    plugin, so callers fail with a recapture hint instead of a native error.
    """
    try:
        data = json.loads(text)
        blob_field = data["state"]
        blob = base64.b64decode(blob_field[2:], validate=True)
        if blob_field.startswith("z:"):
            blob = zlib.decompress(blob)
        elif not blob_field.startswith("b:"):
            raise ValueError("bad prefix")
    except (ValueError, TypeError, KeyError, zlib.error):
        raise ValueError("Saved plugin state is unreadable; recapture it from the editor") from None
    if data.get("plugin") != label:
        raise StateMismatch(
            f"Saved state belongs to {data.get('plugin')!r}, not {label!r}; recapture or reselect"
        )
    return blob
