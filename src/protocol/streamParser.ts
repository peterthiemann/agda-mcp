import { StringDecoder } from "node:string_decoder";

import { ApplicationError } from "../application/errors.js";

const PROMPT = "JSON>";

export type InteractionJsonToken =
  | { readonly kind: "prompt" }
  | { readonly kind: "event"; readonly value: unknown; readonly raw: string }
  | { readonly kind: "stdout"; readonly text: string };

export class InteractionJsonStreamParser {
  readonly #decoder = new StringDecoder("utf8");
  #outside = "";
  #outsideIsStdout = false;
  #json = "";
  #depth = 0;
  #inString = false;
  #escaped = false;
  #ended = false;

  feed(chunk: Buffer | string): readonly InteractionJsonToken[] {
    if (this.#ended) {
      throw new ApplicationError("UNSUPPORTED_AGDA_PROTOCOL", "Cannot feed a completed protocol parser");
    }
    const text = typeof chunk === "string" ? chunk : this.#decoder.write(chunk);
    return this.#process(text);
  }

  end(chunk?: Buffer | string): readonly InteractionJsonToken[] {
    if (this.#ended) return [];
    const tokens: InteractionJsonToken[] = [];
    if (chunk !== undefined) tokens.push(...this.feed(chunk));
    tokens.push(...this.#process(this.#decoder.end()));
    this.#ended = true;
    if (this.#json !== "") {
      throw new ApplicationError("UNSUPPORTED_AGDA_PROTOCOL", "Agda stdout ended inside a JSON event", {
        details: { partialBytes: Buffer.byteLength(this.#json) },
      });
    }
    this.#emitOutside(tokens);
    return tokens;
  }

  #process(text: string): InteractionJsonToken[] {
    const tokens: InteractionJsonToken[] = [];
    for (const character of text) {
      if (this.#json !== "") {
        this.#consumeJsonCharacter(character, tokens);
      } else {
        this.#consumeOutsideCharacter(character, tokens);
      }
    }
    this.#flushSafeOutside(tokens);
    return tokens;
  }

  #consumeOutsideCharacter(character: string, tokens: InteractionJsonToken[]): void {
    if (character === "{" && !this.#outsideIsStdout && this.#outside.trim() === "") {
      this.#outside = "";
      this.#json = "{";
      this.#depth = 1;
      this.#inString = false;
      this.#escaped = false;
      return;
    }

    this.#outside += character;
    if (character === "\n" || character === "\r") {
      this.#emitOutside(tokens);
      return;
    }

    if (!this.#outsideIsStdout && this.#outside.trim() === PROMPT) {
      this.#outside = "";
      tokens.push({ kind: "prompt" });
    }
  }

  #consumeJsonCharacter(character: string, tokens: InteractionJsonToken[]): void {
    this.#json += character;
    if (this.#inString) {
      if (this.#escaped) {
        this.#escaped = false;
      } else if (character === "\\") {
        this.#escaped = true;
      } else if (character === '"') {
        this.#inString = false;
      }
      return;
    }

    if (character === '"') {
      this.#inString = true;
      return;
    }
    if (character === "{" || character === "[") this.#depth += 1;
    if (character === "}" || character === "]") this.#depth -= 1;
    if (this.#depth < 0) this.#invalidJson("Unexpected JSON closing delimiter");
    if (this.#depth !== 0) return;

    const raw = this.#json;
    this.#json = "";
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch (error: unknown) {
      throw new ApplicationError("UNSUPPORTED_AGDA_PROTOCOL", "Agda emitted invalid JSON", {
        details: { raw },
        cause: error,
      });
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      this.#invalidJson("Agda JSON event must be an object", { value });
    }
    tokens.push({ kind: "event", value, raw });
  }

  #invalidJson(message: string, details: Readonly<Record<string, unknown>> = {}): never {
    throw new ApplicationError("UNSUPPORTED_AGDA_PROTOCOL", message, { details });
  }

  #flushSafeOutside(tokens: InteractionJsonToken[]): void {
    if (this.#outsideIsStdout) {
      if (this.#outside !== "") tokens.push({ kind: "stdout", text: this.#outside });
      this.#outside = "";
      return;
    }

    let retainedLength = 0;
    for (let length = Math.min(PROMPT.length - 1, this.#outside.length); length > 0; length -= 1) {
      if (this.#outside.endsWith(PROMPT.slice(0, length))) {
        retainedLength = length;
        break;
      }
    }
    const safeLength = this.#outside.length - retainedLength;
    if (safeLength === 0) return;
    const safe = this.#outside.slice(0, safeLength);
    this.#outside = this.#outside.slice(safeLength);
    if (safe.trim() !== "") {
      this.#outsideIsStdout = true;
      tokens.push({ kind: "stdout", text: safe });
    }
  }

  #emitOutside(tokens: InteractionJsonToken[]): void {
    const outside = this.#outside;
    this.#outside = "";
    if (outside !== "" && (this.#outsideIsStdout || outside.trim() !== "")) {
      tokens.push({ kind: "stdout", text: outside });
    }
    this.#outsideIsStdout = false;
  }
}
