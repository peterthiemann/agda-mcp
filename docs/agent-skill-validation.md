# Agent skill analysis and validation

Status: current 0.5.0 release candidate; not published or installed globally.
The server supports modern MCP 2026-07-28 and legacy initialization-based clients.
This report describes the current implementation and verification results.

## `analyze`: implementation inventory

Reviewed the tool registrations and transport envelopes in
`src/mcp/stdioServer.ts`, strict inputs in `src/mcp/toolSchemas.ts`, domain output
types in `src/application/domain.ts`, and behavior in `agdaService.ts`,
`service.ts`, `errors.ts`, and `jobs.ts`. There are 18 Agda tools: 13 semantic
operations and five job controls. The portable tool contract is maintained in
[the skill reference](../skills/agda-proof/references/tools.md).

The entrypoint [SKILL.md](../skills/agda-proof/SKILL.md) covers load/inspect/edit,
local inference and normalization, constraints/metavariables, deferred work,
and error recovery. It prefers guarded MCP mutations for authorized incremental
proof edits while honoring explicit preview requests. It does not promise symbol
navigation, arbitrary commands, or unsaved-buffer synchronization.

`src/mcp/skillDiscovery.ts` serves the complete bundled skill as resources and
provides `skills/list` and `skills/get`. The official v2 SDK supplies modern
discovery and wire codecs. `src/mcp/modernTransport.ts` rejects unsupported
version claims on every request, including after a stdio connection is pinned.
The v1 SDK and v2 client are development-only dependencies; old clients remain
independent compatibility fixtures.

## `check`: structural and package validation

Skill-creator's `quick_validate.py` passes for `skills/agda-proof`. UI metadata
was generated with its `generate_openai_yaml.py`; implicit activation remains
enabled by default. The checks use Python with PyYAML in a temporary validation
environment, without adding Python dependencies to this project.

Both portable manifests pass their declared Agent Plugins 1.0.0 JSON schemas.
`make check-plugin` checks the matching server/plugin version and exact npm pin;
it is a local package-contract check, not the skill-creator or JSON-schema
validator. `make pack-plugin` stages a seven-file allowlisted payload and emits
a ZIP with stable ordering/timestamps and a SHA-256 sidecar. Repeated packaging
was checked for identical ZIP digests.

The server npm package includes the skill and references, portable manifests,
and INSTALL.md alongside its executable. The plugin and server tarball carry
byte-identical skill files. Paths are resolved relative to the installed server
package, not a development checkout or the client's working directory. Discovery
uses a process-lifetime byte snapshot, so advertised sizes/digests match reads.

## `test`: observed automated results

- `npm run typecheck`: passed.
- `npm run test:all`: 164 passed, zero failed or skipped, including unit,
  property/fuzz, live Agda, and stdio integration tests.
- `npm run test:package`: passed with both independent v1 and modern SDK clients,
  outside the checkout and with Agda deliberately unavailable; all bundled skill
  resources were readable and their sizes/digests matched installed bytes.
- Archive smoke checks passed in both raw legacy and modern modes against the
  local unreleased npm tarball: all 18 tools, matching skill bytes/digests,
  unchanged preview source, then a checked applied proof.

Raw-wire modern checks cover discovery without initialization, modern result
and cache fields, required per-request metadata, optional client identity,
unsupported versions after pinning, tools/deferred-job collection, cancellation
without a subsequent response, and discovery-to-legacy fallback. Live modern
stdio checks cover workspace roots via `input_required`, contexts, local type
inference, preview/application, and clean exit after stdin EOF during deferred
work. Existing v1-client regressions pass against the same server implementation.

Skill-specific checks include stale-goal rejection after preview, partial context
batches, strict selectors and mutually exclusive module flags. Catalog tests
cover extra YAML frontmatter, supporting file reads, unknown/escaping URIs,
malformed get requests, invalid cursors, immutable snapshots, and symlink
rejection. This does not claim that every tool/error combination was tested
through every client protocol.

## `probe`: activation and judgment cases

These reusable prompts specify observable decisions, not wording to match.

| Class | Prompt | Expected behavior |
| --- | --- | --- |
| Positive | Complete the hole in `/project/Example.agda`. | Activate; inspect server policy, load with contexts, prefer semantic mutation, use fresh handles and check the verdict. |
| Positive | What type does `f x` have inside this Agda hole? | Activate; infer with `goal`, never both selectors. |
| Positive | Does `/project/Main.lagda.md` compile? | Activate; use diagnosticsOnly and inspect checked/diagnostics. |
| Positive | Explain blocked constraints and hidden metas in this Agda module. | Activate; constraints plus query_metavariables. |
| Negative | Prove this theorem in Lean 4. | Do not select agda-proof. |
| Negative | Add a new MCP tool to the TypeScript server. | Do not select agda-proof for server development. |
| Negative | Explain dependent types without a proof assistant. | Do not select agda-proof. |
| Edge | Preview a case split without changing my Agda file. | Explicit apply:false even under an apply default; disk unchanged. |
| Edge | Use the goal from before that preview. | Reselect a fresh handle; recover stale state. |
| Edge | Typechecking returned pending. | Collect job.id; do not duplicate the operation. |
| Edge | Inspect these goals; one context fails. | Inspect per-entry ok/error and retain successful entries. |
| Edge | Both diagnosticsOnly and includeContexts, please. | Resolve contradictory intent; never send both true. |
| Edge | Search did not find a proof. | Report found:false; do not claim completion. |
| Edge | Applied source reports checked:false. | Diagnose the remaining on-disk source; do not assume rollback. |

An independent Codex pass reviewed these routing decisions and exercised actual
MCP operations on a temporary fixture. It read the whole entrypoint before
classifying prompts, so the routing review was not a blinded description-only
activation measurement. The live probe verified goal-local inference, a
non-mutating preview under an apply-default server, fresh-goal rotation, actual
STALE_GOAL_HANDLE rejection, and asynchronous diagnostics-only collection.

A fresh host installation and automatic skill activation remain unmeasured.
Use the acceptance checks in [INSTALL.md](../INSTALL.md) in fresh chats, with and
without explicitly invoking `$agda-proof`. Tool/transport tests establish
behavior after tool selection; they do not establish host routing quality.

## `pack && smoke`: reproduce from the source checkout

Follow [the local release-candidate procedure](../INSTALL.md#pack--smoke-testing-an-unreleased-server).
Version 0.5.0 must be published before normal registry-backed plugin installation.
The local tarball override tests the release candidate without changing the
archive's pinned command. Packaging and validation do not publish a release,
install globally, or alter existing user proof modules.
