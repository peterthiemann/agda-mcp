import { createHash, type Hash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

import type { CapturedStderr, RawAgdaResponse } from "../application/domain.js";

export interface ProtocolCommandResult {
  readonly raw: RawAgdaResponse;
  readonly stdoutFragments: readonly string[];
  readonly stdoutComplete: boolean;
}

function capturePrefix(value: string, remainingBytes: number): { text: string; bytes: number } {
  let text = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > remainingBytes) break;
    text += character;
    bytes += characterBytes;
  }
  return { text, bytes };
}

class TextCapture {
  readonly #limit: number;
  readonly #decoder = new StringDecoder("utf8");
  readonly #chunks: string[] = [];
  #capturedBytes = 0;
  #totalBytes = 0;

  constructor(limit: number) {
    this.#limit = limit;
  }

  addBuffer(chunk: Buffer): void {
    this.#totalBytes += chunk.length;
    this.#capture(this.#decoder.write(chunk));
  }

  addString(value: string): void {
    const buffer = Buffer.from(value);
    this.#totalBytes += buffer.length;
    this.#capture(value);
  }

  finish(): CapturedStderr {
    this.#capture(this.#decoder.end());
    return Object.freeze({
      chunks: Object.freeze([...this.#chunks]),
      complete: this.#capturedBytes === this.#totalBytes,
      capturedBytes: this.#capturedBytes,
      totalBytes: this.#totalBytes,
    });
  }

  #capture(value: string): void {
    if (value === "" || this.#capturedBytes >= this.#limit) return;
    const captured = capturePrefix(value, this.#limit - this.#capturedBytes);
    if (captured.text !== "") this.#chunks.push(captured.text);
    this.#capturedBytes += captured.bytes;
  }
}

export class RawTranscriptCollector {
  readonly #adapter: string;
  readonly #rawLimit: number;
  readonly #stderr: TextCapture;
  readonly #stdout: TextCapture;
  readonly #events: unknown[] = [];
  #capturedBytes = 0;
  #totalBytes = 0;
  #omittedEventCount = 0;
  #omittedHash: Hash | undefined;
  #truncated = false;

  constructor(adapter: string, rawLimitBytes: number, stderrLimitBytes: number) {
    this.#adapter = adapter;
    this.#rawLimit = rawLimitBytes;
    this.#stderr = new TextCapture(stderrLimitBytes);
    this.#stdout = new TextCapture(rawLimitBytes);
  }

  addEvent(value: unknown, raw: string): void {
    const bytes = Buffer.byteLength(raw);
    this.#totalBytes += bytes;
    if (!this.#truncated && this.#capturedBytes + bytes <= this.#rawLimit) {
      this.#events.push(value);
      this.#capturedBytes += bytes;
      return;
    }
    this.#truncated = true;
    this.#omittedEventCount += 1;
    this.#omittedHash ??= createHash("sha256");
    this.#omittedHash.update(raw, "utf8");
  }

  addStderr(chunk: Buffer): void {
    this.#stderr.addBuffer(chunk);
  }

  addStdoutFragment(fragment: string): void {
    this.#stdout.addString(fragment);
  }

  finish(): ProtocolCommandResult {
    const stderr = this.#stderr.finish();
    const stdout = this.#stdout.finish();
    const omittedSha256 = this.#omittedHash?.digest("hex");
    const raw: RawAgdaResponse = Object.freeze({
      adapter: this.#adapter,
      events: Object.freeze([...this.#events]),
      complete: this.#omittedEventCount === 0,
      capturedBytes: this.#capturedBytes,
      totalBytes: this.#totalBytes,
      omittedEventCount: this.#omittedEventCount,
      stderr,
      ...(omittedSha256 === undefined ? {} : { omittedSha256 }),
    });
    return Object.freeze({
      raw,
      stdoutFragments: stdout.chunks,
      stdoutComplete: stdout.complete,
    });
  }
}
