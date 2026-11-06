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

export function updateEditorButton(node) {
  const button = node.audiohostEditorButton;
  if (!button) return;
  button.label = node.audiohostEditorOpen ? "Close Plugin Editor" : "Open Plugin Editor";
  node.setDirtyCanvas(true, true);
}

// While the editor is open, keep syncing its live state and parameter values
// into the hidden widgets so the workflow always carries the latest settings.
export function startStatePolling(node) {
  stopStatePolling(node);
  node.audiohostPollTimer = setInterval(() => {
    captureState(node).catch(() => stopStatePolling(node));
  }, POLL_INTERVAL_MS);
}

export async function captureState(node) {
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
    node.audiohostEditorOpen = false;
    updateEditorButton(node);
  }
}

// Capture the final settings, then drop the session (its worker closes the
// editor window with it).
export async function closeEditorSession(node) {
  try {
    await captureState(node);
  } catch (error) {
    // No live session (closed or crashed already): just drop local state.
  }
  stopStatePolling(node);
  closeSession(node);
  node.audiohostEditorOpen = false;
  updateEditorButton(node);
}

// Button toggle: open the editor, or close it when it is already open.
export async function toggleEditor(node) {
  if (node.audiohostEditorOpen) {
    await closeEditorSession(node);
  } else {
    await openEditor(node);
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
  node.audiohostEditorOpen = true;
  updateEditorButton(node);
  startStatePolling(node);
}
