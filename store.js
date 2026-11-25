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
const path = require("path");

const STATE_FILE = "state.json";

function createStateStore(directory) {
    const filePath = path.join(directory, STATE_FILE);
    let state = null;
    let loaded = false;

    function readFile() {
        try {
            const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                return null;
            }
            return parsed;
        } catch (error) {
            if (error.code !== "ENOENT") {
                console.error("[Shortcuter] Could not read the saved state:", error);
            }
            return null;
        }
    }

    function load() {
        if (!loaded) {
            state = readFile();
            loaded = true;
        }
        return state;
    }

    function save(patch) {
        const next = {
            ...(load() || {}),
            ...patch,
            updatedAt: new Date().toISOString()
        };

        const temporaryPath = `${filePath}.tmp`;
        try {
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(temporaryPath, JSON.stringify(next, null, 2), "utf8");
            fs.renameSync(temporaryPath, filePath);
            state = next;
            loaded = true;
        } catch (error) {
            console.error("[Shortcuter] Could not store the app state:", error);
        }

        return next;
    }

    return { load, save, filePath };
}

module.exports = { createStateStore, STATE_FILE };
