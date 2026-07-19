# Changelog

This file records notable changes to `agda-mcp`, with the most recent release
first.

## [0.2.0] - 2026-07-19

### Added

- Added opt-in non-blocking Agda operations. Calls can defer to bounded
  background jobs globally through `asyncMode` or per call through `async` and
  `deferAfterMs`.
- Added `agda_job_await`, `agda_job_await_any`, `agda_job_status`,
  `agda_job_cancel`, and `agda_job_list` for collecting and managing deferred
  work.
- Added MCP progress heartbeats and completion notifications for long-running
  operations.
- Added per-call `timeoutMs`, `includeRaw`, and `diagnosticsOnly` controls while
  preserving the original synchronous, native-raw defaults.
- Added `agda_retrieve_contexts` for bounded, ordered retrieval of several goal
  contexts in one MCP round trip, including per-goal success or failure.
- Added configuration limits for job retention and capacity, wait and deferral
  windows, abort grace, Agda installation probes, handle entropy, progress
  intervals, response shaping, and context batch size.

### Changed

- Strengthened opaque goal handles with configurable cryptographic entropy and
  load-generation binding. Every load, typecheck, module switch, process
  recovery, and edit-preview restoration now invalidates older handles, even
  when the top-level source bytes are unchanged.
- Raw Agda events can now be omitted without losing truncation and completeness
  metadata. Batched responses share one bounded raw-event budget.
- Agda installation probes now use dedicated timeout and output-buffer limits
  instead of sharing the general command timeout.
- Expanded unit, integration, property-based, and fuzz coverage for job
  lifecycle behavior, queue policy, response shaping, batching, handle safety,
  cancellation, and event-loop liveness.
- Extended the tagged-release workflow to publish to npm through an OIDC
  trusted publisher and attach the package tarball and SHA-256 checksum to the
  GitHub release.

## [0.1.0] - 2026-07-19

### Added

- Initial public release of the standalone TypeScript MCP server.
- Added long-lived `agda --interaction-json` subprocesses, one loaded top-level
  module per active workspace, and a transport-independent application layer
  exposed over stdio.
- Added tools for loading and typechecking modules, retrieving goals, contexts,
  and constraints, previewing case split, refine, and auto operations,
  normalizing expressions, inferring types, and querying metavariables.
- Added normalized responses with bounded native Agda events in `raw`, opaque
  workspace and goal handles, serialized per-workspace commands, cancellation,
  output limits, and process recovery.
- Added non-mutating, reload-after-preview edit transactions for `.agda`,
  `.lagda`, and `.lagda.md` source files.
- Added Agda installation and project discovery, including `.agda-lib` files,
  registered libraries, workspace overrides, and conservative compatibility
  handling for Agda versions other than the verified 2.8.0 adapter.
- Added unit, integration, property-based, mutation-fuzz, live-Agda, MCP stdio,
  smoke, and packed-install tests.

[0.2.0]: https://github.com/peterthiemann/agda-mcp/compare/release-0.1.0...release-0.2.0
[0.1.0]: https://github.com/peterthiemann/agda-mcp/releases/tag/release-0.1.0
