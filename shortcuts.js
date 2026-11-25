/*
 * Copyright (c) 2026 Nythxion Studios.
 * All Rights Reserved.
 *
 * This file is part of Nythxion Shortcuts.
 * Licensed under the Nythxion Source-Available Attribution License (NSAAL) 1.0.
 *
 * See the LICENSE file for details.
 */

const { globalShortcut, shell } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

let shortcuts = {};
const registeredShortcuts = new Set();
let launchErrorHandler = () => {};

function normalizeAccelerator(key) {
    if (typeof key !== "string" || !key.trim()) {
        return null;
    }

    const aliases = {
        CTRL: "CmdOrCtrl",
        CONTROL: "CmdOrCtrl",
        CMD: "CmdOrCtrl",
        COMMAND: "CmdOrCtrl",
        ALT: "Alt",
        OPTION: "Alt",
        SHIFT: "Shift",
        WIN: "Super",
        SUPER: "Super",
        META: "Super"
    };
    const parts = key.split("+").map(part => part.trim().toUpperCase());
    if (parts.some(part => !part)) {
        return null;
    }

    const modifiers = parts.slice(0, -1);
    const finalKey = parts[parts.length - 1];
    const normalizedModifiers = modifiers.map(part => aliases[part]);
    const finalKeyNames = {
        PLUS: "Plus",
        SPACE: "Space",
        TAB: "Tab",
        CAPSLOCK: "Capslock",
        NUMLOCK: "Numlock",
        SCROLLLOCK: "Scrolllock",
        BACKSPACE: "Backspace",
        DELETE: "Delete",
        INSERT: "Insert",
        RETURN: "Return",
        ENTER: "Enter",
        UP: "Up",
        DOWN: "Down",
        LEFT: "Left",
        RIGHT: "Right",
        HOME: "Home",
        END: "End",
        PAGEUP: "PageUp",
        PAGEDOWN: "PageDown",
        ESCAPE: "Escape",
        ESC: "Esc",
        VOLUMEUP: "VolumeUp",
        VOLUMEDOWN: "VolumeDown",
        VOLUMEMUTE: "VolumeMute",
        MEDIANEXTTRACK: "MediaNextTrack",
        MEDIAPREVIOUSTRACK: "MediaPreviousTrack",
        MEDIASTOP: "MediaStop",
        MEDIAPLAYPAUSE: "MediaPlayPause",
        PRINTSCREEN: "PrintScreen",
        NUMDEC: "numdec",
        NUMADD: "numadd",
        NUMSUB: "numsub",
        NUMMULT: "nummult",
        NUMDIV: "numdiv",
        NUMENTER: "numenter"
    };
    const validFinalKey = /^[A-Z0-9]$/.test(finalKey)
        || /^F(?:[1-9]|1[0-9]|2[0-4])$/.test(finalKey)
        || /^(PLUS|SPACE|TAB|CAPSLOCK|NUMLOCK|SCROLLLOCK|BACKSPACE|DELETE|INSERT|RETURN|ENTER|UP|DOWN|LEFT|RIGHT|HOME|END|PAGEUP|PAGEDOWN|ESCAPE|ESC|VOLUMEUP|VOLUMEDOWN|VOLUMEMUTE|MEDIANEXTTRACK|MEDIAPREVIOUSTRACK|MEDIASTOP|MEDIAPLAYPAUSE|PRINTSCREEN|NUM[0-9]|NUMDEC|NUMADD|NUMSUB|NUMMULT|NUMDIV|NUMENTER)$/.test(finalKey);
    if (!modifiers.length
        || !validFinalKey
        || normalizedModifiers.some(part => !part)
        || new Set(normalizedModifiers).size !== normalizedModifiers.length) {
        return null;
    }

    const normalizedFinalKey = finalKeyNames[finalKey]
        || (/^NUM[0-9]$/.test(finalKey) ? finalKey.toLowerCase() : finalKey);
    return [...normalizedModifiers, normalizedFinalKey].join("+");
}

function normalizeWebsiteTarget(target) {
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(target) || /^(mailto|tel|magnet):/i.test(target)) {
        return target;
    }
    return `https://${target}`;
}

function reportLaunchError(shortcut, message, error) {
    const details = error && error.message ? `${message}: ${error.message}` : message;
    console.error(`[Shortcuter] Failed to launch ${shortcut.name}: ${details}`);
    launchErrorHandler({
        name: shortcut.name || "App",
        message: details
    });
}

