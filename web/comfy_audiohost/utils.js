import { NODE_WIDTH } from "./constants.js";

export function getWidget(node, name) {
  return node.widgets?.find((widget) => widget.name === name);
}

export function selectedPlugin(node) {
  const value = String(getWidget(node, "plugin")?.value ?? "");
  return value.startsWith("(") ? null : value;
}

// Recompute the node's natural height (slots + visible widgets) while keeping
// a stable width, so the node grows with added slots/controls and shrinks
// back when they are removed.
export function fitNodeSize(node) {
  node.setSize(node.computeSize());
  node.size[0] = NODE_WIDTH;
  node.setDirtyCanvas(true, true);
}
