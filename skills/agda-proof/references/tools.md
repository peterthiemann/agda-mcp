# agda-mcp tool contract

These are server tool names; use the installed client's prefix. All input objects are strict. Strings used as handles must be nonempty and originate from server results.

## Shared arguments and results

The 13 non-job tools accept optional `timeoutMs` (positive integer), `deferAfterMs` (nonnegative integer, capped by configured maximum wait), `async` (boolean; true always defers, false blocks), and `includeRaw` (boolean). Native events are normally omitted; request them for protocol evidence, not ordinary proof work.

Normalized results are `{data,warnings,raw}` in MCP `structuredContent`. No output JSON schemas are registered; the implementation's domain types define the shapes below. Raw contains adapter, bounded transcript/stderr metadata, and optionally events. Truncation metadata is not a proof failure. Pending calls instead return `{status:"pending",job,guidance}`.

`rewrite`: `as_is | simplified | instantiated | normalised | head_normal`.
`mode`: `default | ignore_abstract | head | use_show_instance`.

## All 18 tools

Required arguments are unmarked; `?` means optional. Shared arguments above omitted here.

| Tool | Arguments | Normalized data / result |
| --- | --- | --- |
| `agda_server_info` | none | Agda executable/version/adapter/compatibility, workspace roots/sessions, capabilities including `transformationDefault` and `workspaceSelection` |
| `agda_load_module` | `modulePath`, `workspaceRoot?`, `includeContexts?`, `diagnosticsOnly?` | workspace/root/project/module/format, revision/fingerprint, `checked`, diagnostics, goals, invisibleMetavariables, Agda info, optional contexts |
| `agda_typecheck` | `workspace`, `includeContexts?`, `diagnosticsOnly?` | same module check shape; reloads active module |
| `agda_retrieve_goals` | `workspace` | workspace, revision, goals |
| `agda_retrieve_context` | `goal`, `rewrite?` | goal, goalType, context entries (originalName?, reifiedName, type, inScope), boundary? |
| `agda_retrieve_contexts` | `goals` (nonempty array), `rewrite?` | requested/succeeded/failed counts; contexts entries `{goal,ok,context?,error?}` |
| `agda_retrieve_constraints` | `workspace` | workspace, constraints (rendered, kind?, range?) |
| `agda_query_metavariables` | `workspace` | workspace, metavariables (type, visibility, handle?, range?) |
| `agda_infer_type` | `expression`, exactly one of `workspace`/`goal`, `rewrite?` | expression, type |
| `agda_normalize_expression` | `expression`, exactly one of `workspace`/`goal`, `mode?` | expression, normalized |
| `agda_case_split` | `goal`, `variables?`, `apply?` | edit result below |
| `agda_refine` | `goal`, `expression?`, `usePatternLambda?`, `apply?` | edit result below |
| `agda_auto` | `goal`, `query?`, `apply?` | edit result plus `found`, message? |
| `agda_job_await` | `job`, `waitMs?` (nonnegative integer) | normalized operation result or pending envelope; consumes completed job |
| `agda_job_await_any` | `jobs?` (array; omitted selects tracked jobs), `waitMs?` | pending `{status,jobs,guidance}` or `{status:"completed",job,result}`; failed result includes job identity |
| `agda_job_status` | `job` | job summary; does not collect |
| `agda_job_cancel` | `job` | job summary after cancellation; aborts command |
| `agda_job_list` | none | `{jobs:[job summaries]}` |

Job controls accept only their listed fields, not shared Agda call options. Job summaries contain id, tool, state (`running|succeeded|failed|cancelled`), startedAt, completedAt?, elapsedMs.

Module flags `diagnosticsOnly:true` and `includeContexts:true` are contradictory. Diagnostics-only removes goals, invisibleMetavariables, and contexts. A context batch can partially fail; session-wide failures abort the batch. Batch limit defaults to 32 and is configurable.

Goals contain handle, type, source range. Ranges contain line/column plus UTF-16 offset. Edits contain file, range, replacement, expectedSourceFingerprint. Edit results contain workspace, modulePath, edits, applied, checked, diagnostics, sourceFingerprint, restoredRevision, fresh goals. Preview results restore original on-disk state; their fresh goals refer to that state.

## Error contract

Tool failures normally set `isError:true` and return `{code,message,recoverable,details,guidance}`. Input validation can fail at MCP schema level. Ordinary type errors are diagnostics in a completed result, not necessarily tool errors. Recoverability is advice, not evidence that repeating the same call will succeed.

| Code | Response |
| --- | --- |
| `INVALID_ARGUMENT` | Correct fields, selectors, modes, or limits. |
| `PATH_OUTSIDE_WORKSPACE` | Select an authorized containing root; configuration changes require appropriate user scope. |
| `AGDA_NOT_FOUND` | Install/configure Agda and restart server. |
| `NO_ACTIVE_MODULE`, `UNKNOWN_WORKSPACE` | Load module; use returned workspace. |
| `STALE_GOAL_HANDLE` | Reload/typecheck and select fresh goal. |
| `SOURCE_CHANGED` | Synchronize from disk with load/typecheck. |
| `UNSUPPORTED_EDIT_SHAPE` | Inspect native evidence; authorized manual edit followed by typecheck. |
| `AGDA_COMMAND_REJECTED` | Inspect input/diagnostics; change request before retry. Unexpected internal exceptions also map here with recoverable false. |
| `UNSUPPORTED_AGDA_PROTOCOL` | Inspect server info/evidence; supported Agda or updated adapter required. |
| `COMMAND_TIMEOUT` | Simplify request or justify a longer timeout. |
| `PROCESS_EXITED` | Reload; restart server if repeated. |
| `OUTPUT_LIMIT_EXCEEDED` | Reduce query output or justify configured output-limit adjustment. |
| `RESTORE_FAILED` | Reload before using any old state; inspect source if mutation was attempted. |
| `UNKNOWN_JOB` | List jobs; it may be collected, expired, or wrong. |
| `JOB_CANCELLED` | Reissue original operation only if still needed, after checking mutation state. |

## Capability boundaries

One active top-level module per workspace; independent workspaces can progress concurrently. No unsaved-buffer synchronization, symbol index, definition lookup, rename, arbitrary command runner, library installer, or general filesystem-edit MCP tool is exposed. Metavariable scope is the interaction backend, not an exhaustive compiler-internal inventory. The server also publishes this skill and its supporting files as MCP resources. `skills/list` and `skills/get` return complete file manifests with SHA-256 digests; `resources/read` retrieves content. These are protocol methods, not additional Agda tools. The server supports MCP 2026-07-28 metadata-based requests and legacy initialization-based clients. Modern clients fulfil `input_required` workspace-root requests before the original operation resumes; deferred Agda jobs are a separate application-level mechanism.
