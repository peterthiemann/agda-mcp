# Install and update the Agda MCP plugin

## Prerequisites

Use a local Agent Plugins-compatible host with stdio MCP and Agent Skills support.
Install Node.js 22+ (including `npx`) and Agda separately; Agda 2.8.0 is the
verified interaction adapter. Agda libraries remain managed by your Agda setup.
After publication, the plugin downloads `agda-mcp@0.5.0` from npm on first use;
it does not bundle
Node, Agda, the standard library, or the server's npm dependency tree. Internet
access and npm registry access are needed to populate the npm cache.

Version 0.5.0 is an unreleased package prepared in this branch. Publish the
server to npm before distributing the pinned plugin for normal installation.
Until then, use the local tarball checks below.

The exact launch command is:

```sh
npx --yes agda-mcp@0.5.0 --dynamic-workspaces
```

The npm version is pinned, rather than following `latest`; npm resolves its
transitive dependencies. This is not a fully locked offline distribution.
The server defaults to previews; the skill prefers explicit `apply:true` for
incremental proof development and `apply:false` for requested previews.

## `unpack && install`

Verify the release checksum, then extract the archive into a stable location:

```sh
shasum -a 256 -c agda-mcp-plugin-0.5.0.zip.sha256
unzip agda-mcp-plugin-0.5.0.zip -d ./plugins
```

The resulting `./plugins/agda-mcp-plugin` contains root `plugin.json`,
`mcp.json`, `skills/`, this document, and the license. Install that folder using
your host's local-plugin mechanism. Portable hosts discover skills from
`skills/` and stdio servers from `mcp.json`; no checkout paths are embedded.

For Codex local marketplace installation, place the extracted folder at
`<project>/plugins/agda-mcp-plugin`. Add the following entry to the project's
`.agents/plugins/marketplace.json` (merge it with an existing catalog rather
than replacing other entries):

```json
{
  "name": "agda-local",
  "plugins": [
    {
      "name": "agda-mcp",
      "source": { "source": "local", "path": "./plugins/agda-mcp-plugin" },
      "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
      "category": "Productivity"
    }
  ]
}
```

Paths resolve from the project root. Restart the desktop app, choose the
`agda-local` marketplace in the Plugins Directory, and install/enable `agda-mcp`.
Use a fresh local chat for the acceptance checks below. A duplicate existing
Agda MCP connection should be disabled to avoid selecting a different server.
The package preparation commands do not modify personal host configuration.

This npm-launch package is intended for manual/local distribution. Public
OpenAI desktop-only submission has separate partner eligibility and packaging
requirements, including bundling the server and its dependencies; this archive
has not been submitted or certified for that channel.

## `configure`

`--dynamic-workspaces` lets each load select an absolute workspace root and
module file. It permits targeting any path accessible to the server process;
use it with a trusted local client. For a fixed allowlist, remove that flag in
the installed `mcp.json` and set the server entry's `env.AGDA_MCP_OPTIONS` to a
JSON string such as:

```json
{"workspaceRoots":["/absolute/path/to/project"]}
```

If Agda is not on the host process's PATH, include `agdaExecutable` in that same
JSON object. For example, the entire entry's environment field could be:

```json
{
  "AGDA_MCP_OPTIONS": "{\"workspaceRoots\":[\"/absolute/path/to/project\"],\"agdaExecutable\":\"/absolute/path/to/agda\"}"
}
```

Do not ship these machine-specific paths in a release. Keep a copy of local
overrides outside the installed cache; reapply them after an update and restart
the MCP connection. Project `.agda-lib` files supply normal project settings.

## `smoke`: acceptance checks

Ask the host to use `$agda-proof` on a disposable Agda module. Verify that
`agda_server_info` reports the expected Agda version, adapter, and policies; load with
absolute module/root paths and inspect a hole's context. Request a preview and
confirm disk stays unchanged. Then request a refinement: it should use
`apply:true`, return fresh goals, and report checked/applied separately.
Also try an untagged Agda request to check automatic skill selection in your
host. A Lean proof or TypeScript server-development request should not activate
this skill. Tool transport smoke testing alone does not measure host routing.

## `update && restart`

