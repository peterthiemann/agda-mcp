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
| `abortGraceMs` | Grace period before escalating an aborted command | `1000` |
| `probeTimeoutMs` | Installation-probe timeout | `10000` |
| `probeMaxBufferBytes` | Installation-probe output buffer | `1048576` |
| `handleEntropyBytes` | Random bytes per workspace/goal/job handle (min `16`) | `24` |
| `asyncMode` | `never`, `auto`, or `always`; see below | `never` |
| `deferAfterMs` | How long a tool call may block before deferring to a job | `2500` |
| `maxJobWaitMs` | Ceiling on a single `agda_job_await` wait | `30000` |
| `jobRetentionMs` | How long an uncollected finished job is kept | `300000` |
| `maxTrackedJobs` | Maximum concurrently tracked jobs | `64` |
| `progressIntervalMs` | Heartbeat for `notifications/progress` | `2000` |
| `includeRawByDefault` | Ship Agda's native event log | `true` |
| `maxBatchGoals` | Maximum goals one batched request may resolve | `32` |

## Non-blocking operation

Typechecking a large development can take minutes, and holding the MCP request
open for that whole time stalls the calling agent completely.

Deferral changes the shape of a successful tool response, so it is **opt-in**.
Enable it globally with `asyncMode: "auto"`, or per call with `async: true` or
`deferAfterMs`. With it enabled, a call that outruns `deferAfterMs` returns a
job handle instead of blocking:

```json
{
  "status": "pending",
  "job": { "id": "job_...", "tool": "agda_load_module", "state": "running", "elapsedMs": 2500 },
  "guidance": "Agda is still working ... call agda_job_await with job \"job_...\""
}
```

Agda keeps working in the background while the caller is free to do something
else, and the result is collected later with `agda_job_await`. Calls that
finish inside the window return their result inline, exactly as before, so
fast operations are unchanged.

`asyncMode` controls the policy: `never` (default) always blocks until Agda
finishes, `auto` defers only calls slower than `deferAfterMs`, and `always`
defers every call.

### Per-call overrides

Every Agda tool also accepts these fields, which shadow the configured values
for one call only:

| Field | Meaning |
| --- | --- |
| `timeoutMs` | Agda command timeout for this call |
| `deferAfterMs` | Defer window for this call, capped by `maxJobWaitMs` |
| `async` | `true` always returns a job handle; `false` blocks until Agda finishes |
| `includeRaw` | Include Agda's native event log (see below) |
| `diagnosticsOnly` | `agda_load_module` / `agda_typecheck` only: errors and warnings |

```json
{ "modulePath": "/src/Slow.agda", "timeoutMs": 600000, "async": true }
```

The cap on `deferAfterMs` is deliberate: a per-call value can shorten the
window but can never reintroduce unbounded blocking.

### Progress and completion notices

While a request is open the server emits `notifications/progress` every
`progressIntervalMs`, provided the client supplied a progress token. When any
job settles it also emits a `notifications/message` log line. Neither can wake
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
| `agda_retrieve_contexts` | Retrieve contexts for several goals in one round trip |
| `agda_retrieve_constraints` | Retrieve current constraints |
| `agda_case_split` | Preview case-split clause edits |
| `agda_refine` | Preview a refinement or introduction edit |
| `agda_auto` | Preview simple proof search |
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

Agda's native event log ships by default, as the normalized-plus-native-`raw`
contract requires. Because it is the largest part of a response, `includeRaw:
false` is offered as an opt-in optimization: it replaces `raw.events` with a
summary — `eventsOmitted`, `eventCount`, byte counts, completeness, stderr — so
truncation stays detectable:

```json
{ "adapter": "agda-2.8.0", "eventsOmitted": true, "eventCount": 7,
  "capturedBytes": 812, "totalBytes": 812, "stderr": { "chunks": [] } }
```

Set `includeRawByDefault: false` to make omission the server-wide default. A
per-call `includeRaw` always wins over the server default.

`diagnosticsOnly: true` further drops `goals` and `invisibleMetavariables` from
a load or typecheck, leaving the verdict and diagnostics — useful for the common
"did it compile?" question.

## Batched goal contexts

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
protocol codec and streaming parser, process/session management, the twelve MCP
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
