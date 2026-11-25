/*
 * Copyright (c) 2026 Nythxion Studios.
 * All Rights Reserved.
 *
 * This file is part of Nythxion Shortcuts.
 * Licensed under the Nythxion Source-Available Attribution License (NSAAL) 1.0.
 *
 * See the LICENSE file for details.
 */

const {
    app,
    BrowserWindow,
    ipcMain,
    Menu,
    nativeImage,
    screen,
    Tray
} = require("electron");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { spawn } = require("child_process");

const {
    startShortcuts,
    stopShortcuts,
    updateShortcuts,
    setLaunchErrorHandler
} = require("./shortcuts");
const { installLinuxIntegration } = require("./linux-integration");
const { createStateStore } = require("./store");

let mainWindow;
let overlayWindow;
let tray;
let temporaryTray = false;
let isQuitting = false;
let initialSettingsApplied = false;
let stateStore;
const canForwardOverlayMouse = process.platform === "win32" || process.platform === "darwin";

const X11_PLATFORM_SWITCH = "--ozone-platform=x11";
const XWAYLAND_RELAUNCH_ENV = "SHORTCUTER_XWAYLAND_RELAUNCH";

function hasX11PlatformArg(argv) {
    return argv.some((arg, index) => {
        if (arg.startsWith("--ozone-platform=")) {
            return true;
        }
        return arg === "--ozone-platform" && argv[index + 1] === "x11";
    });
}

function needsXWaylandRelaunch() {
    return (
        process.platform === "linux" &&
        Boolean(process.env.WAYLAND_DISPLAY) &&
        Boolean(process.env.DISPLAY) &&
        process.env[XWAYLAND_RELAUNCH_ENV] !== "1" &&
        !hasX11PlatformArg(process.argv)
    );
}

function relaunchUnderXWayland() {
    const userArgs = process.argv
        .slice(app.isPackaged ? 1 : 2)
        .filter(arg => !arg.startsWith("--ozone-platform"));
    const appImage = process.env.APPIMAGE;
    if (appImage && !fs.existsSync(appImage)) {
        return false;
    }
    const executable = appImage || process.execPath;
    if (!appImage && process.execPath.startsWith("/tmp/.mount_")) {
        return false;
    }
    const appArgs = app.isPackaged ? [] : [__dirname];

    try {
        const child = spawn(executable, [...appArgs, ...userArgs, X11_PLATFORM_SWITCH], {
            detached: true,
            stdio: "ignore",
            env: { ...process.env, [XWAYLAND_RELAUNCH_ENV]: "1" }
        });
        child.unref();
        return true;
    } catch (error) {
        console.error("[Shortcuter] Could not restart with the X11 backend:", error);
        return false;
    }
}
let shortcuts = {};
let settings = {
    theme: "purple",
    startWithWindows: false,
    startMinimized: false,
    trayIcon: false,
    soundsMuted: false,
    overlay: {
        enabled: false,
        position: "top-right",
        size: "medium",
        opacity: 88,
        showDescriptions: true
    }
};

function syncOverlayState() {
    if (!overlayWindow || overlayWindow.isDestroyed()) {
        return;
    }

    overlayWindow.webContents.send("overlay-state", {
        shortcuts,
        settings: {
            ...settings.overlay,
            theme: settings.theme,
            soundsMuted: settings.soundsMuted
        }
    });
    positionOverlay();
}

function getOverlayBounds() {
    const workArea = screen.getPrimaryDisplay().workArea;
    const sizeMap = {
        small: { width: 230, rowHeight: settings.overlay.showDescriptions ? 47 : 34 },
        medium: { width: 300, rowHeight: settings.overlay.showDescriptions ? 55 : 39 },
        large: { width: 380, rowHeight: settings.overlay.showDescriptions ? 64 : 44 }
    };
    const size = sizeMap[settings.overlay.size] || sizeMap.medium;
    const items = Object.keys(shortcuts).length;
    const height = Math.min(
        Math.max(86, 54 + Math.max(1, items) * size.rowHeight),
        Math.max(180, Math.floor(workArea.height * 0.65))
    );
    const margin = 20;
    const left = settings.overlay.position.endsWith("left");
    const top = settings.overlay.position.startsWith("top");

    return {
        x: left ? workArea.x + margin : workArea.x + workArea.width - size.width - margin,
        y: top ? workArea.y + margin : workArea.y + workArea.height - height - margin,
        width: size.width,
        height
    };
}

