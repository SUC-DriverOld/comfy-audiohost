import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_TYPE = "audiohost_effect";
const STATE_WIDGET = "plugin_state";
const PARAMS_WIDGET = "param_values";
const POLL_INTERVAL_MS = 3000;
const MAX_SIDECHAIN_SLOTS = 3;
const PARAM_INPUT_SLOTS = 8;
const NODE_WIDTH = 300;

function getWidget(node, name) {
  return node.widgets?.find((widget) => widget.name === name);
}

function selectedPlugin(node) {
  const value = String(getWidget(node, "plugin")?.value ?? "");
  return value.startsWith("(") ? null : value;
}

// Recompute the node's natural height (slots + visible widgets) while keeping
// a stable width, so the node grows with added slots/controls and shrinks
// back when they are removed.
function fitNodeSize(node) {
  node.setSize(node.computeSize());
  node.size[0] = NODE_WIDTH;
  node.setDirtyCanvas(true, true);
}

function updateCaptureLabel(node) {
  const button = node.audiohostCaptureButton;
  if (!button) return;
  const value = String(getWidget(node, STATE_WIDGET)?.value ?? "");
  const size = value ? `${Math.max(1, Math.round((value.length * 0.75) / 1024))} KB` : null;
  button.label = size ? `Capture Plugin State (saved: ${size})` : "Capture Plugin State";
  node.setDirtyCanvas(true, true);
}

function closeSession(node) {
  if (node.id == null) return;
  api.fetchApi("/comfy-audiohost/close", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ node_id: String(node.id) }),
  }).catch(() => {});
}

function stopStatePolling(node) {
  if (node.audiohostPollTimer != null) {
    clearInterval(node.audiohostPollTimer);
    node.audiohostPollTimer = null;
  }
}

// While the editor is open, keep syncing its live state and parameter values
// into the hidden widgets so the workflow always carries the latest settings.
function startStatePolling(node) {
  stopStatePolling(node);
  node.audiohostPollTimer = setInterval(() => {
    captureState(node).catch(() => stopStatePolling(node));
  }, POLL_INTERVAL_MS);
}

async function captureState(node) {
  const response = await api.fetchApi(`/comfy-audiohost/state?node_id=${node.id}`);
  if (!response.ok) throw new Error(await response.text());
  const data = await response.json();
  const widget = getWidget(node, STATE_WIDGET);
  if (widget && widget.value !== data.state) {
    widget.value = data.state;
    updateCaptureLabel(node);
  }
  applyLiveParameters(node, data.parameters);
  // The editor window was closed (by the user or the plugin): the final state
  // is in hand, so end the poll loop and release the server-side worker.
  if (data.editor_open === false) {
    stopStatePolling(node);
    closeSession(node);
  }
}

async function openEditor(node) {
  if (node.id == null) {
    console.warn("[comfy-audiohost] node has no id yet; add it to the graph first");
    return;
  }
  const response = await api.fetchApi("/comfy-audiohost/editor", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      node_id: String(node.id),
      plugin: selectedPlugin(node) ?? "",
      state: String(getWidget(node, STATE_WIDGET)?.value ?? ""),
    }),
  });
  if (!response.ok) throw new Error(await response.text());
  startStatePolling(node);
}

// ---------------------------------------------------------------------------
// Plugin list + search filter
// ---------------------------------------------------------------------------

function storePluginList(node, plugins) {
  const combo = getWidget(node, "plugin");
  if (!combo) return;
  let values = plugins.slice();
  if (combo.value && !values.includes(combo.value)) values = [combo.value, ...values];
  combo.options.values = values;
  node.setDirtyCanvas(true, true);
}

async function refreshPlugins(node) {
  const widget = getWidget(node, "plugin");
  if (!widget) return;
  const response = await api.fetchApi("/comfy-audiohost/scan", { method: "POST" });
  if (!response.ok) throw new Error(await response.text());
  const data = await response.json();
  const plugins = data.plugins ?? [];
  const previous = widget.value;
  storePluginList(node, plugins);
  if (!plugins.includes(widget.value)) widget.value = plugins[0] ?? "";
  if (Object.keys(data.errors ?? {}).length) {
    console.warn("[comfy-audiohost] scan skipped some plugins:", data.errors);
  }
  node.setDirtyCanvas(true, true);
  if (widget.value !== previous) resetPluginDependentState(node);
}

