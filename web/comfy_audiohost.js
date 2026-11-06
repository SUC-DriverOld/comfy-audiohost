import { app } from "../../scripts/app.js";

import { PARAMS_WIDGET, STATE_WIDGET } from "./comfy_audiohost/constants.js";
import {
  createParamWidgets,
  drawRemoveButtons,
  handleRemoveClick,
  requestParams,
} from "./comfy_audiohost/params.js";
import {
  refreshPlugins,
  resetPluginDependentState,
  syncPluginChoices,
} from "./comfy_audiohost/plugin_list.js";
import { openEditor } from "./comfy_audiohost/session.js";
import { scheduleBusSync, scheduleNodeInputSync } from "./comfy_audiohost/sidechain.js";
import { fitNodeSize, getWidget } from "./comfy_audiohost/utils.js";

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

    createParamWidgets(this);
    fitNodeSize(this);
    scheduleNodeInputSync(this);
    scheduleBusSync(this);
    syncPluginChoices(this);
    requestParams(this);
    return result;
  };

  const onConfigure = nodeType.prototype.onConfigure;
  nodeType.prototype.onConfigure = function (...args) {
    const result = onConfigure?.apply(this, args);
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
    if (nodeData.name === "audiohost_effect") registerAudioHostNode(nodeType);
  },
  setup() {
    window.addEventListener("pointerdown", handleRemoveClick, true);
  },
});
