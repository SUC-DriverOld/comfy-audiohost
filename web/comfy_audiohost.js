import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_TYPE = "audiohost_effect";
const STATE_WIDGET = "plugin_state";
const POLL_INTERVAL_MS = 3000;
const MAX_SIDECHAIN_SLOTS = 3;
const NODE_WIDTH = 300;

// Recompute the node's natural height (slots + visible widgets) while keeping
// a stable width, so the node grows with added sidechain slots and shrinks
// back when they are removed.
function fitNodeSize(node) {
  node.setSize(node.computeSize());
  node.size[0] = NODE_WIDTH;
  node.setDirtyCanvas(true, true);
}

function getWidget(node, name) {
  return node.widgets?.find((widget) => widget.name === name);
}

function selectedPlugin(node) {
  const value = String(getWidget(node, "plugin")?.value ?? "");
  return value.startsWith("(") ? null : value;
}

function stateSizeLabel(node) {
  const value = String(getWidget(node, STATE_WIDGET)?.value ?? "");
  if (!value) return null;
  return `${Math.max(1, Math.round((value.length * 0.75) / 1024))} KB`;
}

function updateCaptureLabel(node) {
  const button = node.audiohostCaptureButton;
  if (!button) return;
  const size = stateSizeLabel(node);
  button.label = size ? `Capture Plugin State (saved: ${size})` : "Capture Plugin State";
  node.setDirtyCanvas(true, true);
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
  // The editor window was closed (by the user or the plugin): the final state
  // is in hand, so end the poll loop and release the server-side worker.
  if (data.editor_open === false) {
    stopStatePolling(node);
    closeSession(node);
  }
  return data;
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

// While the editor is open, keep syncing its live state into the hidden
// widget so the workflow always carries the latest settings without making
// the user remember to click capture.
function startStatePolling(node) {
  stopStatePolling(node);
  node.audiohostPollTimer = setInterval(() => {
    captureState(node).catch(() => stopStatePolling(node));
  }, POLL_INTERVAL_MS);
}

async function refreshPlugins(node) {
  const widget = getWidget(node, "plugin");
  if (!widget) return;
  const response = await api.fetchApi("/comfy-audiohost/scan", { method: "POST" });
  if (!response.ok) throw new Error(await response.text());
  const data = await response.json();
  const plugins = data.plugins ?? [];
  const previous = widget.value;
  widget.options.values = plugins;
  if (!plugins.includes(widget.value)) widget.value = plugins[0] ?? "";
  if (Object.keys(data.errors ?? {}).length) {
    console.warn("[comfy-audiohost] scan skipped some plugins:", data.errors);
  }
  node.setDirtyCanvas(true, true);
  if (widget.value !== previous) {
    stopStatePolling(node);
    closeSession(node);
    scheduleBusSync(node);
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
function syncSidechainInputs(node) {
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

function scheduleSidechainSync(node) {
  setTimeout(() => syncSidechainInputs(node), 0);
  setTimeout(() => syncSidechainInputs(node), 250);
}

// Ask the backend for the selected plugin's bus layout (cached server-side)
// and show one sidechain slot per auxiliary input bus it exposes.
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
  syncSidechainInputs(node);
}

function scheduleBusSync(node) {
  requestBuses(node).catch((error) => console.error("[comfy-audiohost]", error));
}

function syncPluginChoices(node) {
  api.fetchApi("/comfy-audiohost/plugins").then(async (response) => {
    if (!response.ok) return;
    const data = await response.json();
    const widget = getWidget(node, "plugin");
    if (!widget || !Array.isArray(data.plugins) || !data.plugins.length) return;
    widget.options.values = data.plugins;
    if (!data.plugins.includes(widget.value)) {
      widget.value = data.plugins[0];
      scheduleBusSync(node);
    }
    node.setDirtyCanvas(true, true);
  });
}

function registerAudioHostNode(nodeType) {
  const onNodeCreated = nodeType.prototype.onNodeCreated;
  nodeType.prototype.onNodeCreated = function () {
    const result = onNodeCreated?.apply(this, arguments);
    const stateWidget = getWidget(this, STATE_WIDGET);
    if (stateWidget) stateWidget.hidden = true;

    const pluginWidget = getWidget(this, "plugin");
    if (pluginWidget) {
      const callback = pluginWidget.callback;
      pluginWidget.callback = (value, canvas, node, pos, event) => {
        const callbackResult = callback?.call(pluginWidget, value, canvas, node, pos, event);
        // The old plugin's editor session (its worker process and window)
        // must not survive a selection change.
        stopStatePolling(this);
        closeSession(this);
        scheduleSidechainSync(this);
        scheduleBusSync(this);
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
    updateCaptureLabel(this);
    fitNodeSize(this);
    scheduleSidechainSync(this);
    syncPluginChoices(this);
    return result;
  };

  const onConfigure = nodeType.prototype.onConfigure;
  nodeType.prototype.onConfigure = function (...args) {
    const result = onConfigure?.apply(this, args);
    updateCaptureLabel(this);
    fitNodeSize(this);
    scheduleSidechainSync(this);
    scheduleBusSync(this);
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