function syncPluginChoices(node) {
  api.fetchApi("/comfy-audiohost/plugins").then(async (response) => {
    if (!response.ok) return;
    const data = await response.json();
    if (!Array.isArray(data.plugins) || !data.plugins.length) return;
    const widget = getWidget(node, "plugin");
    if (!widget) return;
    const previous = widget.value;
    storePluginList(node, data.plugins);
    if (!data.plugins.includes(widget.value)) widget.value = data.plugins[0];
    node.setDirtyCanvas(true, true);
    if (widget.value !== previous) resetPluginDependentState(node);
  });
}

// ---------------------------------------------------------------------------
// Parameter controls (picker + search + dynamic sliders)
// ---------------------------------------------------------------------------

function paramWidgetName(id) {
  return `param:${id}`;
}

function addedParams(node) {
  try {
    const parsed = JSON.parse(String(getWidget(node, PARAMS_WIDGET)?.value || "{}"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    return {};
  }
}

function saveAddedParams(node, map) {
  const widget = getWidget(node, PARAMS_WIDGET);
  if (widget) widget.value = JSON.stringify(map);
}

// Rebuild the dynamic parameter rows from the param_values JSON and the
// probed metadata. Unbound rows get a slider in native units (or normalized
// when no range was measurable) plus "×" and "→ Input" buttons; rows bound to
// an input slot keep only the buttons, and the slot itself carries the value.
// None of these widgets serialize (values live in param_values), so workflow
// round-trips stay positional-safe.
function rebuildParamWidgets(node) {
  const widgets = node.widgets ?? [];
  for (let index = widgets.length - 1; index >= 0; index -= 1) {
    const name = String(widgets[index]?.name ?? "");
    if (
      name.startsWith("param:") ||
      name.startsWith("param-remove:") ||
      name.startsWith("param-link:")
    ) {
      if (typeof node.removeWidget === "function") {
        node.removeWidget(widgets[index]);
      } else {
        widgets.splice(index, 1);
      }
    }
  }
  const map = addedParams(node);
  for (const [id, spec] of Object.entries(map)) {
    if (spec.slot == null) {
      const meta = (node.audioHostParams ?? []).find((param) => param.id === id);
      const step = meta?.steps > 1 ? 1 / (meta.steps - 1) : 0.001;
      const widget = node.addWidget(
        "number",
        spec.name,
        Number(spec.value) || 0,
        (value) => onParamChanged(node, id, value),
        { min: 0, max: 1, step }
      );
      widget.name = paramWidgetName(id);
      widget.label = spec.name;
      widget.serialize = false;
    }
    const remove = node.addWidget("button", "×", null, () => removeParam(node, id));
    remove.name = `param-remove:${id}`;
    remove.label = "×";
    remove.serialize = false;
    const toggle = node.addWidget("button", "→ Input", null, () => toggleParamInput(node, id));
    toggle.name = `param-link:${id}`;
    toggle.label = spec.slot == null ? "→ Input" : "← Slider";
    toggle.serialize = false;
  }
  fitNodeSize(node);
}

function removeParam(node, id) {
  const map = addedParams(node);
  if (!map[id]) return;
  delete map[id];
  saveAddedParams(node, map);
  rebuildParamWidgets(node);
  scheduleNodeInputSync(node);
}

// Bind a parameter row to one of the node's FLOAT input slots (or unbind it).
// The slot name/number mapping is recorded in param_values, so execution and
// workflow round-trips know exactly which linked value belongs to which
// parameter.
function toggleParamInput(node, id) {
  const map = addedParams(node);
  const spec = map[id];
  if (!spec) return;
  if (spec.slot == null) {
    const used = new Set(
      Object.values(map).map((entry) => entry.slot).filter((slot) => slot != null)
    );
    let slot = 1;
    while (slot <= PARAM_INPUT_SLOTS && used.has(slot)) slot += 1;
    if (slot > PARAM_INPUT_SLOTS) {
      console.warn(`[comfy-audiohost] at most ${PARAM_INPUT_SLOTS} linked parameters per node`);
      return;
    }
    spec.slot = slot;
  } else {
    delete spec.slot;
  }
  saveAddedParams(node, map);
  rebuildParamWidgets(node);
  scheduleNodeInputSync(node);
}

function onParamChanged(node, id, value) {
  const map = addedParams(node);
  if (!map[id]) return;
  map[id].value = Number(value);
  saveAddedParams(node, map);
  // Mirror the change into the live editor session, if one exists; without a
  // session the override is still applied at execution time.
  if (node.id != null) {
    api.fetchApi("/comfy-audiohost/set-parameter", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ node_id: String(node.id), parameter_id: String(id), value: Number(value) }),
    }).catch(() => {});
  }
}

