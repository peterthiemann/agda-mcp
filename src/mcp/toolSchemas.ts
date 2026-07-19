import * as z from "zod/v4";

export const serverInfoInputSchema = z.object({}).strict();

export const loadModuleInputSchema = z
  .object({
    modulePath: z.string().min(1).describe("Absolute path to an .agda, .lagda, or .lagda.md file"),
  })
  .strict();

export const workspaceInputSchema = z
  .object({
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
    goal: z.string().min(1).describe("Opaque goal handle returned by the latest module state"),
  })
  .strict();

export const contextInputSchema = z
  .object({
    goal: z.string().min(1).describe("Opaque goal handle returned by the latest module state"),
    rewrite: rewriteModeSchema.optional(),
  })
  .strict();

export const caseSplitInputSchema = z
  .object({
    goal: z.string().min(1).describe("Opaque goal handle returned by the latest module state"),
    variables: z.string().optional().describe("Pattern variables to split; empty splits the result"),
  })
  .strict();

export const refineInputSchema = z
  .object({
    goal: z.string().min(1).describe("Opaque goal handle returned by the latest module state"),
    expression: z.string().optional().describe("Expression to give; empty or omitted requests intro/refine"),
    usePatternLambda: z.boolean().optional(),
  })
  .strict();

export const autoInputSchema = z
  .object({
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
