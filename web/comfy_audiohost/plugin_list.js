import { api } from "../../../scripts/api.js";

import {
  rebuildParamWidgets,
  requestParams,
  saveAddedParams,
  syncParamPicker,
} from "./params.js";
import { closeSession, stopStatePolling } from "./session.js";
import { scheduleBusSync } from "./sidechain.js";
import { getWidget } from "./utils.js";

export function storePluginList(node, plugins) {
  const combo = getWidget(node, "plugin");
  if (!combo) return;
  let values = plugins.slice();
  if (combo.value && !values.includes(combo.value)) values = [combo.value, ...values];
  combo.options.values = values;
  node.setDirtyCanvas(true, true);
}

export async function refreshPlugins(node) {
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

export function syncPluginChoices(node) {
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

// Switching plugins invalidates everything derived from the old one.
export function resetPluginDependentState(node) {
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