// GUI -> sliders: silently adopt the live session's parameter values so both
// sides stay in sync without triggering the change callbacks.
function applyLiveParameters(node, values) {
  if (!values || typeof values !== "object") return;
  node.audioHostLiveParams = values;
  const map = addedParams(node);
  let changed = false;
  for (const [id, value] of Object.entries(values)) {
    if (!(id in map)) continue;
    if (map[id].value !== value) {
      map[id].value = value;
      changed = true;
    }
    const widget = getWidget(node, paramWidgetName(id));
    if (widget && widget.value !== value) widget.value = value;
  }
  if (changed) saveAddedParams(node, map);
}

function paramPickerValues(node) {
  const seen = new Set();
  const values = [];
  for (const param of node.audioHostParams ?? []) {
    let label = param.name;
    if (seen.has(label)) label = `${param.name} (${param.id})`;
    seen.add(label);
    param.pickerLabel = label;
    values.push(label);
  }
  return values;
}

const NO_PARAMS_PLACEHOLDER = "(no parameters)";

function syncParamPicker(node) {
  const picker = node.audioHostParamPicker;
  if (!picker) return;
  const values = paramPickerValues(node);
  picker.options.values = values.length ? values : [NO_PARAMS_PLACEHOLDER];
  if (!picker.options.values.includes(picker.value)) picker.value = picker.options.values[0];
  node.setDirtyCanvas(true, true);
}

function selectedParamMeta(node) {
  const picker = node.audioHostParamPicker;
  if (!picker?.value) return null;
  return (node.audioHostParams ?? []).find((param) => param.pickerLabel === picker.value) ?? null;
}

function addSelectedParam(node) {
  const meta = selectedParamMeta(node);
  if (!meta) {
    console.warn("[comfy-audiohost] no parameter selected");
    return;
  }
  const map = addedParams(node);
  if (map[meta.id]) {
    console.warn(`[comfy-audiohost] parameter ${meta.name} is already on the node`);
    return;
  }
  const live = node.audioHostLiveParams?.[meta.id];
  map[meta.id] = { name: meta.name, value: live ?? meta.default ?? 0.5 };
  saveAddedParams(node, map);
  rebuildParamWidgets(node);
}

function requestParams(node) {
  const plugin = selectedPlugin(node);
  if (!plugin) return Promise.resolve();
  return api
    .fetchApi("/comfy-audiohost/parameters", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plugin }),
    })
    .then(async (response) => {
      if (!response.ok) throw new Error(await response.text());
      const data = await response.json();
      node.audioHostParams = data.parameters ?? [];
      node.audioHostLiveParams = null;
      syncParamPicker(node);
      rebuildParamWidgets(node);
    })
    .catch((error) => console.error("[comfy-audiohost]", error));
}

// Switching plugins invalidates everything derived from the old one.
function resetPluginDependentState(node) {
  saveAddedParams(node, {});
  node.audioHostParams = [];
  node.audioHostLiveParams = null;
  stopStatePolling(node);
  closeSession(node);
  rebuildParamWidgets(node);
  syncParamPicker(node);
  scheduleBusSync(node);
  requestParams(node);
}

// ---------------------------------------------------------------------------
// Input slots: main audio + sidechains + linked parameter slots
// ---------------------------------------------------------------------------

function disconnectInput(node, index) {
  try {
    const linkId = node.inputs?.[index]?.link;
    if (linkId != null) node.graph?.removeLink?.(linkId);
  } catch (error) {
    console.warn("[comfy-audiohost] failed to disconnect input", error);
  }
}

function sidechainCount(node) {
  const inputs = node.audioHostBuses?.inputs ?? [];
  return inputs.filter((bus) => !bus.main && bus.channels > 0).length;
}

function boundParamSlots(node) {
  const entries = [];
  for (const spec of Object.values(addedParams(node))) {
    if (spec.slot != null) {
      entries.push({ slot: spec.slot, name: `param_${spec.slot}`, label: spec.name });
    }
  }
  return entries.sort((a, b) => a.slot - b.slot);
}