A plugin update is explicit; an installed pin does not follow new npm versions.
Obtain a new archive and checksum, verify and unpack into a new versioned
folder, then update the marketplace's source path (or replace the old local
source folder after backing up local overrides). Refresh/reinstall the plugin
through the host, restart the desktop app/MCP connection, and run the acceptance
checks in a fresh chat. To roll back, select the previous verified archive and
restart; reload modules rather than reusing old handles.

For maintainers, prepare the next version in `package.json`, `package-lock.json`,
`src/version.ts`, `plugin.json`, and `mcp.json` together. Keep these installation
examples in sync. Publish that npm version before distributing the pinned plugin
for normal installation. Run the commands below from the matching repository
checkout; the extracted plugin and installed npm package do not include the
Makefile or development scripts. Packaging helpers require Make and Python 3.9+
in addition to the Node/npm and Agda prerequisites. Review the skill contract against the
new server, run skill-creator validation and the behavioral prompts in
`docs/agent-skill-validation.md`, then:

```sh
make check-plugin
make pack-plugin
make smoke-plugin
```

`pack-plugin` stages an allowlisted payload under `.plugin-build/`, emits a ZIP
with stable file ordering/timestamps, and writes a SHA-256 sidecar. `smoke-plugin`
starts the pinned command from an extracted archive in a temporary directory,
verifies tools and skill resources, and exercises a preview and an applied
refinement on temporary proofs with both legacy and modern clients. It requires Node/npm, Agda, and registry access/cache. It never installs
the plugin globally. Distribute the ZIP and checksum together. Server npm
releases remain governed by the existing repository release workflow.

## Server-side skill discovery

The server npm package contains the same `skills/agda-proof` directory as the
plugin. `skills/list` and `skills/get` return metadata and complete file digests;
`resources/read` serves those bundled bytes using `skill://agda-proof/...` URIs.
This works without an Agda installation or an active module. Restart the server
after a skill update to obtain a new consistent catalog snapshot.

The same executable supports MCP 2026-07-28 and legacy initialization-based
clients. Modern clients attach per-request protocol and capability metadata;
legacy clients keep their `initialize` handshake. There is no extra startup
flag. A modern client may discover the server without initializing. Responses
use the appropriate wire format for the connection's selected era; both eras
expose the same skill and Agda operations.

When client workspace roots are needed, modern clients fulfil an
`input_required` roots request and retry the original operation. Legacy roots
requests are unchanged. The plugin's `--dynamic-workspaces` command lets load
requests choose workspace roots explicitly. Protocol version/capability metadata
is checked independently on modern requests. Progress remains request-scoped;
modern deferred-job completion notices use stderr instead of unsolicited MCP
notifications.

The plugin's local skill directory remains available to hosts that do not
consume server-side skill discovery. Resource reads alone do not activate a
skill; activation and any required approval are handled by the host. Keep
plugin and server skill origins distinct.

## `pack && smoke`: testing an unreleased server

From the matching repository checkout, build the server before creating its npm
tarball (the explicit ignore-scripts below avoids rerunning the release prepack
pipeline):

```sh
npm ci
npm run typecheck
npm run test:all
npm run build
npm run test:package
make pack-plugin
npm pack --ignore-scripts --pack-destination .plugin-build
python3 scripts/smoke-plugin.py .plugin-build/agda-mcp-plugin-0.5.0.zip --server-package .plugin-build/agda-mcp-0.5.0.tgz
python3 scripts/smoke-plugin.py .plugin-build/agda-mcp-plugin-0.5.0.zip --server-package .plugin-build/agda-mcp-0.5.0.tgz --modern
```

The explicit `--server-package` override tests the local tarball with npm exec;
it does not change the archived pinned command. Without that option the smoke
test runs the registry pin, which requires 0.5.0 to have been published. The
legacy and modern checks verify discovered file digests, supporting resource reads, and a temporary
proof's preview/apply workflow. Publishing remains an explicit release action.

## Format and host references

- [Portable plugin structure and local marketplaces](https://developers.openai.com/plugins/build/plugins)
- [OpenAI desktop-only submission requirements](https://developers.openai.com/plugins/deploy/desktop-only)
- [MCP Skills extension](https://skills.extensions.modelcontextprotocol.io/specification/stable/skills)