function positionOverlay() {
    if (!overlayWindow || overlayWindow.isDestroyed()) {
        return;
    }

    overlayWindow.setBounds(getOverlayBounds());
    overlayWindow.setOpacity(settings.overlay.opacity / 100);
}

function createOverlayWindow() {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
        syncOverlayState();
        return;
    }

    overlayWindow = new BrowserWindow({
        ...getOverlayBounds(),
        show: false,
        frame: false,
        transparent: true,
        backgroundColor: "#00000000",
        hasShadow: false,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        focusable: false,
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    overlayWindow.setMenu(null);
    overlayWindow.setAlwaysOnTop(true, "screen-saver");
    overlayWindow.setIgnoreMouseEvents(canForwardOverlayMouse, { forward: canForwardOverlayMouse });
    overlayWindow.loadFile(path.join(__dirname, "renderer", "overlay.html"));
    overlayWindow.webContents.once("did-finish-load", () => {
        if (settings.overlay.enabled && overlayWindow && !overlayWindow.isDestroyed()) {
            overlayWindow.setOpacity(settings.overlay.opacity / 100);
            overlayWindow.showInactive();
            syncOverlayState();
        }
    });
    overlayWindow.on("closed", () => {
        overlayWindow = null;
    });
}

function setOverlayEnabled(enabled) {
    settings.overlay.enabled = enabled;
    if (enabled) {
        createOverlayWindow();
        if (overlayWindow && !overlayWindow.isDestroyed()) {
            positionOverlay();
            if (overlayWindow.webContents.isLoading()) {
                return;
            }
            overlayWindow.showInactive();
            syncOverlayState();
        }
    } else if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.hide();
    }
}

function showMainWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) {
        createWindow();
    }

    if (mainWindow.isMinimized()) {
        mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.focus();

    if (temporaryTray && !settings.trayIcon && tray) {
        tray.destroy();
        tray = null;
        temporaryTray = false;
    }
}

function showLaunchFailure(error) {
    if (!mainWindow || mainWindow.isDestroyed()) {
        createWindow();
    }

    const sendLaunchError = () => {
        if (!mainWindow || mainWindow.isDestroyed()) {
            return;
        }
        mainWindow.webContents.send("launch-error", error);
    };
    if (mainWindow.webContents.isLoading()) {
        mainWindow.webContents.once("did-finish-load", sendLaunchError);
    } else {
        sendLaunchError();
    }
    showMainWindow();
}

function createTray() {
    const iconPath = path.join(
        __dirname,
        "renderer",
        "icons",
        process.platform === "win32" ? "Logo.ico" : "Logo.png"
    );
    const icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) {
        console.error(`[Shortcuter] Could not load tray icon at ${iconPath}.`);
        return false;
    }
    tray = new Tray(icon);
    tray.setToolTip("Nythxion Shortcuts");
    tray.on("click", showMainWindow);
    tray.on("double-click", showMainWindow);
    updateTrayMenu();
    return true;
}

function updateTrayMenu() {
    if (!tray) {
        return;
    }

    tray.setContextMenu(Menu.buildFromTemplate([
        { label: "Open Nythxion Shortcuts", click: showMainWindow },
        {
            label: "Desktop overlay",
            type: "checkbox",
            checked: settings.overlay.enabled,
            click: item => {
                setOverlayEnabled(item.checked);
                settings.overlay.enabled = item.checked;
                persistSettingsState();
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send("settings-updated", settings);
                }
            }
        },
        { type: "separator" },
        {
            label: "Quit",
            click: () => {
                isQuitting = true;
                app.quit();
            }
        }
    ]));
}

function updateTray() {
    if (!settings.trayIcon) {
        const windowHidden = !mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible();
        if (tray && windowHidden) {
            temporaryTray = true;
            return;
        }
        if (tray) {
            tray.destroy();
            tray = null;
        }
        temporaryTray = false;
        return;
    }

    if (!tray) {
        createTray();
    }
    temporaryTray = false;
    updateTrayMenu();
}

function getAutoStartDesktopPath() {
    const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
    return path.join(configHome, "autostart", "shortcuts.desktop");
}

function getAutoStartExec() {
    const gpuFlag = process.platform === "linux" ? " --disable-gpu" : "";
    const minimizedFlag = settings.startMinimized ? " --start-minimized" : "";
    if (app.isPackaged) {
        const executable = process.platform === "linux" && process.env.APPIMAGE
            ? process.env.APPIMAGE
            : process.execPath;
        return `"${executable}"${gpuFlag}${minimizedFlag} %U`;
    }
    return `"${process.execPath}" "${__dirname}"${gpuFlag}${minimizedFlag}`;
}

