import type { NormalizationMode, RewriteMode } from "../application/domain.js";

export interface AgdaProtocolPosition {
  readonly offset: number;
  readonly line: number;
  readonly column: number;
}

export interface AgdaProtocolRange {
  readonly file: string;
  readonly start: AgdaProtocolPosition;
  readonly end: AgdaProtocolPosition;
}

interface GoalCommand {
  readonly interactionPoint: number;
  readonly range?: AgdaProtocolRange;
}

export type AgdaCommand =
  | { readonly kind: "load"; readonly modulePath: string; readonly arguments: readonly string[] }
  | { readonly kind: "metas"; readonly rewrite?: RewriteMode }
  | (GoalCommand & { readonly kind: "goalTypeContext"; readonly rewrite?: RewriteMode })
  | { readonly kind: "constraints" }
  | (GoalCommand & { readonly kind: "makeCase"; readonly variables?: string })
  | (GoalCommand & {
      readonly kind: "refineOrIntro";
      readonly expression?: string;
      readonly usePatternLambda?: boolean;
    })
  | (GoalCommand & { readonly kind: "autoOne"; readonly query?: string })
  | (GoalCommand & {
      readonly kind: "compute";
      readonly expression: string;
      readonly mode?: NormalizationMode;
    })
  | { readonly kind: "computeTopLevel"; readonly expression: string; readonly mode?: NormalizationMode }
  | (GoalCommand & {
      readonly kind: "infer";
      readonly expression: string;
      readonly rewrite?: RewriteMode;
    })
  | { readonly kind: "inferTopLevel"; readonly expression: string; readonly rewrite?: RewriteMode }
  | { readonly kind: "abort" };

export interface AgdaCommandContext {
  readonly currentFile: string;
}

export type NativeAgdaEvent = Readonly<Record<string, unknown>>;

export interface AgdaProtocolAdapter {
  readonly id: string;
  readonly agdaVersion: string;
  encodeCommand(command: AgdaCommand, context: AgdaCommandContext): string;
  decodeEvent(value: unknown): NativeAgdaEvent;
}
