export const NODE_TYPE = "audiohost_effect";
export const STATE_WIDGET = "plugin_state";
export const PARAMS_WIDGET = "param_values";

export const POLL_INTERVAL_MS = 3000;
export const MAX_SIDECHAIN_SLOTS = 3;
export const NODE_WIDTH = 300;

// Inline "Delete" button on each parameter slider row. WIDGET_MARGIN matches
// litegraph's BaseWidget.margin so the button's right edge lines up with the
// regular widgets (buttons, combos) above it.
export const WIDGET_MARGIN = 15;
export const DELETE_WIDTH = 40;
export const DELETE_GAP = 6;

// Widget name prefix for dynamic parameter sliders.
export const PARAM_WIDGET_PREFIX = "param:";
export const NO_PARAMS_PLACEHOLDER = "(no parameters)";