function writeAutoStartDesktop(enabled) {
    const desktopPath = getAutoStartDesktopPath();
    const dir = path.dirname(desktopPath);

    try {
        fs.mkdirSync(dir, { recursive: true });
    } catch (error) {
        console.error("[Shortcuter] Could not create autostart directory:", error);
        return;
    }

    if (!enabled) {
        try {
            fs.unlinkSync(desktopPath);
        } catch (error) {
            if (error.code !== "ENOENT") {
                console.error("[Shortcuter] Could not remove autostart desktop file:", error);
            }
        }
        return;
    }

    const entry = [
        "[Desktop Entry]",
        "Type=Application",
        "Name=Nythxion Shortcuts",
        `Exec=${getAutoStartExec()}`,
        "Categories=Utility;",
        "Hidden=false",
        "X-GNOME-Autostart-enabled=true",
        "",
    ].join("\n");

    try {
        fs.writeFileSync(desktopPath, entry);
    } catch (error) {
        console.error("[Shortcuter] Could not write autostart desktop file:", error);
    }
}

function updateAutoStart() {
    if (process.platform === "win32") {
        app.setLoginItemSettings({
            openAtLogin: settings.startWithWindows,
            args: settings.startMinimized ? ["--start-minimized"] : []
        });
        return;
    }

    if (process.platform === "linux") {
        writeAutoStartDesktop(settings.startWithWindows);
    }
}

function hideMainWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) {
        return;
    }

    if (!tray) {
        createTray();
        temporaryTray = !settings.trayIcon;
    }
    if (!tray) {
        console.error("[Shortcuter] Could not hide the window because no tray icon is available.");
        return;
    }
    mainWindow.hide();
}

function getStateStore() {
    if (!stateStore) {
        stateStore = createStateStore(app.getPath("userData"));
    }
    return stateStore;
}

function loadSavedState() {
    const saved = getStateStore().load();
    if (!saved) {
        return;
    }
    if (saved.shortcuts && typeof saved.shortcuts === "object" && !Array.isArray(saved.shortcuts)) {
        shortcuts = saved.shortcuts;
    }
    if (saved.settings) {
        try {
            settings = normalizeSettings(saved.settings);
        } catch (error) {
            console.error("[Shortcuter] Ignoring invalid saved settings:", error);
        }
    }
}

function persistSettingsState() {
    getStateStore().save({ settings });
}

function normalizeSettings(nextSettings) {
    if (!nextSettings || typeof nextSettings !== "object" || Array.isArray(nextSettings)) {
        throw new TypeError("Settings must be an object.");
    }

    const overlay = nextSettings.overlay || {};
    const positions = ["top-left", "top-right", "bottom-left", "bottom-right"];
    const sizes = ["small", "medium", "large"];
    const opacity = Number(overlay.opacity);
    return {
        theme: ["light", "purple", "dark"].includes(nextSettings.theme)
            ? nextSettings.theme
            : "purple",
        startWithWindows: nextSettings.startWithWindows === true,
        startMinimized: nextSettings.startMinimized === true,
        trayIcon: nextSettings.trayIcon === true,
        soundsMuted: nextSettings.soundsMuted === true,
        overlay: {
            enabled: overlay.enabled === true,
            position: positions.includes(overlay.position) ? overlay.position : "top-right",
            size: sizes.includes(overlay.size) ? overlay.size : "medium",
            opacity: Number.isFinite(opacity) ? Math.max(20, Math.min(100, opacity)) : 88,
            showDescriptions: overlay.showDescriptions !== false
        }
    };
}

function applySettings(nextSettings) {
    settings = normalizeSettings(nextSettings);

    updateAutoStart();
    updateTray();
    setOverlayEnabled(settings.overlay.enabled);
    if (overlayWindow && !overlayWindow.isDestroyed()) {
        positionOverlay();
        syncOverlayState();
    }

    if (!initialSettingsApplied) {
        initialSettingsApplied = true;
        if (app.commandLine.hasSwitch("start-minimized") && mainWindow && !mainWindow.isDestroyed()) {
            if (settings.trayIcon) {
                mainWindow.hide();
            } else {
                mainWindow.show();
                mainWindow.minimize();
            }
        }
    }
}

ipcMain.handle("save-shortcuts", (_, nextShortcuts) => {
    if (!nextShortcuts || typeof nextShortcuts !== "object" || Array.isArray(nextShortcuts)) {
        throw new TypeError("Shortcut settings must be an object.");
    }

    shortcuts = nextShortcuts;
    getStateStore().save({ shortcuts });
    updateShortcuts(shortcuts);
    syncOverlayState();
    updateTrayMenu();
    return true;
});

