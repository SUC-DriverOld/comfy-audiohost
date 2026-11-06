import { api } from "../../../scripts/api.js";

import { POLL_INTERVAL_MS, STATE_WIDGET } from "./constants.js";
import { applyLiveParameters } from "./params.js";
import { getWidget, selectedPlugin } from "./utils.js";

export function closeSession(node) {
  if (node.id == null) return;
  api
    .fetchApi("/comfy-audiohost/close", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ node_id: String(node.id) }),
    })
    .catch(() => {});
}

export function stopStatePolling(node) {
  if (node.audiohostPollTimer != null) {
    clearInterval(node.audiohostPollTimer);
    node.audiohostPollTimer = null;
  }
}

// While the editor is open, keep syncing its live state and parameter values
// into the hidden widgets so the workflow always carries the latest settings.
export function startStatePolling(node) {
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
  }
  applyLiveParameters(node, data.parameters);
  // The editor window was closed (by the user or the plugin): the final state
  // is in hand, so end the poll loop and release the server-side worker.
  if (data.editor_open === false) {
    stopStatePolling(node);
    closeSession(node);
  }
}

export async function openEditor(node) {
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
