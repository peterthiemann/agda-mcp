import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import type { AgdaService } from "../application/agdaService.js";
import { parseServerOptions, type ServerOptions } from "../application/config.js";
import type { NormalizedResult } from "../application/domain.js";
import { ApplicationError, isApplicationError } from "../application/errors.js";
import { AgdaApplicationService } from "../application/service.js";
import { VERSION } from "../version.js";
import {
  loadModuleInputSchema,
  serverInfoInputSchema,
  workspaceInputSchema,
} from "./toolSchemas.js";

export type AgdaServiceProvider = () => Promise<AgdaService>;

function jsonObject(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function successfulToolResult(value: NormalizedResult<unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: jsonObject(value),
  };
}

function failedToolResult(error: unknown) {
  const applicationError = isApplicationError(error)
    ? error
    : new ApplicationError("AGDA_COMMAND_REJECTED", "Unexpected Agda MCP failure", {
        recoverable: false,
      });
  const body = {
    code: applicationError.code,
    message: applicationError.message,
    recoverable: applicationError.recoverable,
    details: applicationError.details,
  };
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(body) }],
  };
}

async function invoke(
  operation: () => Promise<NormalizedResult<unknown>>,
) {
  try {
    return successfulToolResult(await operation());
  } catch (error: unknown) {
    return failedToolResult(error);
  }
}

export function createAgdaMcpServer(serviceProvider: AgdaServiceProvider): McpServer {
  const server = new McpServer({ name: "agda-mcp", version: VERSION });

  server.registerTool(
    "agda_server_info",
    {
      description: "Report the detected Agda installation, compatibility, and active workspaces",
      inputSchema: serverInfoInputSchema,
    },
    async (_input, extra) =>
      invoke(async () => (await serviceProvider()).serverInfo({ signal: extra.signal })),
  );

  server.registerTool(
    "agda_load_module",
    {
      description: "Load and typecheck one top-level Agda module from disk",
      inputSchema: loadModuleInputSchema,
    },
    async ({ modulePath }, extra) =>
      invoke(async () =>
        (await serviceProvider()).loadModule({ modulePath }, { signal: extra.signal }),
      ),
  );

  server.registerTool(
    "agda_typecheck",
    {
      description: "Reload and typecheck the active module in a workspace",
      inputSchema: workspaceInputSchema,
    },
    async ({ workspace }, extra) =>
      invoke(async () =>
        (await serviceProvider()).typecheck({ workspace }, { signal: extra.signal }),
      ),
  );

  return server;
}

function environmentOptions(environment: NodeJS.ProcessEnv): ServerOptions {
  const encoded = environment.AGDA_MCP_OPTIONS;
  if (encoded === undefined || encoded.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded) as unknown;
  } catch (error: unknown) {
    throw new ApplicationError("INVALID_ARGUMENT", "AGDA_MCP_OPTIONS must contain valid JSON", {
      cause: error,
    });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ApplicationError("INVALID_ARGUMENT", "AGDA_MCP_OPTIONS must contain a JSON object");
  }
  return parsed as ServerOptions;
}

async function clientWorkspaceRoots(server: McpServer): Promise<readonly string[]> {
  if (server.server.getClientCapabilities()?.roots === undefined) return [];
  const result = await server.server.listRoots();
  return result.roots
    .filter((root) => root.uri.startsWith("file:"))
    .map((root) => fileURLToPath(root.uri));
}

export interface StdioServerOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly cwd?: string;
}

export async function runStdioServer(options: StdioServerOptions = {}): Promise<void> {
  const environment = options.environment ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  let server!: McpServer;
  let servicePromise: Promise<AgdaApplicationService> | undefined;
  const serviceProvider = async (): Promise<AgdaApplicationService> => {
    servicePromise ??= (async () => {
      const configured = environmentOptions(environment);
      const roots = configured.workspaceRoots ?? (await clientWorkspaceRoots(server));
      return AgdaApplicationService.create(
        parseServerOptions({
          ...configured,
          workspaceRoots: roots.length === 0 ? [cwd] : roots,
        }),
      );
    })();
    return servicePromise;
  };
  server = createAgdaMcpServer(serviceProvider);
  const transport = new StdioServerTransport();
  transport.onclose = () => {
    void servicePromise?.then((service) => service.shutdown());
  };
  await server.connect(transport);
}