ipcMain.handle("apply-settings", (_, nextSettings) => {
    applySettings(nextSettings);
    getStateStore().save({ settings });
    return true;
});

ipcMain.handle("get-state", () => {
    const saved = getStateStore().load();
    if (!saved) {
        return null;
    }
    const isObject = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);
    return {
        shortcuts: isObject(saved.shortcuts) ? saved.shortcuts : null,
        settings: isObject(saved.settings) ? saved.settings : null
    };
});

ipcMain.on("overlay-interactive", (event, interactive) => {
    if (!overlayWindow || overlayWindow.isDestroyed() || event.sender !== overlayWindow.webContents) {
        return;
    }

    if (!canForwardOverlayMouse) {
        overlayWindow.setIgnoreMouseEvents(false);
        return;
    }

    overlayWindow.setIgnoreMouseEvents(!interactive, { forward: true });
});

ipcMain.on("overlay-control", (event, action) => {
    if (!overlayWindow || overlayWindow.isDestroyed() || event.sender !== overlayWindow.webContents) {
        return;
    }

    switch (action) {
        case "quit":
            isQuitting = true;
            app.quit();
            break;
        case "hide":
            hideMainWindow();
            break;
        case "disable-overlay":
            settings.overlay.enabled = false;
            persistSettingsState();
            if (overlayWindow && !overlayWindow.isDestroyed()) {
                overlayWindow.hide();
            }
            if (tray) {
                updateTrayMenu();
            }
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send("settings-updated", settings);
            }
            break;
        default:
            console.warn(`[Shortcuter] Ignored unknown overlay control action: ${action}`);
    }
});

function getPythonCommands() {
    const commands = [];

    if (process.env.PYTHON) {
        commands.push({ command: process.env.PYTHON, args: [] });
    }

    if (process.platform === "win32") {
        commands.push(
            { command: "py", args: ["-3"] },
            { command: "python", args: [] },
            { command: "python3", args: [] }
        );
    } else {
        commands.push({ command: "python3", args: [] }, { command: "python", args: [] });
    }

    const seen = new Set();
    return commands.filter(candidate => {
        const key = candidate.command.toLowerCase();
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
}

function runFinderProcess(candidate, finderPath, query) {
    return new Promise((resolve, reject) => {
        console.info(
            `[Shortcuter] Starting app finder: ${candidate.command} ${candidate.args.join(" ")} "${finderPath}" "${query}"`
        );

        const child = spawn(candidate.command, [
            ...candidate.args,
            finderPath,
            query
        ], {
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"]
        });

        let stdout = "";
        let stderr = "";
        let settled = false;
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", chunk => {
            stdout += chunk;
            if (stdout.length > 2 * 1024 * 1024 && !settled) {
                settled = true;
                child.kill();
                reject(new Error("App search returned too much data."));
            }
        });
        child.stderr.on("data", chunk => {
            stderr += chunk;
            if (stderr.length > 64 * 1024) {
                stderr = stderr.slice(-64 * 1024);
            }
        });
        child.once("error", error => {
            if (settled) return;
            settled = true;
            console.error(`[Shortcuter] Could not start Python command ${candidate.command}:`, error);
            reject(error);
        });
        child.once("close", code => {
            if (settled) return;
            settled = true;
            if (stderr.trim()) {
                console.info(`[Shortcuter] App finder diagnostics:\n${stderr.trim()}`);
            }
            if (code !== 0) {
                const error = new Error(
                    `Python app finder exited with code ${code}: ${stderr.trim() || "No details provided."}`
                );
                error.code = "PYTHON_EXIT";
                reject(error);
                return;
            }
            try {
                const results = JSON.parse(stdout.replace(/^\uFEFF/, "").trim());
                if (!Array.isArray(results) || results.some(result =>
                    !result || typeof result.name !== "string" || typeof result.path !== "string"
                )) {
                    throw new Error("App finder returned an invalid result.");
                }
                console.info(`[Shortcuter] Electron received ${results.length} app result(s).`);
                if (results.length === 0) {
                    console.warn("[Shortcuter] Python app finder returned no matching applications.");
                }
                resolve(results);
            } catch (error) {
                console.error(
                    `[Shortcuter] Failed to read Python app finder output. stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`,
                    error
                );
                reject(new Error(`Could not parse app search results: ${error.message}`));
            }
        });
    });
}

