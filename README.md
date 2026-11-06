# comfy-audiohost

Host native VST2/VST3/AU audio effects inside ComfyUI. One node takes an
`AUDIO` input, runs it through a selected effect offline, and returns the
processed `AUDIO`. Effect processing is provided by
[pyaudiohost](https://pypi.org/project/pyaudiohost/); effects only, no
instruments.

## How to install

Clone the repository into ComfyUI's `custom_nodes` folder and install the
requirements with the Python interpreter ComfyUI runs on, then restart
ComfyUI:

```bash
cd /path/to/ComfyUI/custom_nodes
git clone https://github.com/SUC-DriverOld/comfy-audiohost

/path/to/ComfyUI/.venv/bin/python -m pip install -r comfy-audiohost/requirements.txt
```

On the first startup after installation, a background scan of the default
plugin locations fills the node's plugin dropdown (click **Refresh Plugin
List** to rescan at any time).

## Node: AudioHost Effect

| Input | Purpose |
| --- | --- |
| `audio` | Any ComfyUI `AUDIO` source (LoadAudio, other effects, ...) |
| `plugin` | Dropdown of scanned effects (`Name [FORMAT]`) |
| `bypass` | Pass the audio through unchanged |
| `plugin_state` | Hidden widget carrying the captured native state blob |
| `param_values` | Hidden widget carrying node-level parameter overrides (JSON) |
| `sidechain_1..3` | Optional; shown only when the plugin exposes auxiliary input buses |

Buttons (added by the web extension):

- **Refresh Plugin List** — rescans the default plugin locations (plus
  `VST_PATH`/`VST3_PATH`) and updates the dropdown. A scan also runs in the
  background on first startup.
- **Open Plugin Editor** — opens the effect's native editor window. The effect
  is loaded with the state currently saved on the node, so tweaking continues
  from there.
- **Capture Plugin State** — copies the live effect's current settings into the
  workflow. While an editor is open, this also happens automatically every few
  seconds.

## How plugin state persists

The hidden `plugin_state` widget is the persistence channel:

1. Opening the editor starts a server-side session (one `pyaudiohost.Plugin`
   worker per node id) restored from the widget's blob, if any.
2. Parameter edits are read back with `Plugin.save_state()` (by the poll loop
   or the capture button), zlib-compressed, base64-encoded, and written into
   the widget. The widget value is an ordinary string, so it is serialized into
   the workflow JSON like any other widget and survives save/load, copy/paste,
   and sharing the workflow file.
3. On queue execution the node loads a fresh worker, replays the blob with
   `Plugin.load_state()`, and processes the whole audio array offline. The
   editor session is never used for rendering, so results are reproducible from
   the workflow alone.

The blob records which plugin it was captured from; restoring it against a
different selected plugin fails with a clear error instead of silent garbage.
Note that some plugins (samplers, convolution reverbs) have multi-megabyte
states, which makes the workflow file correspondingly large.

## Why the spawn shim (`comfy_audiohost/spawn.py`)

pyaudiohost workers use multiprocessing spawn, and spawn children reconstruct
the parent's `__main__` module. Under ComfyUI that re-executes `main.py`, which
dies immediately: `--multiprocessing-fork` is not a ComfyUI CLI option, and the
legacy `comfy/` entry that `nodes.init_extra_nodes()` prepends to `sys.path`
shadows the top-level `utils` package (`from utils.ed25519 import ...` resolves
to `comfy/utils.py`). While a worker starts, the node swaps in a `__main__`
whose spec name is `"__main__"`, so the child skips main-module reconstruction
entirely and only unpickles pyaudiohost's worker entry point. Workers then boot
in well under a second instead of importing the whole server.

## Parameter controls

Plugins can expose hundreds of parameters, so nothing is listed by default.
Pick a parameter in the **parameter dropdown** (both dropdowns support the
frontend's built-in type-to-search) and click **Add Parameter** to get a
slider for it on the node; each slider has its own **×** button to remove
exactly that row. Only what you add is shown, and the node grows and shrinks
with the controls.

Sliders use the library's normalized [0, 1] range; stepped parameters snap to
their steps. Each row carries a small inline "×" at its right end to remove
exactly that parameter. Values persist in the hidden `param_values` widget, so
they survive workflow save/load like everything else, and they are applied on
top of the restored state at execution time — node controls win over saved
plugin settings. `audio`, `bypass`, and the other declared widgets also
support the frontend's native right-click "Convert to input" for external
links.

While an editor session is open, sliders and the plugin GUI stay in sync both
ways: moving a slider updates the live plugin immediately, and GUI changes are
reflected back onto the sliders by the same poll that captures the state.

## Sidechain

When a plugin is selected (or a workflow is loaded), the node asks the backend
to probe the plugin's native buses (`Plugin.audio_buses()` in a disposable
worker, cached on disk in `buses.json` keyed by path, class id, and version).
If the plugin exposes auxiliary input buses — VST3 aux buses, AU input elements
beyond the main one — one `sidechain_N` input slot appears per bus (up to 3).
VST2 has no sidechain buses in pyaudiohost and always stays at one input.

Execution routes main plus sidechain buses through `prepare(input_buses=...)`
and `process_buses()`: each input is adapted to its bus's native channel width
(mono/stereo), sidechains are padded with silence or trimmed to the main
length, and the main output bus is adapted back to the main input's width.
Without a connected sidechain the node stays on `Plugin.process()` with its
built-in mono/stereo adaptation. All inputs must share the sample rate.

## Known limitations

- Main bus only, single input and output (`Plugin.process()`); no sidechain or
  multibus routing yet.
- Main output bus only; auxiliary output buses are not exported yet.
- Leading plugin latency is retained and no tail is rendered, matching
  `Plugin.process()`. Latency-compensated rendering with tails can move to
  `PluginChain.render()` later.
- Sessions live in the server process; restarting ComfyUI closes editors, but
  captured state stays in the workflow.
