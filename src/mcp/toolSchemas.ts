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