// Manage the node's input slots to exactly ["audio", sidechain_1..N,
// param_X...] where N is the probed auxiliary bus count and param_X are the
// parameter rows bound with "→ Input". Follows the comfy-mss ensemble node's
// deferred-sync pattern so slots are never touched while litegraph is still
// restoring a loaded workflow's links.
function syncNodeInputs(node) {
  const count = Math.min(sidechainCount(node), MAX_SIDECHAIN_SLOTS);
  const bound = boundParamSlots(node);
  const types = { audio: "AUDIO" };
  for (let index = 1; index <= count; index += 1) types[`sidechain_${index}`] = "AUDIO";
  for (const entry of bound) types[entry.name] = "FLOAT";
  const desired = [
    "audio",
    ...Array.from({ length: count }, (_value, index) => `sidechain_${index + 1}`),
    ...bound.map((entry) => entry.name),
  ];

  node.inputs ||= [];
  for (let index = node.inputs.length - 1; index >= 0; index -= 1) {
    if (!desired.includes(node.inputs[index]?.name ?? "")) {
      disconnectInput(node, index);
      if (typeof node.removeInput === "function") {
        node.removeInput(index);
      } else {
        node.inputs.splice(index, 1);
      }
    }
  }

  for (let index = 0; index < desired.length; index += 1) {
    const name = desired[index];
    if (node.inputs[index]?.name !== name) {
      const existingIndex = node.inputs.findIndex((input) => input.name === name);
      if (existingIndex >= 0) {
        const [existing] = node.inputs.splice(existingIndex, 1);
        node.inputs.splice(index, 0, existing);
      } else {
        node.addInput(name, types[name] ?? "*");
        const [created] = node.inputs.splice(node.inputs.length - 1, 1);
        node.inputs.splice(index, 0, created);
      }
    }
    const binding = bound.find((entry) => entry.name === name);
    if (binding) node.inputs[index].label = binding.label;
  }
  node.inputs.length = desired.length;
  fitNodeSize(node);
}

function scheduleNodeInputSync(node) {
  setTimeout(() => syncNodeInputs(node), 0);
  setTimeout(() => syncNodeInputs(node), 250);
}

async function requestBuses(node) {
  const plugin = selectedPlugin(node);
  if (!plugin) return;
  const response = await api.fetchApi("/comfy-audiohost/buses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plugin }),
  });
  if (!response.ok) throw new Error(await response.text());
  const data = await response.json();
  node.audioHostBuses = data.buses;
  syncNodeInputs(node);
}

function scheduleBusSync(node) {
  requestBuses(node).catch((error) => console.error("[comfy-audiohost]", error));
}

// ---------------------------------------------------------------------------
// Node registration
// ---------------------------------------------------------------------------

function registerAudioHostNode(nodeType) {
  const onNodeCreated = nodeType.prototype.onNodeCreated;
  nodeType.prototype.onNodeCreated = function () {
    const result = onNodeCreated?.apply(this, arguments);
    for (const name of [STATE_WIDGET, PARAMS_WIDGET]) {
      const widget = getWidget(this, name);
      if (widget) widget.hidden = true;
    }

    const pluginWidget = getWidget(this, "plugin");
    if (pluginWidget) {
      const callback = pluginWidget.callback;
      pluginWidget.callback = (value, canvas, node, pos, event) => {
        const callbackResult = callback?.call(pluginWidget, value, canvas, node, pos, event);
        resetPluginDependentState(this);
        scheduleNodeInputSync(this);
        return callbackResult;
      };
    }

    this.addWidget("button", "Refresh Plugin List", null, () => {
      refreshPlugins(this).catch((error) => console.error("[comfy-audiohost]", error));
    });
    this.addWidget("button", "Open Plugin Editor", null, () => {
      openEditor(this).catch((error) => console.error("[comfy-audiohost]", error));
    });
    this.audiohostCaptureButton = this.addWidget("button", "Capture Plugin State", null, () => {
      captureState(this).catch((error) => console.error("[comfy-audiohost]", error));
    });

    // litegraph throws when a combo widget is created without values.
    this.audioHostParamPicker = this.addWidget(
      "combo",
      "param_picker",
      NO_PARAMS_PLACEHOLDER,
      () => {},
      { values: [NO_PARAMS_PLACEHOLDER] }
    );
    this.audioHostParamPicker.serialize = false;
    this.addWidget("button", "Add Parameter", null, () => addSelectedParam(this));

    updateCaptureLabel(this);
    fitNodeSize(this);
    scheduleNodeInputSync(this);
    syncPluginChoices(this);
    requestParams(this);
    return result;
  };

  const onConfigure = nodeType.prototype.onConfigure;
  nodeType.prototype.onConfigure = function (...args) {
    const result = onConfigure?.apply(this, args);
    updateCaptureLabel(this);
    fitNodeSize(this);
    scheduleNodeInputSync(this);
    scheduleBusSync(this);
    requestParams(this);
    return result;
  };

  const onRemoved = nodeType.prototype.onRemoved;
  nodeType.prototype.onRemoved = function () {
    stopStatePolling(this);
    closeSession(this);
    return onRemoved?.apply(this, arguments);
  };
}

app.registerExtension({
  name: "comfy-audiohost",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name === NODE_TYPE) registerAudioHostNode(nodeType);
  },
});
