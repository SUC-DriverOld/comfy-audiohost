import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

import {
  DELETE_GAP,
  DELETE_WIDTH,
  NO_PARAMS_PLACEHOLDER,
  PARAMS_WIDGET,
  PARAM_WIDGET_PREFIX,
  WIDGET_MARGIN,
} from "./constants.js";
import { fitNodeSize, getWidget, selectedPlugin } from "./utils.js";

function paramWidgetName(id) {
  return `${PARAM_WIDGET_PREFIX}${id}`;
}

export function addedParams(node) {
  try {
    const parsed = JSON.parse(String(getWidget(node, PARAMS_WIDGET)?.value || "{}"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    return {};
  }
}

export function saveAddedParams(node, map) {
  const widget = getWidget(node, PARAMS_WIDGET);
  if (widget) widget.value = JSON.stringify(map);
}

// Rebuild the dynamic parameter rows from the param_values JSON and the
// probed metadata. Each row is a slider whose built-in drawing is narrowed to
// leave room for a small "Delete" button drawn inline at the right end (see
// drawRemoveButtons and the canvas capture listener). Widgets never serialize
// (values live in param_values), so workflow round-trips stay positional-safe.
export function rebuildParamWidgets(node) {
  const widgets = node.widgets ?? [];
  for (let index = widgets.length - 1; index >= 0; index -= 1) {
    if (String(widgets[index]?.name ?? "").startsWith(PARAM_WIDGET_PREFIX)) {
      if (typeof node.removeWidget === "function") {
        node.removeWidget(widgets[index]);
      } else {
        widgets.splice(index, 1);
      }
    }
  }
  const map = addedParams(node);
  for (const [id, spec] of Object.entries(map)) {
    const meta = (node.audioHostParams ?? []).find((param) => param.id === id);
    const step = meta?.steps > 1 ? 1 / (meta.steps - 1) : 0.001;
    const slider = node.addWidget(
      "number",
      spec.name,
      Number(spec.value) || 0,
      (value) => onParamChanged(node, id, value),
      // step2 is the frontend's per-click increment (step*0.1 otherwise).
      { min: 0, max: 1, step, step2: 0.001 }
    );
    slider.name = paramWidgetName(id);
    slider.label = spec.name;
    slider.serialize = false;
    // Narrow the slider's own drawing so the inline "Delete" button fits.
    // Derive the width from the node size, NOT the width argument: the
    // frontend feeds widget.width back into subsequent draw calls, so using
    // the argument would shrink the slider a little more every frame.
    // widget.width mirrors the value because the frontend sizes the +/- arrow
    // click zones from width || node width.
    slider.draw = (ctx, canvas, width, showText) => {
      slider.width = Math.max(60, node.size[0] - DELETE_WIDTH - DELETE_GAP);
      slider.drawWidget(ctx, { width: slider.width, showText: showText !== false });
    };
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

function onParamChanged(node, id, value) {
  const map = addedParams(node);
  if (!map[id]) return;
  map[id].value = Number(value);
  saveAddedParams(node, map);
  // Mirror the change into the live editor session, if one exists; without a
  // session the override is still applied at execution time.
  if (node.id != null) {
    api
      .fetchApi("/comfy-audiohost/set-parameter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          node_id: String(node.id),
          parameter_id: String(id),
          value: Number(value),
        }),
      })
      .catch(() => {});
  }
}

// GUI -> sliders: silently adopt the live session's parameter values so both
// sides stay in sync without triggering the change callbacks.
export function applyLiveParameters(node, values) {
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

export function paramPickerValues(node) {
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

export function syncParamPicker(node) {
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

export function requestParams(node) {
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

// Paint one rounded "Delete" button at the right end of every parameter
// slider row and record its graph-space hit rectangle on the node.
export function drawRemoveButtons(ctx, node) {
  node.audioHostRemoveHits = [];
  if (node.flags?.collapsed) return;
  for (const widget of node.widgets ?? []) {
    const name = String(widget?.name ?? "");
    if (!name.startsWith(PARAM_WIDGET_PREFIX) || widget.hidden) continue;
    const width = DELETE_WIDTH;
    const x = node.size[0] - WIDGET_MARGIN - width;
    const y = widget.y + 1;
    const height = Math.max(12, (widget.height ?? 20) - 3);
    ctx.save();
    ctx.fillStyle = "#222222";
    ctx.strokeStyle = "#666666";
    ctx.lineWidth = 1;
    if (typeof ctx.roundRect === "function") {
      ctx.beginPath();
      ctx.roundRect(x + 0.5, y + 0.5, width, height, 4);
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.fillRect(x, y, width, height);
      ctx.strokeRect(x + 0.5, y + 0.5, width, height);
    }
    ctx.fillStyle = "#DDDDDD";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Delete", x + width / 2, y + height / 2 + 0.5);
    ctx.restore();
    node.audioHostRemoveHits.push({
      id: name.slice(PARAM_WIDGET_PREFIX.length),
      rect: [node.pos[0] + x, node.pos[1] + y, width, height],
    });
  }
}

// Intercept clicks on the inline "Delete" buttons before litegraph hands the
// event to the underlying slider widget. The canvas listens for pointer
// events (not mouse events), so this hooks window capture on pointerdown.
export function handleRemoveClick(event) {
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

// Create the parameter picker and its "Add Parameter" button on a new node.
export function createParamWidgets(node) {
  // litegraph throws when a combo widget is created without values.
  node.audioHostParamPicker = node.addWidget(
    "combo",
    "param_picker",
    NO_PARAMS_PLACEHOLDER,
    () => {},
    { values: [NO_PARAMS_PLACEHOLDER] }
  );
  node.audioHostParamPicker.serialize = false;
  node.addWidget("button", "Add Parameter", null, () => addSelectedParam(node));
}
