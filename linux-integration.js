/*
 * Copyright (c) 2026 Nythxion Studios.
 * All Rights Reserved.
 *
 * This file is part of Nythxion Shortcuts.
 * Licensed under the Nythxion Source-Available Attribution License (NSAAL) 1.0.
 *
 * See the LICENSE file for details.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const APP_NAME = "Nythxion Shortcuts";
const APP_SLUG = "nythxion-shortcuts";
const ICON_SIZE = "512x512";

function getDataHome() {
    return process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
}

function getDesktopDirectory() {
    try {
        const directory = execFileSync("xdg-user-dir", ["DESKTOP"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"]
        }).trim();
        if (directory && path.resolve(directory) !== path.resolve(os.homedir())) {
            return directory;
        }
    } catch (error) {
       
    }

    const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
    try {
        const userDirs = fs.readFileSync(path.join(configHome, "user-dirs.dirs"), "utf8");
        const match = userDirs.match(/^XDG_DESKTOP_DIR="(.+)"$/m);
        if (match) {
            return match[1].replace(/^\$HOME/, os.homedir());
        }
    } catch (error) {
    }

    return path.join(os.homedir(), "Desktop");
}

function escapeExecArgument(value) {
    return `"${value.replace(/([\\"$`])/g, "\\$1")}"`;
}

function buildDesktopEntry(appImagePath, iconPath) {
    return [
        "[Desktop Entry]",
        "Type=Application",
        "Version=1.0",
        `Name=${APP_NAME}`,
        "Comment=Press. Open. Done.",
        `Exec=${escapeExecArgument(appImagePath)} %U`,
        `Icon=${iconPath}`,
        "Terminal=false",
        "Categories=Utility;",
        `StartupWMClass=${APP_SLUG}`,
        ""
    ].join("\n");
}

function writeIfChanged(filePath, content, mode) {
    let current = null;
    try {
        current = fs.readFileSync(filePath, "utf8");
    } catch (error) {
        if (error.code !== "ENOENT") {
            throw error;
        }
    }

    if (current === content) {
        if (mode) {
            fs.chmodSync(filePath, mode);
        }
        return false;
    }

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
    if (mode) {
        fs.chmodSync(filePath, mode);
    }
    return true;
}

function writeIconIfChanged(source, target) {
    const icon = fs.readFileSync(source);
    try {
        if (fs.readFileSync(target).equals(icon)) {
            return false;
        }
    } catch (error) {
    }

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, icon);
    return true;
}

function runQuietly(command, args) {
    try {
        execFileSync(command, args, { stdio: "ignore" });
    } catch (error) {
    }
}

function installLinuxIntegration({ appImagePath, iconSource }) {
    if (!appImagePath) {
        return false;
    }

    const applicationsDir = path.join(getDataHome(), "applications");
    const iconPath = path.join(getDataHome(), "icons", "hicolor", ICON_SIZE, "apps", `${APP_SLUG}.png`);
    const menuEntry = path.join(applicationsDir, `${APP_SLUG}.desktop`);
    const content = buildDesktopEntry(appImagePath, iconPath);

    writeIconIfChanged(iconSource, iconPath);
    writeIfChanged(menuEntry, content, 0o755);

    try {
        const shortcut = path.join(getDesktopDirectory(), `${APP_SLUG}.desktop`);
        if (writeIfChanged(shortcut, content, 0o755)) {
            runQuietly("gio", ["set", shortcut, "metadata::trusted", "true"]);
        }
    } catch (error) {
    }

    runQuietly("update-desktop-database", [applicationsDir]);
    runQuietly("gtk-update-icon-cache", ["-f", "-t", path.join(getDataHome(), "icons", "hicolor")]);
    return true;
}

module.exports = {
    installLinuxIntegration
};
