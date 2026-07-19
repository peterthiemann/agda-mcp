# agda-mcp

`agda-mcp` is a work-in-progress, non-mutating MCP server for Agda's JSON
interaction protocol. It will support on-disk `.agda`, `.lagda`, and
`.lagda.md` modules through a long-lived Agda subprocess per workspace.

The repository currently implements P0 through P3 of the
[implementation plan](./IMPLEMENTATION_PLAN.md): package/discovery foundations,
the Agda 2.8.0 protocol host, workspace sessions and opaque goal handles, and
the first stdio MCP tools (`agda_server_info`, `agda_load_module`, and
`agda_typecheck`). The transport-independent service also implements the P4
goal, context, constraint, metavariable, normalization, and inference queries.

## Requirements

- Node.js 22 or newer
- npm
- Agda 2.8.0 for baseline integration tests

Agda is an external runtime dependency and is not bundled in the npm package.

## Development

```sh
npm ci
npm run typecheck
npm test
npm run test:fuzz
npm run test:integration
npm run build
npm run smoke
npm pack --dry-run
```

Normal logs and child-process diagnostics will use stderr. Once the MCP server
is enabled, stdout will be reserved exclusively for MCP protocol framing.

### Protocol parser fuzzing

`npm run test:fuzz` combines grammar-aware property tests with deterministic
mutation and arbitrary-byte fuzzing. The default campaign runs 1,000 cases per
property, 5,000 recorded-corpus mutations, and 1,250 arbitrary byte streams.
Failures report a reproducible seed; property failures also report fast-check's
shrink path.

The campaign size and seed can be overridden for longer local or scheduled
runs:

```sh
AGDA_MCP_PROPERTY_RUNS=10000 \
AGDA_MCP_FUZZ_RUNS=50000 \
AGDA_MCP_FUZZ_SEED=685383720 \
npm run test:fuzz
```

## Design

- [Initial design](./DESIGN.md)
- [Implementation plan](./IMPLEMENTATION_PLAN.md)
