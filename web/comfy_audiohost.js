import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_TYPE = "audiohost_effect";
const STATE_WIDGET = "plugin_state";
const PARAMS_WIDGET = "param_values";
const POLL_INTERVAL_MS = 3000;
const MAX_SIDECHAIN_SLOTS = 3;
const NODE_WIDTH = 300;
// Width of the inline "×" remove button drawn at the right end of each
// parameter slider row.
const REMOVE_STRIP = 26;

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
// probed metadata. Each row is a slider whose built-in drawing is narrowed to
// leave room for a small "×" button drawn inline at the right end (see
// drawRemoveButtons and the canvas capture listener). Widgets never serialize
// (values live in param_values), so workflow round-trips stay positional-safe.
function rebuildParamWidgets(node) {
  const widgets = node.widgets ?? [];
  for (let index = widgets.length - 1; index >= 0; index -= 1) {
    if (String(widgets[index]?.name ?? "").startsWith("param:")) {
      if (typeof node.removeWidget === "function") {
        node.removeWidget(widgets[index]);
      } else {
        widgets.splice(index, 1);
      }
    }
  }
  const map = addedParams(node);
  for (const [id, spec] of Object.entries(map)) {
    const slider = node.addWidget(
      "number",
      spec.name,
      Number(spec.value) || 0,
      (value) => onParamChanged(node, id, value),
      { min: 0, max: 1, step: 0.001 }
    );
    slider.name = paramWidgetName(id);
    slider.label = spec.name;
    slider.serialize = false;
    // Narrow the slider's own drawing so the inline "×" strip stays clear.
    slider.draw = (ctx, canvas, width, showText) =>
      slider.drawWidget(ctx, {
        width: Math.max(60, width - REMOVE_STRIP),
        showText: showText !== false,
      });
  }
  node.audioHostRemoveHits = [];
  fitNodeSize(node);
}

function removeParam(node, id) {
  const map = addedParams(node);
  if (!map[id]) return;
  delete map[id];
  saveAddedParams(node, map);
  rebuildParamWidgets(node);
}

// Paint one small "×" at the right end of every parameter slider row and
// record its graph-space hit rectangle on the node.
function drawRemoveButtons(ctx, node) {
  node.audioHostRemoveHits = [];
  if (node.flags?.collapsed) return;
  for (const widget of node.widgets ?? []) {
    const name = String(widget?.name ?? "");
    if (!name.startsWith("param:") || widget.hidden) continue;
    const x = node.size[0] - REMOVE_STRIP + 2;
    const y = widget.y + 1;
    const width = REMOVE_STRIP - 6;
    const height = Math.max(10, (widget.height ?? 20) - 2);
    ctx.save();
    ctx.fillStyle = "#3a3a3a";
    ctx.fillRect(x, y, width, height);
    ctx.fillStyle = "#dddddd";
    ctx.font = "11px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("×", x + width / 2, y + height / 2 + 0.5);
    ctx.restore();
    node.audioHostRemoveHits.push({
      id: name.slice("param:".length),
      rect: [node.pos[0] + x, node.pos[1] + y, width, height],
    });
  }
}

// Intercept clicks on the inline "×" buttons before litegraph hands the
// event to the underlying slider widget. Bound to window capture so it runs
// ahead of the canvas listeners no matter how the frontend exposes them.
function handleRemoveClick(event) {
  const canvas = app.canvas;
  if (!canvas?.convertEventToCanvasOffset || !app.graph?._nodes) return;
  const pos = canvas.convertEventToCanvasOffset({
    clientX: event.clientX,
    clientY: event.clientY,
  });
  for (const node of app.graph._nodes) {
    for (const hit of node.audioHostRemoveHits ?? []) {
      const [x, y, width, height] = hit.rect;
      if (pos[0] >= x && pos[0] <= x + width && pos[1] >= y && pos[1] <= y + height) {
        event.stopPropagation();
        event.preventDefault();
        removeParam(node, hit.id);
        return;
      }
    }
  }
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
// Input slots: main audio + sidechains
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

// Manage the node's input slots to exactly ["audio", sidechain_1..N] where N
// is the probed auxiliary input bus count. Follows the comfy-mss ensemble
// node's deferred-sync pattern so slots are never touched while litegraph is
// still restoring a loaded workflow's links.
function syncNodeInputs(node) {
  const count = Math.min(sidechainCount(node), MAX_SIDECHAIN_SLOTS);
  const desired = [
    "audio",
    ...Array.from({ length: count }, (_value, index) => `sidechain_${index + 1}`),
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
        node.addInput(name, "AUDIO");
        const [created] = node.inputs.splice(node.inputs.length - 1, 1);
        node.inputs.splice(index, 0, created);
      }
    }
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

  const onDrawForeground = nodeType.prototype.onDrawForeground;
  nodeType.prototype.onDrawForeground = function (ctx) {
    const result = onDrawForeground?.apply(this, arguments);
    drawRemoveButtons(ctx, this);
    return result;
  };
}

app.registerExtension({
  name: "comfy-audiohost",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name === NODE_TYPE) registerAudioHostNode(nodeType);
  },
  setup() {
    window.addEventListener("mousedown", handleRemoveClick, true);
  },
});
