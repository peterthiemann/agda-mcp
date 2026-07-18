# agda-mcp

`agda-mcp` is a work-in-progress, non-mutating MCP server for Agda's JSON
interaction protocol. It will support on-disk `.agda`, `.lagda`, and
`.lagda.md` modules through a long-lived Agda subprocess per workspace.

The repository currently contains the package foundation described by P0 of
the [implementation plan](./IMPLEMENTATION_PLAN.md). The stdio MCP server and
Agda interaction tools are implemented in later phases.

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
npm run test:integration
npm run build
npm run smoke
npm pack --dry-run
```

Normal logs and child-process diagnostics will use stderr. Once the MCP server
is enabled, stdout will be reserved exclusively for MCP protocol framing.

## Design

- [Initial design](./DESIGN.md)
- [Implementation plan](./IMPLEMENTATION_PLAN.md)
