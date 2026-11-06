# comfy-audiohost

Host native VST2/VST3/AU audio effects inside ComfyUI. One node takes an
`AUDIO` input, runs it through a selected effect offline, and returns the
processed `AUDIO`. Processing is provided by
[pyaudiohost](https://pypi.org/project/pyaudiohost/); effects only, no
instruments.

## How to install

```bash
cd /path/to/ComfyUI/custom_nodes
git clone https://github.com/SUC-DriverOld/comfy-audiohost

/path/to/ComfyUI/.venv/bin/python -m pip install -r comfy-audiohost/requirements.txt
```

Restart ComfyUI. On first startup a background scan fills the plugin dropdown
(click **Refresh Plugin List** to rescan at any time).

## Node: AudioHost Effect

| Input | Purpose |
| --- | --- |
| `audio` | Any ComfyUI `AUDIO` source |
| `plugin` | Dropdown of scanned effects (`Name [FORMAT]`, type-to-search) |
| `plugin_state` | Hidden; captured native state blob (survives in the workflow) |
| `param_values` | Hidden; node-level parameter overrides |
| `sidechain_1..3` | Optional; shown only when the plugin exposes auxiliary input buses |

Buttons:

- **Refresh Plugin List** — rescans default plugin locations (plus
  `VST_PATH`/`VST3_PATH`) and updates the dropdown.
- **Open Plugin Editor** — opens the native editor window; the button becomes
  **Close Plugin Editor** while it is open. Closing (button or window) captures
  the final state automatically. While open, state and parameter values are
  also captured every few seconds.

## State persistence

Opening the editor starts a per-node `pyaudiohost` worker restored from the
hidden `plugin_state` blob. Edits are saved back with `Plugin.save_state()`
(zlib + base64) into that widget, so the workflow file itself carries the
settings. Queue execution always uses a fresh worker that replays the blob —
the editor session is never used for rendering, so results are reproducible
from the workflow alone. Captured blobs are plugin-tagged: restoring one
against a different selected plugin fails with a clear error.

## Parameter controls

Nothing is listed by default. Pick a parameter in the dropdown and click
**Add Parameter** to get a slider on the node; each row has an inline
**Delete** button. Values use the normalized [0, 1] range, persist in
`param_values`, and override the restored state at execution time. While an
editor session is open, sliders and the GUI stay in sync both ways.

## Sidechain

Selecting a plugin probes its native buses (cached in `buses.json`). Each
auxiliary input bus adds one `sidechain_N` slot (VST3 aux, AU input elements;
VST2 has none). Execution routes main plus sidechain through
`prepare(input_buses=...)`/`process_buses()`: mono/stereo adaptation per bus,
sidechain padded or trimmed to the main length, main output adapted back.
All inputs must share the sample rate.

## Notes

- Main bus in/out only; auxiliary outputs are not exported yet.
- `Plugin.process()` retains leading latency and renders no tail.
- ComfyUI's spawn quirks: `comfy_audiohost/spawn.py` swaps `__main__` while a
  worker starts so spawn children skip re-importing `main.py` (which would die
  on CLI parsing and the `comfy/` sys.path shadowing of `utils`).
- Restarting ComfyUI closes editors; captured state stays in the workflow.
