import { VERSION } from "./version.js";
import { runStdioServer } from "./mcp/stdioServer.js";

export interface CliWriter {
  write(chunk: string): void;
}

export interface CliIo {
  stdout: CliWriter;
  stderr: CliWriter;
}

const HELP_TEXT = `agda-mcp ${VERSION}

Usage:
  agda-mcp
  agda-mcp --help
  agda-mcp --version

Agda MCP server for on-disk .agda, .lagda, and .lagda.md modules.

Options:
  -h, --help     Show this help text
  -V, --version  Show the package version
`;

export interface CliDependencies {
  readonly startServer?: () => Promise<void>;
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

  if (args.length > 0) {
    io.stderr.write(`agda-mcp: unknown arguments: ${args.join(" ")}\n`);
    io.stderr.write("Run agda-mcp --help for usage.\n");
    return 2;
  }

  await (dependencies.startServer ?? runStdioServer)();
  return 0;
}
