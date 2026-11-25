/*
 * Copyright (c) 2026 Nythxion Studios.
 * All Rights Reserved.
 *
 * This file is part of Nythxion Shortcuts.
 * Licensed under the Nythxion Source-Available Attribution License (NSAAL) 1.0.
 *
 * See the LICENSE file for details.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("shortcuter", {
    saveShortcuts: (shortcuts) => {
        return ipcRenderer.invoke("save-shortcuts", shortcuts);
    },
    getState: () => ipcRenderer.invoke("get-state"),
    findApps: (query) => ipcRenderer.invoke("find-apps", query),
    applySettings: (settings) => ipcRenderer.invoke("apply-settings", settings),
    setOverlayInteractive: (interactive) => {
        ipcRenderer.send("overlay-interactive", interactive === true);
    },
    overlayControl: (action) => {
        ipcRenderer.send("overlay-control", action);
    },
    onOverlayState: (callback) => {
        const listener = (_, state) => callback(state);
        ipcRenderer.on("overlay-state", listener);
        return () => ipcRenderer.removeListener("overlay-state", listener);
    },
    onSettingsUpdated: (callback) => {
        const listener = (_, settings) => callback(settings);
        ipcRenderer.on("settings-updated", listener);
        return () => ipcRenderer.removeListener("settings-updated", listener);
    },
    onLaunchError: (callback) => {
        const listener = (_, error) => callback(error);
        ipcRenderer.on("launch-error", listener);
        return () => ipcRenderer.removeListener("launch-error", listener);
    }
});