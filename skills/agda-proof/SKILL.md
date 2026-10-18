---
name: agda-proof
description: >-
  Develop and inspect on-disk Agda proofs with agda-mcp: typecheck modules, inspect holes and constraints, infer or normalize expressions, and refine, case split, or search for proofs. Use for Agda source and interaction failures; not Lean, Coq, general dependent-type explanations, or development of the MCP server itself.
---

# Agda proof development

Use the connected agda-mcp tools for semantic operations. Tool prefixes depend on the client; names below are the server's tool names. This skill requires an agda-mcp connection and a separately installed Agda; if unavailable, report that prerequisite rather than inventing results.

## `load`: establish state

Call `agda_server_info` first to inspect compatibility, workspace selection, and transformation policy. Agda 2.8.0 is verified; other versions are unverified, not automatically unusable.

Save intended source changes before loading: this server reads disk, not editor buffers. Call `agda_load_module` with an absolute `modulePath` (`.agda`, `.lagda`, or `.lagda.md`). In request workspace mode also supply an absolute containing `workspaceRoot`; otherwise use a configured root. A workspace handle is an opaque returned value, never a directory name.

For proof work prefer `includeContexts:true`. For a compile-only question use `diagnosticsOnly:true`; do not combine these flags. Inspect `structuredContent`, including warnings and diagnostics; text content is only a summary. A completed request does not establish success: check `data.checked`.

## `inspect`: choose the semantic query

Reuse goals and contexts already returned by load/typecheck. Use `agda_retrieve_context` for one goal, `agda_retrieve_contexts` for several (nonempty list; default batch maximum 32). Inspect each batch entry's `ok` and `error`; aggregate success does not guarantee every context succeeded.

Use `agda_retrieve_goals` for current visible holes, `agda_retrieve_constraints` for blocked equalities, and `agda_query_metavariables` for visible and backend-published invisible metas. Invisible metas may lack handles and are not automatically editable goals.

Use `agda_infer_type` for types and `agda_normalize_expression` for reduction, with a nonempty `expression` and exactly one selector: `goal` for local bindings or `workspace` for top-level scope. Do not approximate these operations with text search. Read [the tool contract](references/tools.md) for modes, output fields, and job controls.

## `edit && check`: transform and verify

Choose `agda_refine` for giving an expression or introducing structure (empty/omitted expression), `agda_case_split` for pattern variables (empty/omitted `variables` splits the result), or `agda_auto` for proof search (`query` contains Agda search options).

Prefer the MCP server’s mutating operations for incremental Agda development: use `agda_refine`, `agda_case_split`, and `agda_auto` with `apply:true` for authorized proof edits. Develop one step at a time, inspect the returned diagnostics and fresh goals, then choose the next operation. These operations guard the source fingerprint, apply the proposal atomically, and typecheck in one operation. Prefer this workflow over manually applying previews or editing hole text directly; use ordinary source edits for changes the MCP operations do not support. For an explicit inspection/preview request pass `apply:false`, even if the server defaults to applying. Report `applied`, `checked`, diagnostics, and remaining goals. `auto.found:false` is a search outcome, not a solved proof. A preview's `checked` describes the restored source, not validation of the proposed edit. An applied edit with ordinary type errors can remain on disk (`applied:true`, `checked:false`); do not claim rollback.

Every transformation, including previews, reloads canonical state. Reloads, module switches, recovery, and transformations invalidate older goal handles. Use only handles from the newest result; do not queue several edits against old holes. After an external edit call `agda_typecheck` with the workspace handle before using goals again. Prefer returned semantic edits to guessing textual replacements. If a client applies a preview itself, verify each edit's expected SHA-256 fingerprint, preserve its exact UTF-16 ranges and literate code boundaries, then typecheck.

A clean verdict alone does not mean proof completion: also inspect remaining goals, metavariables, constraints, and warnings relevant to the user's claim. Do not introduce postulates or permissive flags to make a requested proof pass.

## `wait`: finish deferred work

Any Agda operation can return `status:"pending"`; retain `job.id` and collect with `agda_job_await`. Do useful independent work between bounded waits rather than restarting the operation. Across independent workspaces use `agda_job_await_any`; its completed envelope nests the normalized response under `result`. Commands in one workspace are serialized and share one active module. Use status/list to inspect work and cancel only jobs the task should abandon. Collection consumes a completed job; do not collect it twice.

## `recover`: act on evidence

Read `isError` and the structured error's `code`, `details`, `recoverable`, and `guidance`. Schema failures may instead be MCP validation errors. Correct invalid arguments before retrying. For `SOURCE_CHANGED` or `STALE_GOAL_HANDLE`, reload/typecheck and reselect the intended goal from fresh state. For unknown workspace or no active module, load again. After `RESTORE_FAILED` or a process exit reload before trusting prior state.

For unsupported edit shapes, inspect evidence and use a carefully scoped source edit if authorized, then typecheck. Do not force an ambiguous literate edit. For missing Agda, unsupported protocol, or unauthorized roots explain the required setup; do not silently expand access. For timeouts/output limits simplify or adjust the relevant limit only when justified. Do not blindly retry mutations after uncertain failure: inspect disk and reload first. Stop repeating an unchanged failing call. See [error details](references/tools.md#error-contract).
