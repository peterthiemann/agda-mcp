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
  autoInputSchema,
  caseSplitInputSchema,
  contextInputSchema,
  inferTypeInputSchema,
  loadModuleInputSchema,
  normalizeExpressionInputSchema,
  refineInputSchema,
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

const RECOVERY_GUIDANCE = Object.freeze({
  INVALID_ARGUMENT: "Correct the tool arguments and retry.",
  PATH_OUTSIDE_WORKSPACE: "Choose a module inside a configured MCP workspace root.",
  AGDA_NOT_FOUND: "Install Agda or configure agdaExecutable, then restart the MCP server.",
  NO_ACTIVE_MODULE: "Call agda_load_module before using this workspace operation.",
  UNKNOWN_WORKSPACE: "Call agda_load_module and use the workspace handle it returns.",
  STALE_GOAL_HANDLE: "Reload or typecheck the module and use a goal handle from the newest result.",
  SOURCE_CHANGED: "Call agda_typecheck or agda_load_module to synchronize with the file on disk.",
  UNSUPPORTED_EDIT_SHAPE: "Inspect raw events and edit this source shape manually.",
  AGDA_COMMAND_REJECTED: "Review the command input and Agda diagnostics, then retry if appropriate.",
  UNSUPPORTED_AGDA_PROTOCOL: "Check agda_server_info; install a supported Agda version or update agda-mcp.",
  COMMAND_TIMEOUT: "Retry after simplifying the request or increasing the configured timeout.",
  PROCESS_EXITED: "Retry by loading the module again; restart the MCP server if the failure persists.",
  OUTPUT_LIMIT_EXCEEDED: "Reduce the query output or increase the configured output limit.",
  RESTORE_FAILED: "Load the module again before using any prior workspace or goal handle.",
} satisfies Record<ApplicationError["code"], string>);

export function applicationErrorPayload(error: unknown) {
  const applicationError = isApplicationError(error)
    ? error
    : new ApplicationError("AGDA_COMMAND_REJECTED", "Unexpected Agda MCP failure", {
        recoverable: false,
      });
  return Object.freeze({
    code: applicationError.code,
    message: applicationError.message,
    recoverable: applicationError.recoverable,
    details: applicationError.details,
    guidance: RECOVERY_GUIDANCE[applicationError.code],
  });
}

function failedToolResult(error: unknown) {
  const body = applicationErrorPayload(error);
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(body) }],
    structuredContent: jsonObject(body),
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

  server.registerTool(
    "agda_retrieve_goals",
    {
      description: "Retrieve the current visible goals and opaque handles",
      inputSchema: workspaceInputSchema,
    },
    async ({ workspace }, extra) =>
      invoke(async () =>
        (await serviceProvider()).retrieveGoals({ workspace }, { signal: extra.signal }),
      ),
  );

  server.registerTool(
    "agda_retrieve_context",
    {
      description: "Retrieve the type and local context for an opaque goal handle",
      inputSchema: contextInputSchema,
    },
    async ({ goal, rewrite }, extra) =>
      invoke(async () =>
        (await serviceProvider()).retrieveContext(
          { goal, ...(rewrite === undefined ? {} : { rewrite }) },
          { signal: extra.signal },
        ),
      ),
  );

  server.registerTool(
    "agda_retrieve_constraints",
    {
      description: "Retrieve constraints for the active module in a workspace",
      inputSchema: workspaceInputSchema,
    },
    async ({ workspace }, extra) =>
      invoke(async () =>
        (await serviceProvider()).retrieveConstraints({ workspace }, { signal: extra.signal }),
      ),
  );

  server.registerTool(
    "agda_case_split",
    {
      description: "Preview a non-mutating case split, then reload canonical Agda state",
      inputSchema: caseSplitInputSchema,
    },
    async ({ goal, variables }, extra) =>
      invoke(async () =>
        (await serviceProvider()).caseSplit(
          { goal, ...(variables === undefined ? {} : { variables }) },
          { signal: extra.signal },
        ),
      ),
  );

  server.registerTool(
    "agda_refine",
    {
      description: "Preview a non-mutating refinement, then reload canonical Agda state",
      inputSchema: refineInputSchema,
    },
    async ({ goal, expression, usePatternLambda }, extra) =>
      invoke(async () =>
        (await serviceProvider()).refine(
          {
            goal,
            ...(expression === undefined ? {} : { expression }),
            ...(usePatternLambda === undefined ? {} : { usePatternLambda }),
          },
          { signal: extra.signal },
        ),
      ),
  );

  server.registerTool(
    "agda_auto",
    {
      description: "Preview non-mutating Agda proof search, then reload canonical state",
      inputSchema: autoInputSchema,
    },
    async ({ goal, query }, extra) =>
      invoke(async () =>
        (await serviceProvider()).auto(
          { goal, ...(query === undefined ? {} : { query }) },
          { signal: extra.signal },
        ),
      ),
  );

  server.registerTool(
    "agda_normalize_expression",
    {
      description: "Normalize an expression in workspace or goal-local scope",
      inputSchema: normalizeExpressionInputSchema,
    },
    async ({ expression, workspace, goal, mode }, extra) =>
      invoke(async () =>
        (await serviceProvider()).normalizeExpression(
          {
            expression,
            ...(workspace === undefined ? {} : { workspace }),
            ...(goal === undefined ? {} : { goal }),
            ...(mode === undefined ? {} : { mode }),
          },
          { signal: extra.signal },
        ),
      ),
  );

  server.registerTool(
    "agda_infer_type",
    {
      description: "Infer the type of an expression in workspace or goal-local scope",
      inputSchema: inferTypeInputSchema,
    },
    async ({ expression, workspace, goal, rewrite }, extra) =>
      invoke(async () =>
        (await serviceProvider()).inferType(
          {
            expression,
            ...(workspace === undefined ? {} : { workspace }),
            ...(goal === undefined ? {} : { goal }),
            ...(rewrite === undefined ? {} : { rewrite }),
          },
          { signal: extra.signal },
        ),
      ),
  );

  server.registerTool(
    "agda_query_metavariables",
    {
      description: "Query visible and interaction-backend invisible metavariables",
      inputSchema: workspaceInputSchema,
    },
    async ({ workspace }, extra) =>
      invoke(async () =>
        (await serviceProvider()).queryMetavariables({ workspace }, { signal: extra.signal }),
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
