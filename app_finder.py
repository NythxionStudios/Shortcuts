# Copyright (c) 2026 Nythxion Studios.
# All Rights Reserved.
#
# This file is part of Nythxion Shortcuts.
# Licensed under the Nythxion Source-Available Attribution License (NSAAL) 1.0.
#
# See the LICENSE file for details.

import json
import os
import re
import subprocess
import sys

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(encoding="utf-8", errors="replace")
        except (OSError, ValueError):
            pass


MAX_WALK_DEPTH = 4
MAX_RESULTS = 30


def log(message):
    print(f"[app_finder] {message}", file=sys.stderr, flush=True)


def normalize(value):
    return re.sub(r"[^a-z0-9]", "", value.casefold())


def matches(query, value):
    query_key = normalize(query)
    value_key = normalize(value)

    if not query_key or not value_key:
        return False
    if query_key in value_key:
        return True
    if query_key == "vscode" and (
        "visualstudiocode" in value_key or value_key == "code"
    ):
        return True

    query_words = re.findall(r"[a-z0-9]+", query.casefold())
    value_words = re.findall(r"[a-z0-9]+", value.casefold())
    return bool(query_words) and all(
        any(word in candidate for candidate in value_words)
        for word in query_words
    )


def windows_search_roots():
    app_data = os.environ.get("APPDATA")
    program_data = os.environ.get("ProgramData")
    local_app_data = os.environ.get("LOCALAPPDATA")
    program_files = os.environ.get("ProgramFiles")
    program_files_x86 = os.environ.get("ProgramFiles(x86)")

    roots = [
        os.path.join(app_data, "Microsoft", "Windows", "Start Menu", "Programs") if app_data else None,
        os.path.join(program_data, "Microsoft", "Windows", "Start Menu", "Programs") if program_data else None,
        os.path.join(local_app_data, "Discord") if local_app_data else None,
        os.path.join(local_app_data, "Programs") if local_app_data else None,
        os.path.join(local_app_data, "Apps") if local_app_data else None,
        os.path.join(local_app_data, "Microsoft", "WindowsApps") if local_app_data else None,
        program_files,
        program_files_x86,
    ]
    available_roots = list(dict.fromkeys(
        os.path.abspath(root)
        for root in roots
        if root and os.path.isdir(root)
    ))
    for root in available_roots:
        log(f"Searching location: {root}")
    return available_roots


def walk_error(error):
    log(f"Could not read directory {error.filename}: {error}")


def find_shortcuts(query, roots):
    shortcuts = []
    for root in roots:
        for current, directories, files in os.walk(root, onerror=walk_error):
            depth = os.path.relpath(current, root).count(os.sep)
            if depth >= MAX_WALK_DEPTH:
                directories[:] = []

            for filename in files:
                if filename.casefold().endswith(".lnk") and matches(
                    query, os.path.splitext(filename)[0]
                ):
                    shortcuts.append(os.path.join(current, filename))

    log(f"Found {len(shortcuts)} matching Start Menu shortcut(s).")
    return shortcuts


