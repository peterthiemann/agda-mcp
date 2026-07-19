import * as z from "zod/v4";

/**
 * Per-call overrides available on every Agda tool. They shadow the
 * corresponding AGDA_MCP_OPTIONS values for one call only.
 */
export const callOptionFields = {
  timeoutMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Override the configured Agda command timeout for this call"),
  deferAfterMs: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("How long this call may block before returning a job handle; capped by maxJobWaitMs"),
  async: z
    .boolean()
    .optional()
    .describe("true always returns a job handle; false blocks until Agda finishes"),
  includeRaw: z
    .boolean()
    .optional()
    .describe("Include Agda's native event log; omitted by default because it is large"),
};

/** Extra fields for the two module-checking tools. */
export const moduleCheckOptionFields = {
  diagnosticsOnly: z
    .boolean()
    .optional()
    .describe("Return only errors and warnings, dropping goals and metavariables"),
};

export const serverInfoInputSchema = z.object({ ...callOptionFields }).strict();

export const jobInputSchema = z
  .object({
    job: z.string().min(1).describe("Job id returned by a pending tool result"),
    waitMs: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Milliseconds to wait for completion before returning pending again"),
  })
  .strict();

export const jobIdInputSchema = z
  .object({
    job: z.string().min(1).describe("Job id returned by a pending tool result"),
  })
  .strict();

export const jobListInputSchema = z.object({}).strict();

export const jobAwaitAnyInputSchema = z
  .object({
    jobs: z
      .array(z.string().min(1))
      .optional()
      .describe("Job ids to race; omit to await every tracked job"),
    waitMs: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Milliseconds to wait for the first completion before returning pending"),
  })
  .strict();

export const loadModuleInputSchema = z
  .object({
    ...callOptionFields,
    ...moduleCheckOptionFields,
    modulePath: z.string().min(1).describe("Absolute path to an .agda, .lagda, or .lagda.md file"),
  })
  .strict();

export const workspaceInputSchema = z
  .object({
    ...callOptionFields,
    ...moduleCheckOptionFields,
    workspace: z.string().min(1).describe("Opaque workspace handle returned by agda_load_module"),
  })
  .strict();

export const rewriteModeSchema = z.enum([
  "as_is",
  "simplified",
  "instantiated",
  "normalised",
  "head_normal",
]);

export const normalizationModeSchema = z.enum([
  "default",
  "ignore_abstract",
  "head",
  "use_show_instance",
]);

export const goalInputSchema = z
  .object({
    ...callOptionFields,
    goal: z.string().min(1).describe("Opaque goal handle returned by the latest module state"),
  })
  .strict();

export const contextInputSchema = z
  .object({
    ...callOptionFields,
    goal: z.string().min(1).describe("Opaque goal handle returned by the latest module state"),
    rewrite: rewriteModeSchema.optional(),
  })
  .strict();

export const contextsInputSchema = z
  .object({
    ...callOptionFields,
    goals: z
      .array(z.string().min(1))
      .min(1)
      .describe("Goal handles to fetch contexts for, in one round trip"),
    rewrite: rewriteModeSchema.optional(),
  })
  .strict();

export const caseSplitInputSchema = z
  .object({
    ...callOptionFields,
    goal: z.string().min(1).describe("Opaque goal handle returned by the latest module state"),
    variables: z.string().optional().describe("Pattern variables to split; empty splits the result"),
  })
  .strict();

export const refineInputSchema = z
  .object({
    ...callOptionFields,
    goal: z.string().min(1).describe("Opaque goal handle returned by the latest module state"),
    expression: z.string().optional().describe("Expression to give; empty or omitted requests intro/refine"),
    usePatternLambda: z.boolean().optional(),
  })
  .strict();

export const autoInputSchema = z
  .object({
    ...callOptionFields,
    goal: z.string().min(1).describe("Opaque goal handle returned by the latest module state"),
    query: z.string().optional().describe("Agda auto search options"),
  })
  .strict();

const scopedExpressionFields = {
  expression: z.string().min(1),
  workspace: z.string().min(1).optional(),
  goal: z.string().min(1).optional(),
};

export const normalizeExpressionInputSchema = z
  .object({
    ...scopedExpressionFields,
    ...callOptionFields,
    mode: normalizationModeSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.workspace === undefined) === (value.goal === undefined)) {
      context.addIssue({
        code: "custom",
        message: "Exactly one of workspace or goal must be provided",
        path: [],
        input: value,
      });
    }
  });

export const inferTypeInputSchema = z
  .object({
    ...scopedExpressionFields,
    ...callOptionFields,
    rewrite: rewriteModeSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.workspace === undefined) === (value.goal === undefined)) {
      context.addIssue({
        code: "custom",
        message: "Exactly one of workspace or goal must be provided",
        path: [],
        input: value,
      });
    }
  });
