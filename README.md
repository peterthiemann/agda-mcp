# agda-mcp

`agda-mcp` is a standalone MCP server for Agda's JSON
interaction protocol. It keeps one long-lived `agda --interaction-json`
process per active workspace and supports on-disk `.agda`, `.lagda`, and
`.lagda.md` modules.

The server exposes normalized, transport-independent results while retaining
bounded metadata about Agda's native responses in a `raw` field. Native events
are available on request. Case split, refine, and auto are non-mutating by
default. An explicit `apply: true`, or starting the server with
`--apply-edits`, atomically writes the guarded proposal and typechecks it in the
same operation.

## End-to-end example

Suppose `/workspace/Example.agda` contains:

```agda
module Example where

data Bool : Set where
  true  : Bool
  false : Bool

not : Bool → Bool
not x = ?
```

An agent can take the file from one hole to two case-specific holes as follows.
Responses below are abbreviated to their normalized `data`; opaque handles and
the source fingerprint must be reused exactly as returned. This example assumes
the server was started with `--dynamic-workspaces`, allowing the first call to
select `/workspace` without per-project server configuration.

```text
# 1. Load and typecheck the top-level module.
agda_load_module({
  "modulePath": "/workspace/Example.agda",
  "workspaceRoot": "/workspace",
  "includeRaw": false
})
→ data.workspace = "workspace_…"

# 2. Retrieve the current goals (the load response includes them too).
agda_retrieve_goals({
  "workspace": "workspace_…",
  "includeRaw": false
})
→ data.goals[0] = { "handle": "goal_…", "type": "Bool", … }

# 3. Inspect the selected goal's local context.
agda_retrieve_context({
  "goal": "goal_…",
  "includeRaw": false
})
→ data = {
    "goal": "goal_…",
    "goalType": "Bool",
    "context": [{ "reifiedName": "x", "type": "Bool", "inScope": true }]
  }

# 4. Ask Agda for a non-mutating case-split preview.
agda_case_split({
  "goal": "goal_…",
  "variables": "x",
  "includeRaw": false
})
→ data.edits[0] = {
    "file": "/workspace/Example.agda",
    "range": <exact UTF-16 range covering `not x = ?`>,
    "replacement": "not true = ?\nnot false = ?",
    "expectedSourceFingerprint": "…"
  }

# 5. Client filesystem action — not an agda-mcp tool:
#    verify the file's SHA-256 fingerprint, then replace precisely the returned
#    range with the returned replacement text.

# 6. Reload the edited file and obtain fresh goal handles.
agda_typecheck({
  "workspace": "workspace_…",
  "includeRaw": false
})
→ data.checked = true
→ data.goals = [{ "handle": "goal_…", … }, { "handle": "goal_…", … }]
```

For a refinement, use `agda_refine` in step 4 with an `expression`; it returns
the same fingerprinted `edits` shape and follows the same apply-then-typecheck
flow. Preview operations reload canonical Agda state before returning, so only
goal handles from the latest response should be used.

For the faster compound forms, set `includeContexts: true` on step 1 to receive
the goals and every goal context with the load result. Set `apply: true` on
step 4—or enable `--apply-edits` once for the server—to have it perform steps 5
and 6 as one guarded transaction:

```text
agda_case_split({ "goal": "goal_…", "variables": "x", "apply": true })
→ data.applied = true
→ data.checked = true
→ data.goals = <fresh handles from the edited module>
```

The preview flow remains the safe startup default and is useful when the client
wants to inspect or revise the proposal before changing the file.

## Requirements

- Node.js 22 or newer
- Agda installed separately and available as `agda`, or configured explicitly
- Agda 2.8.0 for the currently verified protocol adapter

Other Agda versions start in `unverified` compatibility mode. The server does
not bundle Agda or the standard library.

## Installation and use