function launchDesktopEntry(shortcut, target) {
    const launcher = spawn("gio", ["launch", target], {
        cwd: path.dirname(target),
        detached: true,
        stdio: "ignore"
    });
    launcher.once("error", error => {
        reportLaunchError(shortcut, `Could not launch ${target} with gio`, error);
    });
    launcher.unref();
}

function launchApp(shortcut) {
    const target = shortcut.target;
    if (!path.isAbsolute(target)) {
        reportLaunchError(shortcut, `The saved app path is not absolute: ${target}`);
        return;
    }

    let targetStat;
    try {
        targetStat = fs.statSync(target);
    } catch (error) {
        reportLaunchError(shortcut, `The saved app could not be found at ${target}`, error);
        return;
    }
    if (!targetStat.isFile()) {
        reportLaunchError(shortcut, `The saved app path is not a file: ${target}`);
        return;
    }

    const extension = path.extname(target).toLowerCase();
    if (process.platform === "win32" && extension !== ".exe") {
        shell.openPath(target).then(errorMessage => {
            if (errorMessage) {
                reportLaunchError(shortcut, `Windows could not open ${target}`, new Error(errorMessage));
            }
        }).catch(error => reportLaunchError(shortcut, `Windows could not open ${target}`, error));
        return;
    }

    if (process.platform === "linux" && extension === ".desktop") {
        launchDesktopEntry(shortcut, target);
        return;
    }

    const appProcess = spawn(target, [], {
        cwd: path.dirname(target),
        detached: true,
        stdio: "ignore",
        windowsHide: false
    });
    appProcess.once("error", error => {
        reportLaunchError(shortcut, `Could not start ${target}`, error);
    });
    appProcess.unref();
}

async function openTarget(shortcut) {
    if (!shortcut || !shortcut.target) {
        return;
    }

    console.log(`[Shortcuter] Opening ${shortcut.name}...`);

    try {
        if (shortcut.type === "website") {
            await shell.openExternal(normalizeWebsiteTarget(shortcut.target));
            return;
        }

        if (shortcut.type === "app") {
            launchApp(shortcut);
            return;
        }

        console.warn(
            `[Shortcuter] Unknown shortcut type for ${shortcut.name}: ${shortcut.type}`
        );
    } catch (error) {
        reportLaunchError(shortcut, "The target could not be opened", error);
    }
}

function unregisterAllShortcuts() {
    for (const accelerator of registeredShortcuts) {
        globalShortcut.unregister(accelerator);
    }

    registeredShortcuts.clear();
}

function registerShortcuts() {
    unregisterAllShortcuts();

    for (const shortcut of Object.values(shortcuts)) {
        const accelerator = normalizeAccelerator(shortcut.key);

        if (!accelerator) {
            console.warn(
                `[Shortcuter] Invalid shortcut for ${shortcut.name}: ${shortcut.key}. Skipping registration.`
            );

            continue;
        }

        let registered;
        try {
            registered = globalShortcut.register(
                accelerator,
                () => {
                    openTarget(shortcut);
                }
            );
        } catch (error) {
            console.error(
                `[Shortcuter] Could not register ${shortcut.name} (${accelerator}):`,
                error
            );
            continue;
        }

        if (!registered) {
            console.warn(
                `[Shortcuter] Could not register ${shortcut.name} (${accelerator}). It may already be in use.`
            );

            continue;
        }

        registeredShortcuts.add(accelerator);

        console.log(
            `[Shortcuter] Registered ${shortcut.name}: ${accelerator}`
        );
    }
}

function startShortcuts(initialShortcuts) {
    shortcuts = initialShortcuts || {};

    registerShortcuts();

    console.log("[Shortcuter] Global shortcuts started.");
}

function updateShortcuts(newShortcuts) {
    shortcuts = newShortcuts || {};

    registerShortcuts();

    console.log("[Shortcuter] Shortcuts updated.");
}

function stopShortcuts() {
    unregisterAllShortcuts();

    console.log("[Shortcuter] Global shortcuts stopped.");
}

function setLaunchErrorHandler(handler) {
    launchErrorHandler = typeof handler === "function" ? handler : () => {};
}

module.exports = {
    startShortcuts,
    updateShortcuts,
    stopShortcuts,
    setLaunchErrorHandler
};