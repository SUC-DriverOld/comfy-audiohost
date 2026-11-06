import { api } from "../../../scripts/api.js";

import { MAX_SIDECHAIN_SLOTS } from "./constants.js";
import { fitNodeSize, getWidget, selectedPlugin } from "./utils.js";

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
export function syncNodeInputs(node) {
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

export function scheduleNodeInputSync(node) {
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

export function scheduleBusSync(node) {
  requestBuses(node).catch((error) => console.error("[comfy-audiohost]", error));
}
