import { ApplicationError } from "../../application/errors.js";
import type { NormalizationMode, RewriteMode } from "../../application/domain.js";
import type {
  AgdaCommand,
  AgdaCommandContext,
  AgdaProtocolAdapter,
  AgdaProtocolPosition,
  AgdaProtocolRange,
  NativeAgdaEvent,
} from "../adapter.js";
import { encodeHaskellString, encodeHaskellStringList } from "../stringEncoder.js";

const REWRITE_MODES: Readonly<Record<RewriteMode, string>> = {
  as_is: "AsIs",
  simplified: "Simplified",
  instantiated: "Instantiated",
  normalised: "Normalised",
  head_normal: "HeadNormal",
};

const COMPUTE_MODES: Readonly<Record<NormalizationMode, string>> = {
  default: "DefaultCompute",
  ignore_abstract: "IgnoreAbstract",
  head: "HeadCompute",
  use_show_instance: "UseShowInstance",
};

function invalid(message: string, details: Readonly<Record<string, unknown>> = {}): never {
  throw new ApplicationError("INVALID_ARGUMENT", message, { details });
}

function validatePosition(position: AgdaProtocolPosition, label: string): void {
  for (const [field, value] of Object.entries(position)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      invalid(`${label}.${field} must be a positive safe integer`, { label, field, value });
    }
  }
}

function encodePosition(position: AgdaProtocolPosition): string {
  validatePosition(position, "position");
  return `(Pn () ${position.offset} ${position.line} ${position.column})`;
}

function encodeRange(range: AgdaProtocolRange | undefined): string {
  if (range === undefined) return "noRange";
  if (range.file === "") invalid("Protocol range file must not be empty");
  validatePosition(range.start, "range.start");
  validatePosition(range.end, "range.end");
  if (range.end.offset < range.start.offset) invalid("Protocol range end precedes its start");
  return `(intervalsToRange (Just (mkAbsolute ${encodeHaskellString(range.file)})) ` +
    `[Interval () ${encodePosition(range.start)} ${encodePosition(range.end)}])`;
}

function interactionPoint(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    invalid("interactionPoint must be a non-negative safe integer", { interactionPoint: value });
  }
  return String(value);
}

function goalArguments(
  command: { readonly interactionPoint: number; readonly range?: AgdaProtocolRange },
  input: string,
): string {
  return `${interactionPoint(command.interactionPoint)} ${encodeRange(command.range)} ${encodeHaskellString(input)}`;
}

function rewriteMode(mode: RewriteMode | undefined, fallback: RewriteMode): string {
  return REWRITE_MODES[mode ?? fallback];
}

function computeMode(mode: NormalizationMode | undefined): string {
  return COMPUTE_MODES[mode ?? "default"];
}

function encodeBody(command: AgdaCommand): string {
  switch (command.kind) {
    case "load":
      return `Cmd_load ${encodeHaskellString(command.modulePath)} ${encodeHaskellStringList(command.arguments)}`;
    case "metas":
      return `Cmd_metas ${rewriteMode(command.rewrite, "as_is")}`;
    case "goalTypeContext":
      return `Cmd_goal_type_context ${rewriteMode(command.rewrite, "simplified")} ${goalArguments(command, "")}`;
    case "constraints":
      return "Cmd_constraints";
    case "makeCase":
      return `Cmd_make_case ${goalArguments(command, command.variables ?? "")}`;
    case "refineOrIntro":
      return `Cmd_refine_or_intro ${command.usePatternLambda === true ? "True" : "False"} ${goalArguments(command, command.expression ?? "")}`;
    case "autoOne":
      return `Cmd_autoOne AsIs ${goalArguments(command, command.query ?? "")}`;
    case "compute":
      return `Cmd_compute ${computeMode(command.mode)} ${goalArguments(command, command.expression)}`;
    case "computeTopLevel":
      return `Cmd_compute_toplevel ${computeMode(command.mode)} ${encodeHaskellString(command.expression)}`;
    case "infer":
      return `Cmd_infer ${rewriteMode(command.rewrite, "simplified")} ${goalArguments(command, command.expression)}`;
    case "inferTopLevel":
      return `Cmd_infer_toplevel ${rewriteMode(command.rewrite, "simplified")} ${encodeHaskellString(command.expression)}`;
    case "abort":
      return "Cmd_abort";
  }
}

export const agda280Adapter: AgdaProtocolAdapter = Object.freeze({
  id: "agda-2.8.0",
  agdaVersion: "2.8.0",
  encodeCommand(command: AgdaCommand, context: AgdaCommandContext): string {
    if (context.currentFile === "") invalid("currentFile must not be empty");
    return `IOTCM ${encodeHaskellString(context.currentFile)} None Direct (${encodeBody(command)})\n`;
  },
  decodeEvent(value: unknown): NativeAgdaEvent {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new ApplicationError("UNSUPPORTED_AGDA_PROTOCOL", "Agda JSON event must be an object", {
        details: { value },
      });
    }
    return value as NativeAgdaEvent;
  },
});
