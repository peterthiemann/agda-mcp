import { VERSION } from "./version.js";
import { runStdioServer, type StdioServerOptions } from "./mcp/stdioServer.js";

export interface CliWriter {
  write(chunk: string): void;
}

export interface CliIo {
  stdout: CliWriter;
  stderr: CliWriter;
}

const HELP_TEXT = `agda-mcp ${VERSION}

Usage:
  agda-mcp [--apply-edits] [--dynamic-workspaces]
  agda-mcp --help
  agda-mcp --version

Agda MCP server for on-disk .agda, .lagda, and .lagda.md modules.

Options:
      --apply-edits         Apply and typecheck transformations in place by default
      --dynamic-workspaces  Allow load requests to select their workspace root
  -h, --help                Show this help text
  -V, --version             Show the package version
`;

export interface CliDependencies {
  readonly startServer?: (options?: StdioServerOptions) => Promise<void>;
}

export async function runCli(
  args: readonly string[],
  io: CliIo,
  dependencies: CliDependencies = {},
): Promise<number> {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    io.stdout.write(HELP_TEXT);
    return 0;
  }

  if (args.length === 1 && (args[0] === "--version" || args[0] === "-V")) {
    io.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const supportedFlags = new Set(["--apply-edits", "--dynamic-workspaces"]);
  const unknown = args.filter((argument) => !supportedFlags.has(argument));
  if (unknown.length > 0) {
    io.stderr.write(`agda-mcp: unknown arguments: ${unknown.join(" ")}\n`);
    io.stderr.write("Run agda-mcp --help for usage.\n");
    return 2;
  }

  const applyEdits = args.includes("--apply-edits");
  const dynamicWorkspaces = args.includes("--dynamic-workspaces");
  const serverOptions = {
    ...(applyEdits ? { applyEditsByDefault: true } : {}),
    ...(dynamicWorkspaces ? { allowDynamicWorkspaces: true } : {}),
  };
  await (dependencies.startServer ?? runStdioServer)(
    Object.keys(serverOptions).length === 0 ? undefined : { serverOptions },
  );
  return 0;
}