def resolve_shortcuts(shortcut_paths):
    if not shortcut_paths:
        return []

    powershell = "powershell.exe"
    script = r"""
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$inputJson = [Console]::In.ReadToEnd()
$paths = ConvertFrom-Json -InputObject $inputJson
$shell = New-Object -ComObject WScript.Shell
$results = foreach ($shortcutPath in $paths) {
    try {
        $shortcut = $shell.CreateShortcut([string]$shortcutPath)
        $target = [Environment]::ExpandEnvironmentVariables($shortcut.TargetPath)
        if ([IO.Path]::IsPathRooted($target) -and (Test-Path -LiteralPath $target -PathType Leaf)) {
            [pscustomobject]@{ shortcut = [string]$shortcutPath; target = $target }
        } else {
            [Console]::Error.WriteLine("Shortcut target not found: {0} -> {1}" -f $shortcutPath, $target)
        }
    } catch {
        [Console]::Error.WriteLine("Failed to resolve shortcut {0}: {1}" -f $shortcutPath, $_.Exception.Message)
        continue
    }
}
ConvertTo-Json -InputObject @($results) -Compress
"""

    commands = ["powershell.exe", "pwsh.exe"]
    completed = None
    for command in commands:
        try:
            log(f"Resolving {len(shortcut_paths)} shortcut(s) with {command}.")
            completed = subprocess.run(
                [command, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
                input=json.dumps(shortcut_paths, ensure_ascii=True),
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=20,
                check=False,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            break
        except FileNotFoundError:
            log(f"{command} is not installed.")
        except subprocess.TimeoutExpired:
            log(f"{command} timed out while resolving Start Menu shortcuts.")
            return []
        except OSError as error:
            log(f"Could not run {command}: {error}")
            return []

    if completed is None:
        log("No PowerShell executable is available to resolve .lnk files.")
        return []

    if completed.stderr.strip():
        log(f"PowerShell: {completed.stderr.strip()}")
    if completed.returncode != 0:
        log(f"PowerShell exited with code {completed.returncode}.")
        return []
    if not completed.stdout.strip():
        log("PowerShell returned no shortcut resolution data.")
        return []

    try:
        results = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        log(f"Could not parse PowerShell shortcut results: {error}")
        return []

    if isinstance(results, dict):
        results = [results]
    resolved = results if isinstance(results, list) else []
    log(f"Resolved {len(resolved)} Start Menu shortcut(s) to executable paths.")
    return resolved


def executable_candidates(query, roots):
    candidates = []
    excluded_name_parts = {
        "update",
        "uninstall",
        "unins000",
        "setup",
        "installer",
        "crashhandler",
        "crashreporter",
    }

    for root in roots:
        for current, directories, files in os.walk(root, onerror=walk_error):
            depth = os.path.relpath(current, root).count(os.sep)
            if depth >= MAX_WALK_DEPTH:
                directories[:] = []

            for filename in files:
                if not filename.casefold().endswith(".exe"):
                    continue

                executable = os.path.join(current, filename)
                executable_name = os.path.splitext(filename)[0]
                normalized_name = normalize(executable_name)
                if any(part in normalized_name for part in excluded_name_parts):
                    log(f"Skipping installer/maintenance executable: {executable}")
                    continue
                if "helper" in normalized_name:
                    continue
                if not matches(query, executable_name):
                    continue

                candidates.append({
                    "name": executable_name,
                    "path": executable,
                })

    return candidates


def sort_and_limit(results, query):
    query_key = normalize(query)
    results.sort(key=lambda item: (
        normalize(item["name"]) != query_key,
        not normalize(item["name"]).startswith(query_key),
        item["name"].casefold(),
    ))
    limited_results = results[:MAX_RESULTS]
    log(f"Returning {len(limited_results)} application result(s) for {query!r}.")
    return limited_results


def windows_search_apps(query):
    roots = windows_search_roots()
    shortcut_paths = find_shortcuts(query, roots)
    log(f"Searching installed executables for {query!r}.")
    results = []
    seen_paths = set()
    seen_names = set()

    for item in resolve_shortcuts(shortcut_paths):
        target = item.get("target")
        shortcut = item.get("shortcut")
        if not isinstance(target, str) or not target.casefold().endswith(".exe"):
            continue
        if not isinstance(shortcut, str):
            continue

        key = os.path.normcase(os.path.abspath(target))
        name_key = normalize(os.path.splitext(os.path.basename(shortcut))[0])
        if key not in seen_paths and name_key not in seen_names:
            seen_paths.add(key)
            seen_names.add(name_key)
            results.append({
                "name": os.path.splitext(os.path.basename(shortcut))[0],
                "path": target,
            })

    for item in executable_candidates(query, roots):
        key = os.path.normcase(os.path.abspath(item["path"]))
        name_key = normalize(item["name"])
        if key not in seen_paths and name_key not in seen_names:
            seen_paths.add(key)
            seen_names.add(name_key)
            results.append(item)

    return sort_and_limit(results, query)


def linux_desktop_dirs():
    data_home = os.environ.get("XDG_DATA_HOME") or os.path.expanduser("~/.local/share")
    data_dirs = os.environ.get("XDG_DATA_DIRS") or "/usr/local/share:/usr/share"
    candidates = [
        os.path.join(data_home, "applications"),
        os.path.join(data_home, "flatpak", "exports", "share", "applications"),
        "/var/lib/flatpak/exports/share/applications",
        "/var/lib/snapd/desktop/applications",
    ]
    for data_dir in data_dirs.split(":"):
        data_dir = data_dir.strip()
        if data_dir:
            candidates.append(os.path.join(data_dir, "applications"))

    available_dirs = list(dict.fromkeys(
        os.path.abspath(directory)
        for directory in candidates
        if os.path.isdir(directory)
    ))
    for directory in available_dirs:
        log(f"Searching application entries: {directory}")
    return available_dirs


DESKTOP_ESCAPES = {"s": " ", "n": "\n", "t": "\t", "r": "\r", "\\": "\\"}


def unescape_desktop_value(value):
    return re.sub(
        r"\\(.)",
        lambda match: DESKTOP_ESCAPES.get(match.group(1), match.group(1)),
        value,
    )


def read_desktop_entry(entry_path):
    values = {}
    in_desktop_group = False
    try:
        with open(entry_path, "r", encoding="utf-8", errors="replace") as handle:
            for raw_line in handle:
                line = raw_line.strip()
                if not line or line.startswith("#"):
                    continue
                if line.startswith("[") and line.endswith("]"):
                    in_desktop_group = line == "[Desktop Entry]"
                    continue
                if not in_desktop_group or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                values.setdefault(key.strip(), value.strip())
    except OSError as error:
        log(f"Could not read desktop entry {entry_path}: {error}")
        return None

    if values.get("Type") != "Application":
        return None
    if values.get("NoDisplay", "").casefold() == "true":
        return None
    if values.get("Hidden", "").casefold() == "true":
        return None

    name = unescape_desktop_value(values.get("Name", "")).strip()
    if not name or not values.get("Exec"):
        return None

    return {"name": name}


def linux_search_apps(query):
    results = []
    seen_names = set()
    seen_paths = set()

    for directory in linux_desktop_dirs():
        try:
            filenames = sorted(os.listdir(directory))
        except OSError as error:
            log(f"Could not list {directory}: {error}")
            continue

        for filename in filenames:
            if not filename.casefold().endswith(".desktop"):
                continue

            entry_path = os.path.join(directory, filename)
            entry_id = os.path.splitext(filename)[0]

            entry = read_desktop_entry(entry_path)
            if not entry:
                continue

            name = entry["name"]
            if not matches(query, name) and not matches(query, entry_id):
                continue

            name_key = normalize(name)
            path_key = os.path.abspath(entry_path)
            if name_key in seen_names or path_key in seen_paths:
                continue

            seen_names.add(name_key)
            seen_paths.add(path_key)
            results.append({"name": name, "path": path_key})

    log(f"Found {len(results)} matching desktop entry/entries.")
    return sort_and_limit(results, query)


def search_apps(query):
    if sys.platform == "win32":
        return windows_search_apps(query)
    if sys.platform.startswith("linux"):
        return linux_search_apps(query)

    log(f"App search is unavailable on platform {sys.platform}.")
    return []


def main():
    query = " ".join(sys.argv[1:]).strip()
    if not query:
        log("No application name was provided.")
        print("[]")
        return

    log(f"Starting search for {query!r}.")
    print(json.dumps(search_apps(query), ensure_ascii=True))


if __name__ == "__main__":
    main()
