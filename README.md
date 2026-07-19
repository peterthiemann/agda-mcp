# agda-mcp

`agda-mcp` is a standalone, non-mutating MCP server for Agda's JSON
interaction protocol. It keeps one long-lived `agda --interaction-json`
process per active workspace and supports on-disk `.agda`, `.lagda`, and
`.lagda.md` modules.

The server exposes normalized, transport-independent results while retaining
Agda's native response events in a bounded `raw` field. Case split, refine, and
auto return fingerprinted edit proposals; they never write source files.

## Requirements

- Node.js 22 or newer
- Agda installed separately and available as `agda`, or configured explicitly
- Agda 2.8.0 for the currently verified protocol adapter

Other Agda versions start in `unverified` compatibility mode. The server does
not bundle Agda or the standard library.

## Installation and use

Install the CLI globally:

```sh
npm install --global agda-mcp
agda-mcp --help
```

Or run it without a global installation:

```sh
npx -y agda-mcp
# equivalent:
npm exec --yes agda-mcp
```

The default command starts an MCP stdio server. Stdout is reserved exclusively
for MCP framing; operational diagnostics use stderr.

A generic MCP client configuration looks like this:

```json
{
  "mcpServers": {
    "agda": {
      "command": "npx",
      "args": ["-y", "agda-mcp"],
      "env": {
        "AGDA_MCP_OPTIONS": "{\"workspaceRoots\":[\"/absolute/path/to/project\"]}"
      }
    }
  }
}
```

If the client publishes filesystem roots through MCP, `workspaceRoots` may be
omitted. Otherwise the server falls back to its working directory.

## Configuration

Initialization policy is supplied as a JSON object in `AGDA_MCP_OPTIONS`.
Unknown fields and invalid limits are rejected before an Agda process starts.

| Option | Meaning | Default |
| --- | --- | --- |
| `agdaExecutable` | Executable name or path resolved at server startup | `agda` |
| `workspaceRoots` | Allowed absolute roots for direct module targets | MCP roots or cwd |
| `includePaths` | Extra project-relative include paths | `[]` |
| `libraries` | Additional registered Agda libraries | `[]` |
| `libraryFile` | Alternate Agda libraries file | Agda default |
| `additionalFlags` | Extra `Cmd_load` flags | `[]` |
| `workspaceOverrides` | Per-workspace include/library/flag overrides | `[]` |
| `loadTimeoutMs` | Load and restoration command timeout | `120000` |
| `queryTimeoutMs` | Read/query command timeout | `30000` |
| `transformationTimeoutMs` | Case split/refine/auto timeout | `60000` |
| `commandTimeoutMs` | Compatibility umbrella and installation-probe timeout | `30000` |
| `maxQueuedCommands` | Maximum running plus queued calls per workspace | `64` |
| `rawResponseLimitBytes` | Soft native-event return budget per command | `131072` |
| `stderrReturnLimitBytes` | Soft captured-stderr return budget | `32768` |
| `maxCommandOutputBytes` | Hard aggregate child-output limit | `16777216` |
| `allowAgdaExec` | Permit `--allow-exec` in resolved flags | `false` |

When only the legacy `commandTimeoutMs` is supplied, it applies to all three
operation categories. Specific timeout fields override it.

The nearest ancestor `.agda-lib` inside the selected workspace supplies
project includes, dependencies, and flags. Configuration is merged
deterministically with global and workspace overrides. Direct source targets
must remain inside a configured workspace after canonical path resolution;
registered imports may live elsewhere.

## Tools

| Tool | Purpose |
| --- | --- |
| `agda_server_info` | Report Agda discovery, compatibility, capabilities, and sessions |
| `agda_load_module` | Load/typecheck one top-level module and establish a workspace |
| `agda_typecheck` | Reload/typecheck the active workspace module |
| `agda_retrieve_goals` | Retrieve current visible goals and opaque handles |
| `agda_retrieve_context` | Retrieve a goal type, local context, and boundary |
| `agda_retrieve_constraints` | Retrieve current constraints |
| `agda_case_split` | Preview case-split clause edits |
| `agda_refine` | Preview a refinement or introduction edit |
| `agda_auto` | Preview simple proof search |
| `agda_normalize_expression` | Normalize in top-level or goal-local scope |
| `agda_infer_type` | Infer a type in top-level or goal-local scope |
| `agda_query_metavariables` | Query visible and backend-published invisible metas |

`agda_load_module` returns an opaque workspace handle. Goal-producing results
return opaque goal handles bound to the module path, revision, source
fingerprint, interaction point, and range. Reloading, recovering, switching
modules, or completing any transformation preview invalidates older goal
handles.

Expression tools require exactly one of `workspace` or `goal`. Input schemas
are strict, so contradictory selectors and unknown properties fail before
reaching Agda.

## Non-mutating edit previews

Case split, refine, and auto use one transaction model:

1. Validate the goal handle and loaded source fingerprint.
2. Ask Agda for a proposal.
3. Recheck the file fingerprint.
4. Map the native response to `TextEdit` values against the immutable snapshot.
5. Reload the active module before returning, even when the proposal is
   rejected.
