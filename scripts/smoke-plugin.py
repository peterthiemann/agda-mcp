#!/usr/bin/env python3
"""Exercise the exact archived stdio command on a disposable Agda proof."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import queue
import signal
import subprocess
import sys
import tempfile
import threading
import time
import zipfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--server-package", type=Path, help="Explicit unreleased local npm tarball override")
    parser.add_argument("--modern", action="store_true", help="Use metadata-based MCP 2026-07-28 without initialize")
    args = parser.parse_args()
    archive = args.archive.resolve()
    with tempfile.TemporaryDirectory(prefix="agda-plugin-smoke-") as temporary:
        root = Path(temporary)
        with zipfile.ZipFile(archive) as packed:
            if any(Path(n).is_absolute() or ".." in Path(n).parts for n in packed.namelist()):
                raise RuntimeError("Unsafe archive member")
            if packed.testzip() is not None:
                raise RuntimeError("Corrupt archive")
            packed.extractall(root)
        plugin = root / "agda-mcp-plugin"
        manifest = json.loads((plugin / "plugin.json").read_text())
        server = json.loads((plugin / "mcp.json").read_text())["mcpServers"]["agda"]
        proof = root / "proof"
        proof.mkdir()
        module = proof / "Probe.agda"
        original = "module Probe where\n\nidentity : {A : Set} → A → A\nidentity x = ?\n"
        module.write_text(original)
        environment = os.environ.copy()
        # Isolate the published defaults from machine-local overrides.
        environment.pop("AGDA_MCP_OPTIONS", None)
        messages = queue.Queue()
        with (root / "stderr.log").open("w+") as stderr:
            command = [server["command"], *server["args"]]
            if args.server_package:
                environment["npm_config_cache"] = str(root / "npm-cache")
                command = ["npx", "--yes", "--package=" + str(args.server_package.resolve()),
                           "agda-mcp", "--dynamic-workspaces"]
            process = subprocess.Popen(command, cwd=plugin,
                                       env=environment, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                       stderr=stderr, text=True, start_new_session=True)
            def read_messages():
                for line in process.stdout:
                    messages.put(line)
                messages.put(None)
            threading.Thread(target=read_messages, daemon=True).start()
            sequence = 0

            def send(method, params, request_id=None):
                message = {"jsonrpc": "2.0", "method": method, "params": params}
                if request_id is not None:
                    message["id"] = request_id
                process.stdin.write(json.dumps(message) + "\n")
                process.stdin.flush()

            def request(method, params):
                nonlocal sequence
                sequence += 1
                if args.modern:
                    params = {**params, "_meta": {
                        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                        "io.modelcontextprotocol/clientInfo": {"name": "modern-plugin-smoke", "version": "1"},
                        "io.modelcontextprotocol/clientCapabilities": {},
                    }}
                send(method, params, sequence)
                deadline = time.monotonic() + 60
                while True:
                    line = messages.get(timeout=max(0.01, deadline - time.monotonic()))
                    if line is None:
                        raise RuntimeError("Server exited before answering")
                    response = json.loads(line)
                    if response.get("id") == sequence:
                        if "error" in response:
                            raise RuntimeError(response["error"])
                        result = response["result"]
                        if args.modern:
                            assert result["resultType"] == "complete", result
                            assert result["_meta"]["io.modelcontextprotocol/serverInfo"]["version"] == manifest["version"]
                            if method in {"server/discover", "tools/list", "resources/list", "resources/read"}:
                                assert "ttlMs" in result and "cacheScope" in result
                        return result
                    if time.monotonic() >= deadline:
                        raise TimeoutError(method)

            def call(name, arguments):
                result = request("tools/call", {"name": name, "arguments": arguments})
                deadline = time.monotonic() + 60
                while True:
                    if result.get("isError"):
                        raise RuntimeError(result)
                    body = result["structuredContent"]
                    if body.get("status") != "pending":
                        return body["data"]
                    if time.monotonic() >= deadline:
                        raise TimeoutError(name)
                    result = request("tools/call", {"name": "agda_job_await", "arguments": {
                        "job": body["job"]["id"], "waitMs": 1000}})
            try:
                if args.modern:
                    initialized = request("server/discover", {})
                    assert "2026-07-28" in initialized["supportedVersions"]
                else:
                    initialized = request("initialize", {"protocolVersion": "2025-11-25", "capabilities": {},
                                                          "clientInfo": {"name": "agda-plugin-smoke", "version": "1.0.0"}})
                    assert initialized["serverInfo"]["version"] == manifest["version"], initialized
                    send("notifications/initialized", {})
                listed = request("tools/list", {})
                names = {tool["name"] for tool in listed["tools"]}
                expected = {
                    "agda_server_info", "agda_load_module", "agda_typecheck", "agda_retrieve_goals",
                    "agda_retrieve_context", "agda_retrieve_contexts", "agda_retrieve_constraints",
                    "agda_query_metavariables", "agda_infer_type", "agda_normalize_expression",
                    "agda_case_split", "agda_refine", "agda_auto", "agda_job_await", "agda_job_await_any",
                    "agda_job_status", "agda_job_cancel", "agda_job_list"
                }
                assert names == expected, names
                assert initialized["capabilities"]["extensions"]["io.modelcontextprotocol/skills"] == {}
                skills = request("skills/list", {})["skills"]
                assert len(skills) == 1 and skills[0]["uri"] == "skill://agda-proof/SKILL.md"
                assert request("skills/get", {"uri": skills[0]["uri"]})["skill"] == skills[0]
                for resource in skills[0]["resources"]:
                    read = request("resources/read", {"uri": resource["uri"]})["contents"][0]
                    data = read["text"].encode("utf8")
                    assert len(data) == resource["size"]
                    assert "sha256:" + hashlib.sha256(data).hexdigest() == resource["digest"]
                    path = resource["uri"].removeprefix("skill://agda-proof/")
                    assert data == (plugin / "skills" / "agda-proof" / path).read_bytes()
                assert any(r["uri"].endswith("/references/tools.md") for r in skills[0]["resources"])
                info = call("agda_server_info", {})
                assert info["capabilities"]["transformationDefault"] == "preview", info
                assert info["capabilities"]["workspaceSelection"] == "request", info
                loaded = call("agda_load_module", {"modulePath": str(module), "workspaceRoot": str(proof),
                                                   "includeContexts": True})
                assert loaded["checked"] and len(loaded["goals"]) == 1, loaded
                assert loaded["contexts"]["succeeded"] == 1, loaded
                preview = call("agda_refine", {"goal": loaded["goals"][0]["handle"],
                                               "expression": "x", "apply": False})
                assert not preview["applied"] and preview["edits"], preview
                assert module.read_text() == original
                applied = call("agda_refine", {"goal": preview["goals"][0]["handle"],
                                               "expression": "x", "apply": True})
                assert applied["applied"] and applied["checked"] and not applied["goals"], applied
                assert module.read_text() != original and "identity x = x" in module.read_text()
                print(f"Archive {'modern' if args.modern else 'legacy'} smoke OK: npm server {manifest['version']}, 18 tools, verified skill resources, preview unchanged, applied proof checked")
            except Exception:
                stderr.flush()
                stderr.seek(0)
                print(stderr.read(), file=sys.stderr)
                raise
            finally:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()


if __name__ == "__main__":
    main()