These commands install the published npm version. Features described for the
unreleased 0.5.0 candidate require a source build or local tarball until that
version is published; see [INSTALL.md](INSTALL.md#pack--smoke-testing-an-unreleased-server).

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

Legacy `initialize` and modern `server/discover` publish concise `instructions` that
teach the client the core workflow: inspect effective policy, load an absolute
module and optional request-selected workspace, prefer compound context
retrieval, reuse only fresh opaque goal handles, and distinguish preview from
guarded apply/typecheck transformations. The complete instruction block fits
within the self-contained 512-character prefix recommended for Codex
tool-selection guidance.

A generic model-selected workspace configuration looks like this:

```json
{
  "mcpServers": {
    "agda": {
      "command": "npx",
      "args": ["-y", "agda-mcp", "--dynamic-workspaces"]
    }
  }
}
```

The server is installed once. The model then selects an active workspace on
its first load instead of requiring a separate client entry for each project:

```text
agda_load_module({
  "modulePath": "/absolute/path/to/project/Main.agda",
  "workspaceRoot": "/absolute/path/to/project"
})
```

Both paths must exist and be absolute. The server resolves symlinks, requires
the module to remain within the selected root, discovers the nearest
`.agda-lib`, and lazily starts or reuses that project's long-lived Agda
process. `agda_server_info` reports this mode as
`capabilities.workspaceSelection: "request"`.

`--dynamic-workspaces` deliberately broadens the directories that MCP calls
can target to anything accessible to the server process. Only enable it for a
trusted local model/client. Without the flag, a supplied `workspaceRoot` must
exactly match a configured root. The server otherwise uses MCP filesystem
roots when the client publishes them, falling back to its working directory.
The restricted configuration remains available when a fixed allowlist is
preferred:

```json
{
  "command": "npx",
  "args": ["-y", "agda-mcp"],
  "env": {
    "AGDA_MCP_OPTIONS": "{\"workspaceRoots\":[\"/absolute/path/to/project\"]}"
  }
}
```

### Enable in-place transformations

Start the server with `--apply-edits` to make case split, refine, and auto
write their proposed source changes and immediately typecheck them by default:

```sh
agda-mcp --apply-edits
# or
npx -y agda-mcp --apply-edits
```

For an MCP client configuration, add the flag to the command arguments:

```json
{
  "command": "npx",
  "args": ["-y", "agda-mcp", "--apply-edits"]
}
```

It composes with runtime workspace selection:

```sh
npx -y agda-mcp --dynamic-workspaces --apply-edits
```

Clients that configure the server through the environment can equivalently set
`"applyEditsByDefault": true` inside `AGDA_MCP_OPTIONS`. The command-line flag
wins over an environment value. `agda_server_info` reports the effective mode
as `capabilities.transformationDefault`.

This mode does not permit arbitrary writes: only edits proposed by Agda for the
currently loaded, fingerprint-matching source are eligible. A particular tool
call can still request `apply: false` to obtain a non-mutating preview.

## Agent Skill and portable plugin

The [Agda proof skill](skills/agda-proof/SKILL.md) teaches incremental proof
development using semantic MCP operations, preferring guarded mutations for
authorized proof edits. The portable plugin pairs it with an exact npm server
pin. See [installation and updates](INSTALL.md) for requirements, local plugin
installation, workspace configuration, and acceptance checks.

Build a distributable archive with `make pack-plugin`; verify its pinned server
on a temporary proof with `make smoke-plugin`. The archive and SHA-256 sidecar
are written under `.plugin-build/`. This is separate from the server npm release
pipeline. The npm package also includes `skills/agda-proof` and serves its
files independently of the working directory and Agda installation.

### Server-side skill discovery

The server advertises `io.modelcontextprotocol/skills` in
`capabilities.extensions` through modern discovery and legacy initialization,
and exposes:

- `skills/list`: one complete skill entry, including verbatim YAML frontmatter
  and a manifest of every bundled skill file's URI, byte size, and SHA-256 digest.
- `skills/get({uri:"skill://agda-proof/SKILL.md"})`: the same entry by URI.
- `resources/list` and `resources/read`: the entrypoint, references, and UI
  metadata at `skill://agda-proof/...`; unknown resources return Invalid params.

### Modern MCP and backward compatibility

The CLI uses the official v2 SDK's dual-era stdio entry. A modern client sends
`server/discover` or another request with MCP 2026-07-28 metadata and proceeds
without initialization. Every modern request carries its version and client
capabilities in `_meta`; results include `resultType`, server identity, and the
required cache fields on cacheable operations.
For example, this newline-delimited JSON request discovers the modern server:

```json
{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}
```

Include those two metadata fields on subsequent modern requests as well.
`io.modelcontextprotocol/clientInfo` is optional. The server's identity appears
in the response's `_meta["io.modelcontextprotocol/serverInfo"]`, rather than a
modern top-level `serverInfo` field. Unsupported version claims are
rejected on every request, including after the connection has been established.

Existing clients continue to use `initialize` and `notifications/initialized`
with the same 18 tools, inputs, normalized payloads, and application job handles.
A modern discovery probe can be followed by a legacy initialization on the same
stdio connection. No flag or separate executable is needed. Modern-capable SDK
clients can opt into automatic negotiation or pin `2026-07-28`; old SDK clients
remain covered by the regression and packed-install tests.

Modern workspace-root discovery uses an `input_required` result containing
`roots/list`, then resumes the original operation with the client's response.
It happens before starting an Agda job and never emits a server-initiated
JSON-RPC request to a modern client. Explicit configured roots or
`--dynamic-workspaces` avoid that exchange; legacy client roots retain their
existing request/response behavior. Long-lived Agda sessions and deferred jobs
remain application state referenced by opaque workspace, goal, and job handles.

Progress is scoped to an in-flight request. Completion notices for deferred
modern jobs go to stderr; legacy clients retain the existing logging
notifications. Cancellation and EOF shut down active work and child processes.
The server remains a stdio server; this upgrade does not add an HTTP endpoint.

Protocol and migration references:
[modern MCP](https://modelcontextprotocol.io/specification/2026-07-28/basic),
[SDK dual-era stdio serving](https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio).

Catalog content is snapshotted for the life of a server instance so its digests
and resource reads agree; restart after updating skill files. Discovery never
starts Agda. Reading a resource is not skill activation or authorization: that
remains the host's responsibility. When both the plugin and server expose the
skill, hosts should preserve its origin rather than silently substituting one
copy for the other.

Version 0.5.0 is prepared locally and must be published before the plugin's
pinned npm command is available to other users. Test the unreleased tarball
with `npm run test:package` and the local-package smoke option in INSTALL.md.

## Configuration

Initialization policy is supplied as a JSON object in `AGDA_MCP_OPTIONS`.
Unknown fields and invalid limits are rejected before an Agda process starts.

| Option | Meaning | Default |
| --- | --- | --- |
| `agdaExecutable` | Executable name or path resolved at server startup | `agda` |
| `workspaceRoots` | Allowed absolute roots for direct module targets | MCP roots or cwd |
| `allowDynamicWorkspaces` | Allow a load request to select a root outside `workspaceRoots` | `false` |
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
| `abortGraceMs` | Grace period before escalating an aborted command | `1000` |
| `probeTimeoutMs` | Installation-probe timeout | `10000` |
| `probeMaxBufferBytes` | Installation-probe output buffer | `1048576` |
| `handleEntropyBytes` | Random bytes per workspace/goal/job handle (min `16`) | `24` |
| `asyncMode` | `never`, `auto`, or `always`; see below | `auto` |
| `deferAfterMs` | How long a tool call may block before deferring to a job | `1000` |
| `maxJobWaitMs` | Ceiling on a single `agda_job_await` wait | `30000` |
| `jobRetentionMs` | How long an uncollected finished job is kept | `300000` |
| `maxTrackedJobs` | Maximum concurrently tracked jobs | `64` |
| `progressIntervalMs` | Heartbeat for `notifications/progress` | `2000` |
| `includeRawByDefault` | Ship Agda's native event log | `false` |
| `maxBatchGoals` | Maximum goals one batched request may resolve | `32` |
| `applyEditsByDefault` | Apply/typecheck transformations when `apply` is omitted | `false` |

## Non-blocking operation

Typechecking a large development can take minutes, and holding the MCP request
open for that whole time stalls the calling agent completely.

Slow calls defer by default so one expensive load does not hold an agent turn
open indefinitely. A call that outruns `deferAfterMs` returns a job handle
instead of blocking:

```json
{
  "status": "pending",
  "job": { "id": "job_...", "tool": "agda_load_module", "state": "running", "elapsedMs": 1000 },
  "guidance": "Agda is still working ... call agda_job_await with job \"job_...\""
}
```

Agda keeps working in the background while the caller is free to do something
else, and the result is collected later with `agda_job_await`. Calls that
finish inside the window return their result inline, exactly as before, so
fast operations are unchanged.

`asyncMode` controls the policy: `auto` (default) defers only calls slower than
`deferAfterMs`, `never` always blocks until Agda finishes, and `always` defers
every call. Set `async: false` on one call, or configure `asyncMode: "never"`,
when a client requires the legacy fully synchronous behavior.

### Per-call overrides

The transport supports these per-call fields; the tool-specific ones are
accepted only where indicated. Policy fields shadow configured values for one
call only:

| Field | Meaning |
| --- | --- |
| `timeoutMs` | Agda command timeout for this call |
| `deferAfterMs` | Defer window for this call, capped by `maxJobWaitMs` |
| `async` | `true` always returns a job handle; `false` blocks until Agda finishes |
| `includeRaw` | Include Agda's native event log (see below) |
| `diagnosticsOnly` | `agda_load_module` / `agda_typecheck` only: errors and warnings |
| `includeContexts` | `agda_load_module` / `agda_typecheck` only: include all goal contexts |
| `apply` | Transformation tools only: override server policy (`true` applies, `false` previews) |

```json
{ "modulePath": "/src/Slow.agda", "timeoutMs": 600000, "async": true }
```

The cap on `deferAfterMs` is deliberate: a per-call value can shorten the
window but can never reintroduce unbounded blocking.

### Progress and completion notices

While a request is open the server emits `notifications/progress` every
`progressIntervalMs`, provided the client supplied a progress token. When any
job settles it emits a `notifications/message` log line for legacy clients
and a stderr completion notice for modern clients. Neither can wake
an agent mid-turn — MCP has no such mechanism — but they surface activity in
clients that display progress or server logs.

When work is fanned out across several workspaces, `agda_job_await_any` waits
once for whichever job finishes first instead of polling each id in turn.

A deferred job is deliberately detached from the request that created it —
the transport closing that request does not cancel the Agda work. Use
`agda_job_cancel` to abandon a job.

When only the legacy `commandTimeoutMs` is supplied, it applies to all three
operation categories. Specific timeout fields override it.

The nearest ancestor `.agda-lib` inside the selected workspace supplies
project includes, dependencies, and flags. Configuration is merged
deterministically with global and workspace overrides. Direct source targets
must remain inside the selected workspace after canonical path resolution;
without `--dynamic-workspaces`, that selected root must also be configured.
Registered imports may live elsewhere.

## Tools

| Tool | Purpose |
| --- | --- |
| `agda_server_info` | Report Agda discovery, compatibility, capabilities, and sessions |
| `agda_load_module` | Select a workspace and load/typecheck one top-level module |
| `agda_typecheck` | Reload/typecheck the active workspace module |
| `agda_retrieve_goals` | Retrieve current visible goals and opaque handles |
| `agda_retrieve_context` | Retrieve a goal type, local context, and boundary |
| `agda_retrieve_contexts` | Retrieve contexts for several goals in one round trip |
| `agda_retrieve_constraints` | Retrieve current constraints |
| `agda_case_split` | Preview case-split clauses, or apply and typecheck them |
| `agda_refine` | Preview a refinement/introduction, or apply and typecheck it |
| `agda_auto` | Preview proof search, or apply and typecheck its solution |
| `agda_normalize_expression` | Normalize in top-level or goal-local scope |
| `agda_infer_type` | Infer a type in top-level or goal-local scope |
| `agda_query_metavariables` | Query visible and backend-published invisible metas |
| `agda_job_await` | Collect a pending job's result, waiting up to `waitMs` |
| `agda_job_await_any` | Wait for the FIRST of several jobs to finish |
| `agda_job_status` | Report a job's state without waiting |
| `agda_job_cancel` | Abort a pending job |
| `agda_job_list` | List jobs still running or awaiting collection |

`agda_load_module` returns an opaque workspace handle. Goal-producing results
return opaque goal handles bound to the module path, revision, source
fingerprint, interaction point, and range. Reloading, recovering, switching
modules, or completing any transformation preview invalidates older goal
handles.

Expression tools require exactly one of `workspace` or `goal`. Input schemas
are strict, so contradictory selectors and unknown properties fail before
reaching Agda.

## Response size

Agda's native event log is the largest part of most responses, so it is omitted
by default. The `raw` field instead contains a summary — `eventsOmitted`,
`eventCount`, byte counts, completeness, and stderr — so truncation stays
detectable:

```json
{ "adapter": "agda-2.8.0", "eventsOmitted": true, "eventCount": 7,
  "capturedBytes": 812, "totalBytes": 812, "stderr": { "chunks": [] } }
```

Set `includeRaw: true` for a call that needs the native event sequence, or set
`includeRawByDefault: true` to restore it globally. A per-call value always
wins over the server default.

MCP `content` contains only a compact human-readable summary. The complete
normalized result is sent once in `structuredContent`, avoiding the previous
cost of serializing and transmitting the same large object twice.

`diagnosticsOnly: true` further drops `goals` and `invisibleMetavariables` from
a load or typecheck, leaving the verdict and diagnostics — useful for the common
"did it compile?" question.

## Batched goal contexts

For the common load-and-inspect path, `includeContexts: true` on
`agda_load_module` or `agda_typecheck` retrieves every newly returned goal
context in that same operation. It uses the same bounded aggregation policy as
the explicit batch tool below.

`agda_retrieve_contexts` takes a list of goal handles and returns one entry per
goal, in request order:

```json
{ "requested": 3, "succeeded": 2, "failed": 1,
  "contexts": [ { "goal": "goal_...", "ok": true, "context": { "goalType": "Bool", "context": [] } },
                { "goal": "goal_bad", "ok": false, "error": { "code": "STALE_GOAL_HANDLE" } } ] }
```

Agda still processes the goals one at a time — the interaction process is
single-threaded — but the caller pays for one round trip instead of N.

A batch is limited to `maxBatchGoals` goals. Only failures attributable to one
goal — a stale handle, or a command Agda rejected, timed out on, or answered
too voluminously — become that goal's entry. Anything describing the session or
the batch (`SOURCE_CHANGED`, `NO_ACTIVE_MODULE`, `UNKNOWN_WORKSPACE`, a dead
process, a cancellation) aborts the whole call, because the remaining goals
could not be answered either.

The returned `raw` merges every command that ran and is re-truncated against a
single `rawResponseLimitBytes` budget, so a batch cannot build a response
larger than one command may. The combined `omittedSha256` covers each source
transcript's own omission digest followed by every event the merge dropped.

## Transformation previews and guarded direct edits

Case split, refine, and auto select their behavior from the per-call `apply`
value when present, otherwise from the server policy. With the default policy
or `apply: false`, they use the non-mutating preview transaction:

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

With `apply: true`, or when `--apply-edits` supplies that default, the server
verifies the proposal targets the active module and fingerprint, rechecks the
source immediately before writing, replaces the file atomically, and
reloads/typechecks it once. The result reports `applied`, `checked`,
`diagnostics`, the new source fingerprint, and fresh goal handles.
If the canonical reload itself fails, the server attempts a fingerprint-guarded
rollback and refuses that rollback when the edited fingerprint no longer
matches. Changes detected during proposal generation or immediately before an
atomic replacement are rejected. File mutation is therefore opt-in per
transformation call or server startup, while preview remains available as an
explicit override.
An ordinary Agda type error is a completed result (`checked: false`), so the
applied source remains on disk and its diagnostics are returned for the caller
to address; rollback is reserved for failures that prevent a trustworthy
canonical result.

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

For a release, synchronize `package.json`, `package-lock.json`, `src/version.ts`,
`plugin.json`, and the exact `agda-mcp@X.Y.Z` pin in `mcp.json`. Update the
versioned examples in INSTALL.md as well. The npm version command updates only
the two npm metadata files; it does not update the source constant or plugin
configuration. For the prepared 0.5.0 release:

```sh
npm version 0.5.0 --allow-same-version --no-git-tag-version
# Update src/version.ts, plugin.json, mcp.json, and INSTALL.md to match.
npm run typecheck
npm run test:all
npm run build
npm run test:package
make check-plugin
make pack-plugin
# Run both local-tarball smoke checks from INSTALL.md before publishing.
git add package.json package-lock.json src/version.ts plugin.json mcp.json INSTALL.md
git commit -m "Release 0.5.0"
git push
git tag -a release-0.5.0 -m "Release 0.5.0"
git push origin release-0.5.0
```

Commit the complete implementation and skill before tagging, including all new
files; the `git add` line above lists the version-related files only. Tags may
be named `release-X.Y` or `release-X.Y.Z`; a two-part version normalizes to
`X.Y.0` and must match `package.json` exactly. Pushing the tag publishes the npm
server through the workflow. The plugin ZIP is built separately with
`make pack-plugin`; the release workflow currently attaches only the npm
tarball and its checksum, not the plugin ZIP. Publish the pinned npm version
before distributing the plugin for normal registry-backed installation.

The tag workflow validates the version, installs from the lockfile, runs the
typecheck and complete test suite, builds and smoke-tests the executable, packs
the exact tarball, publishes that tarball to npm through trusted publishing,
and finally creates the GitHub release with the tarball and its SHA-256 file.
Changing the workflow alone does not publish a package. Publishing runs on a
matching `release-*` tag push, or a manual workflow dispatch naming an existing
release tag. npm versions are immutable, so verify the
version before pushing the tag.

## Genesis and Codex involvement

This project began as a design dialogue between the project maintainer and
OpenAI Codex, operating as a GPT-5-based coding agent. The maintainer set the
goals and made the consequential design choices: a standalone TypeScript
server, one long-lived Agda interaction process per workspace, a
transport-independent application API with stdio first, support for all three
on-disk Agda source formats, opaque goal handles, normalized responses
retaining native events, and non-mutating transformation previews with
mandatory reload.

Codex turned that dialogue into the initial design and implementation plan,
then implemented the repository in reviewed checkpoints. Its work included the
protocol codec and streaming parser, process/session management, the initial twelve MCP
tools, literate-source edit planning, recovery and packaging, documentation,
and the unit, integration, property-based, mutation-fuzz, live-Agda, and MCP
stdio tests. Codex also staged, committed, pushed, and followed the CI results
under the maintainer's explicit repository authorization. The maintainer
remained the project owner and decision-maker throughout; this history records
substantial AI-assisted design and implementation, not an OpenAI endorsement
of the software.

## Design and license

- [Changelog](./CHANGELOG.md)
- [Initial design](./DESIGN.md)
- [Implementation plan](./IMPLEMENTATION_PLAN.md)
- [MIT license](./LICENSE)