6. Return fresh restored goals and separate operation/restore transcripts.

Each edit carries its absolute file path, exact UTF-16 range, replacement text,
and expected SHA-256 source fingerprint. Clients should verify that fingerprint
before applying an edit, then call `agda_typecheck`. If restoration fails, the
server terminates and invalidates the session and returns no safe proposal.

Literate prose and code delimiters are excluded from editable code regions.
An ambiguous or cross-region proposal fails with `UNSUPPORTED_EDIT_SHAPE`.

## Output limits and recovery

`raw` retains complete native JSON events up to the soft response budget. When
the budget is exceeded, normalized data still returns with byte counts, omitted
event count, and an omission digest. Stderr has an independent soft budget.
Crossing the hard aggregate limit aborts the command with
`OUTPUT_LIMIT_EXCEEDED`.

Workspace calls are FIFO; different workspaces progress concurrently. Active
cancellation first asks Agda to abort and terminates it after a bounded grace
period. After an unexpected exit, old handles are revoked. The next workspace
operation starts a fresh process and reloads only if the source fingerprint is
unchanged.

## Upgrading Agda

After installing or switching Agda, restart the MCP server. On every server
start it resolves `agda` again and reprobes the exact version, Agda application
directory, and data directory; it does not cache installation or library
locations across runs.

That restart is sufficient when the new version still speaks the supported
interaction protocol. Agda 2.8.0 is verified. A different detected version is
reported as `unverified` and uses the 2.8.0 adapter conservatively. If a
required command or response shape changed, the affected call returns
`UNSUPPORTED_AGDA_PROTOCOL` with native evidence. Upgrade `agda-mcp` to a
version containing an adapter for that Agda release (or contribute one) before
relying on those operations.

## Development

```sh
npm ci
npm run typecheck
npm test
npm run test:fuzz
npm run test:integration
npm run build
npm run smoke
npm run test:package
npm pack --dry-run
```

The deterministic fuzz campaign combines grammar-aware properties, arbitrary
protocol bytes, recorded-corpus mutation, Unicode range/edit properties, strict
schema properties, and queue-policy properties. Defaults are 1,000 cases per
property and 5,000 corpus mutations. Longer campaigns can be configured with
`AGDA_MCP_PROPERTY_RUNS`, `AGDA_MCP_FUZZ_RUNS`, and `AGDA_MCP_FUZZ_SEED`.

## Releasing

Subsequent releases are published to npm and GitHub by
`.github/workflows/release.yml`. Before using the workflow for the first time,
configure the `agda-mcp` package on npmjs.com with this trusted publisher:

- Provider: GitHub Actions
- Organization or user: `peterthiemann`
- Repository: `agda-mcp`
- Workflow filename: `release.yml`
- Environment: none
- Allowed action: `npm publish`

No npm token or GitHub Actions secret is required. The workflow uses a
short-lived OpenID Connect credential and npm automatically records provenance
for the public package.

For a release, update `package.json` and `package-lock.json` to the intended
version, commit and push that change, then push an annotated tag named
`release-X.Y` or `release-X.Y.Z`. The two-part form is normalized to `X.Y.0`;
the resulting version must match `package.json` exactly. For example:

```sh
npm version 0.2.0 --no-git-tag-version
git add package.json package-lock.json
git commit -m "Release 0.2.0"
git push
git tag -a release-0.2.0 -m "Release 0.2.0"
git push origin release-0.2.0
```

The tag workflow validates the version, installs from the lockfile, runs the
typecheck and complete test suite, builds and smoke-tests the executable, packs
the exact tarball, publishes that tarball to npm through trusted publishing,
and finally creates the GitHub release with the tarball and its SHA-256 file.
Merely changing or pushing the workflow does not publish a package; only a new
matching `release-*` tag triggers it. npm versions are immutable, so verify the
version before pushing the tag.

## Genesis and Codex involvement

This project began as a design dialogue between Peter Thiemann and OpenAI
Codex, operating as a GPT-5-based coding agent. Peter set the goals and made
the consequential design choices: a standalone TypeScript server, one
long-lived Agda interaction process per workspace, a transport-independent
application API with stdio first, support for all three on-disk Agda source
formats, opaque goal handles, normalized responses retaining native events,
and non-mutating transformation previews with mandatory reload.

Codex turned that dialogue into the initial design and implementation plan,
then implemented the repository in reviewed checkpoints. Its work included the
protocol codec and streaming parser, process/session management, the twelve MCP
tools, literate-source edit planning, recovery and packaging, documentation,
and the unit, integration, property-based, mutation-fuzz, live-Agda, and MCP
stdio tests. Codex also staged, committed, pushed, and followed the CI results
under Peter's explicit repository authorization. Peter remained the project
owner and decision-maker throughout; this history records substantial
AI-assisted design and implementation, not an OpenAI endorsement of the
software.

## Design and license

- [Initial design](./DESIGN.md)
- [Implementation plan](./IMPLEMENTATION_PLAN.md)
- [MIT license](./LICENSE)
