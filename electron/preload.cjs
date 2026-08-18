"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("flashSimulatorDesktop", {
  isElectron: true,
  getZoomPercent() {
    return ipcRenderer.invoke("flash-sim:get-zoom");
  },
  setZoomPercent(percent) {
    return ipcRenderer.invoke("flash-sim:set-zoom", percent);
  },
});