async function runAppFinder(query) {
    const finderPath = app.isPackaged
        ? path.join(process.resourcesPath, "app_finder.py")
        : path.join(__dirname, "app_finder.py");
    const commands = getPythonCommands();
    let lastError;
    console.info(`[Shortcuter] Searching installed apps for "${query}".`);
    for (const candidate of commands) {
        try {
            const results = await runFinderProcess(candidate, finderPath, query);
            console.info(`[Shortcuter] App search completed with ${results.length} result(s).`);
            return results;
        } catch (error) {
            lastError = error;
            if (error.code === "ENOENT" || error.code === "PYTHON_EXIT") continue;
            throw error;
        }
    }
    const error = new Error(
        `Could not start Python. Tried: ${commands.map(candidate => candidate.command).join(", ")}. ${lastError ? lastError.message : ""}`
    );
    console.error(`[Shortcuter] ${error.message}`);
    throw error;
}

ipcMain.handle("find-apps", (_, query) => {
    if (process.platform !== "win32" && process.platform !== "linux") {
        return [];
    }

    if (typeof query !== "string") {
        throw new TypeError("App search query must be text.");
    }
    const normalizedQuery = query.trim();
    if (!normalizedQuery) return [];
    console.info(`[Shortcuter] Received app search request: "${normalizedQuery}".`);
    return runAppFinder(normalizedQuery);
});

const FRAME_DETECTION_TOP = 48;
const FRAME_DETECTION_SIDE = 8;

function pointerIsOnWindowFrame(window) {
    try {
        const bounds = window.getBounds();
        const point = screen.getCursorScreenPoint();
        return (
            point.x >= bounds.x - FRAME_DETECTION_SIDE &&
            point.x <= bounds.x + bounds.width + FRAME_DETECTION_SIDE &&
            point.y >= bounds.y - FRAME_DETECTION_TOP &&
            point.y <= bounds.y + FRAME_DETECTION_TOP
        );
    } catch (error) {
        return true;
    }
}

function createWindow() {
    if (mainWindow && !mainWindow.isDestroyed()) {
        showMainWindow();
        return;
    }

    mainWindow = new BrowserWindow({
        width: 1040,
        height: 720,
        minWidth: 720,
        minHeight: 560,
        show: !app.commandLine.hasSwitch("start-minimized"),
        backgroundColor: "#070912",
        icon: path.join(
            __dirname,
            "renderer",
            "icons",
            process.platform === "win32" ? "Logo.ico" : "Logo.png"
        ),
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    mainWindow.setMenu(null);
    mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
    mainWindow.on("close", event => {
        if (isQuitting) {
            return;
        }

        if (pointerIsOnWindowFrame(mainWindow)) {
            event.preventDefault();
            hideMainWindow();
            return;
        }

        isQuitting = true;
        setImmediate(() => app.quit());
    });
    mainWindow.on("closed", () => {
        mainWindow = null;
    });
}

const relaunchingUnderXWayland = needsXWaylandRelaunch() && relaunchUnderXWayland();
if (relaunchingUnderXWayland) {
    process.exit(0);
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
    app.exit(0);
}

if (process.platform === "linux") {
    app.commandLine.appendSwitch("disable-gpu");
    app.disableHardwareAcceleration();
}

if (hasSingleInstanceLock) {
    app.on("second-instance", () => {
        app.whenReady().then(showMainWindow).catch(error => {
            console.error("[Shortcuter] Could not show the running window:", error);
        });
    });

    app.whenReady().then(() => {
        if (process.platform === "win32") {
            app.setAppUserModelId("com.nythxion.shortcuts");
        }
        if (process.platform === "linux" && app.isPackaged && process.env.APPIMAGE) {
            try {
                installLinuxIntegration({
                    appImagePath: process.env.APPIMAGE,
                    iconSource: path.join(__dirname, "renderer", "icons", "Logo.png")
                });
            } catch (error) {
                console.error("[Shortcuter] Could not install the Linux desktop entry:", error);
            }
        }
        Menu.setApplicationMenu(null);
        setLaunchErrorHandler(showLaunchFailure);
        loadSavedState();
        createWindow();
        startShortcuts(shortcuts);
        screen.on("display-metrics-changed", () => positionOverlay());
    }).catch(error => {
        console.error("[Shortcuter] Failed to start:", error);
        app.quit();
    });
}

app.on("before-quit", () => {
    isQuitting = true;
    stopShortcuts();
    if (tray) {
        tray.destroy();
        tray = null;
    }
});

app.on("activate", () => {
    if (!mainWindow) {
        createWindow();
    } else {
        showMainWindow();
    }
});

app.on("window-all-closed", () => {
});
