const {
  createSimulatorFigmaApi
} = require("./figma-api");
const {
  createScreenImportRuntime
} = require("../plugin/screen-import-runtime");
const {
  createFigmaFrameExportSelectionState
} = require("../plugin/figma-frame-export-selection");
const pluginFrame = document.querySelector("iframe");

const figmaApi = createSimulatorFigmaApi();
const postPluginMessage = (message) => {
  pluginFrame.contentWindow?.postMessage({ pluginMessage: message }, "*");
};
const importRuntime = createScreenImportRuntime({
  figmaApi,
  postMessage: postPluginMessage,
  onImported: () => {}
});

window.addEventListener("message", async (event) => {
  const message = event.data?.pluginMessage;
  if (!message) return;

  if (await importRuntime.handle(message)) {
    postPluginMessage(createFigmaFrameExportSelectionState(figmaApi));
    return;
  }

  if (message.type === "request-figma-frame-export-selection-state") {
    postPluginMessage(createFigmaFrameExportSelectionState(figmaApi));
    return;
  }

  if (message.type === "close") {
    return;
  }

});

window.ImageToSliceSimulatorLoaded = true;
