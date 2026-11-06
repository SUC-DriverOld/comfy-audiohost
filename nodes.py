import numpy as np
import torch
from pyaudiohost import Plugin

from .comfy_audiohost.buses import probe_buses, sidechain_inputs
from .comfy_audiohost.catalog import EMPTY_CHOICE, lookup_plugin, plugin_choices
from .comfy_audiohost.constants import CATEGORY
from .comfy_audiohost.services.routes import register_routes
from .comfy_audiohost.spawn import worker_spawn
from .comfy_audiohost.state import decode_state

register_routes()

SIDECHAIN_INPUTS = 3


def adapt_channels(data, channels):
    """Adapt a (channels, frames) array between mono and stereo bus widths."""
    data = np.ascontiguousarray(data, dtype=np.float32)
    if data.shape[0] == channels:
        return data
    if channels == 2 and data.shape[0] == 1:
        return np.concatenate([data, data], axis=0)
    if channels == 1 and data.shape[0] == 2:
        return data.mean(axis=0, keepdims=True)
    raise ValueError(f"Cannot adapt {data.shape[0]} channels to a {channels}-channel plugin bus")


def fit_sidechain(data, frames, channels):
    """Adapt a sidechain array to the bus width and align it with main frames."""
    adapted = adapt_channels(data, channels)
    if adapted.shape[1] < frames:
        padding = np.zeros((channels, frames - adapted.shape[1]), np.float32)
        adapted = np.concatenate([adapted, padding], axis=1)
    return adapted[:, :frames]


class AudioHostEffect:
    """Process audio offline through one hosted VST/VST3/AU effect.

    Native settings come from the hidden plugin_state widget: the web extension
    captures them from the editor session into that widget, so the workflow
    file carries them and every queued run restores them in a fresh worker.
    Sidechain inputs appear when the selected plugin exposes auxiliary input
    buses; audio flows main bus in, main bus out.
    """

    @classmethod
    def INPUT_TYPES(cls):
        choices = plugin_choices()
        return {
            "required": {
                "audio": ("AUDIO",),
                "plugin": (choices, {"default": choices[0]}),
                "bypass": ("BOOLEAN", {"default": False}),
                # Hidden by the web extension; holds the captured state blob.
                "plugin_state": ("STRING", {"default": "", "multiline": False}),
            },
            # Visible count is driven by the probed bus layout; see web JS.
            "optional": {
                f"sidechain_{index}": ("AUDIO",) for index in range(1, SIDECHAIN_INPUTS + 1)
            },
        }

    RETURN_TYPES = ("AUDIO",)
    RETURN_NAMES = ("audio",)
    FUNCTION = "render"
    CATEGORY = CATEGORY

    def render(self, audio, plugin, bypass, plugin_state, **sidechains):
        if plugin == EMPTY_CHOICE:
            raise ValueError("No effect plugins found; click 'Refresh Plugin List' on the node")
        description = lookup_plugin(plugin)
        connected = [entry for _, entry in sorted(sidechains.items()) if entry is not None]
        sample_rate = int(audio["sample_rate"])
        waveform = audio["waveform"].to(torch.float32)
        for entry in connected:
            if int(entry["sample_rate"]) != sample_rate:
                raise ValueError(
                    f"Sidechain sample rate {int(entry['sample_rate'])} does not match main audio ({sample_rate})"
                )
        handle = None
        outputs = []
        try:
            with worker_spawn():
                handle = Plugin(description)
            if plugin_state:
                handle.load_state(decode_state(plugin_state, plugin))
            handle.bypassed = bypass
            if connected:
                self._render_sidechain(
                    handle, description, waveform, connected, sample_rate, outputs
                )
            else:
                for batch in waveform:
                    data = np.ascontiguousarray(batch.numpy(), dtype=np.float32)
                    outputs.append(handle.process(data, sample_rate=sample_rate))
        finally:
            if handle is not None:
                handle.close()
        return ({"waveform": torch.from_numpy(np.stack(outputs)), "sample_rate": sample_rate},)

    def _render_sidechain(self, handle, description, waveform, connected, sample_rate, outputs):
        """Process main plus sidechain buses through prepare()/process_buses().

        Bus widths come from the probe: every input is adapted to its bus's
        native channel count, sidechains are padded or trimmed to the main
        frame count, and the main output is adapted back to the main input's
        width to match plain process() behavior.
        """
        buses = probe_buses(description)
        aux = sidechain_inputs(buses)
        if len(connected) > len(aux):
            raise ValueError(
                f"{description.name} exposes {len(aux)} sidechain input(es); disconnect the extra links"
            )
        main_bus = next((bus for bus in buses["inputs"] if bus["main"]), None)
        out_bus = next((bus for bus in buses["outputs"] if bus["main"]), None)
        if main_bus is None or out_bus is None:
            raise ValueError(f"{description.name} exposes no main audio bus")
        active_aux = aux[: len(connected)]
        handle.prepare(
            sample_rate,
            min(max(waveform.shape[-1], 1024), 8192),
            main_bus["channels"],
            input_buses={
                main_bus["index"]: main_bus["channels"],
                **{bus["index"]: bus["channels"] for bus in active_aux},
            },
            output_buses={out_bus["index"]: out_bus["channels"]},
        )
        main_channels = waveform.shape[1]
        for index, batch in enumerate(waveform):
            frames = batch.shape[-1]
            data = {main_bus["index"]: adapt_channels(batch.numpy(), main_bus["channels"])}
            for bus, entry in zip(active_aux, connected):
                side = entry["waveform"].to(torch.float32)
                side_batch = side[min(index, side.shape[0] - 1)]
                data[bus["index"]] = fit_sidechain(side_batch.numpy(), frames, bus["channels"])
            rendered = handle.process_buses(data)
            outputs.append(adapt_channels(rendered[out_bus["index"]], main_channels))


NODE_CLASS_MAPPINGS = {"audiohost_effect": AudioHostEffect}
NODE_DISPLAY_NAME_MAPPINGS = {"audiohost_effect": "AudioHost Effect"}
