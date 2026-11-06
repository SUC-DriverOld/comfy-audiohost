import asyncio

from aiohttp import web
from pyaudiohost.errors import AudioHostError
from server import PromptServer

from ..buses import probe_buses
from ..catalog import lookup_plugin, plugin_choices, run_scan, scan_in_background_if_missing
from ..params import probe_parameters
from ..sessions import (
    capture_state,
    close_session,
    open_session,
    set_parameter,
    start_reaper,
)
from ..state import StateMismatch, decode_state, encode_state


def register_routes():
    if PromptServer is None:
        return
    routes = PromptServer.instance.routes

    @routes.get("/comfy-audiohost/plugins")
    async def get_plugins(request):
        return web.json_response({"plugins": plugin_choices()})

    @routes.post("/comfy-audiohost/scan")
    async def scan(request):
        labels, errors = await asyncio.to_thread(run_scan)
        return web.json_response({"plugins": labels, "errors": errors})

    @routes.post("/comfy-audiohost/editor")
    async def open_editor(request):
        body = await request.json()
        node_id = str(body.get("node_id") or "")
        label = str(body.get("plugin") or "")
        if not node_id or not label:
            return web.json_response({"error": "node_id and plugin are required"}, status=400)
        try:
            description = lookup_plugin(label)
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=400)
        state = None
        if body.get("state"):
            try:
                state = decode_state(body["state"], label)
            except StateMismatch:
                # Stale blob captured from another plugin: open fresh instead
                # of blocking the editor with an error.
                pass
            except ValueError as exc:
                return web.json_response({"error": str(exc)}, status=400)
        try:
            session_label = await asyncio.to_thread(open_session, node_id, label, description, state)
        except Exception as exc:
            close_session(node_id)
            return web.json_response({"error": str(exc)}, status=500)
        return web.json_response({"plugin": session_label})

    @routes.get("/comfy-audiohost/state")
    async def get_state(request):
        captured = await asyncio.to_thread(capture_state, request.query.get("node_id", ""))
        if captured is None:
            return web.json_response({"error": "no editor session for this node"}, status=404)
        label, blob, editor_open, values = captured
        return web.json_response(
            {
                "state": encode_state(label, blob),
                "editor_open": editor_open,
                "parameters": values,
            }
        )

    @routes.post("/comfy-audiohost/parameters")
    async def parameters(request):
        body = await request.json()
        try:
            description = lookup_plugin(str(body.get("plugin") or ""))
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=400)
        try:
            probed = await asyncio.to_thread(probe_parameters, description)
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=500)
        return web.json_response({"parameters": probed})

    @routes.post("/comfy-audiohost/set-parameter")
    async def apply_parameter(request):
        body = await request.json()
        value = body.get("value")
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return web.json_response(
                {"error": "value must be a number between 0 and 1"}, status=400
            )
        try:
            await asyncio.to_thread(
                set_parameter,
                str(body.get("node_id") or ""),
                str(body.get("parameter_id") or ""),
                float(value),
            )
        except KeyError:
            return web.json_response({"error": "no editor session for this node"}, status=404)
        except (ValueError, AudioHostError) as exc:
            return web.json_response({"error": str(exc)}, status=400)
        return web.json_response({"ok": True})

    @routes.post("/comfy-audiohost/buses")
    async def buses(request):
        body = await request.json()
        label = str(body.get("plugin") or "")
        try:
            description = lookup_plugin(label)
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=400)
        try:
            layout = await asyncio.to_thread(probe_buses, description)
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=500)
        return web.json_response({"buses": layout})

    @routes.post("/comfy-audiohost/close")
    async def close(request):
        body = await request.json()
        await asyncio.to_thread(close_session, str(body.get("node_id") or ""))
        return web.json_response({"ok": True})

    scan_in_background_if_missing()
    start_reaper()
