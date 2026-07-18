import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { RawTranscriptCollector } from "../../src/protocol/transcript.js";

test("raw event budgets omit only complete events and digest omitted bytes", () => {
  const first = { kind: "First", value: 1 };
  const second = { kind: "Second", value: "large" };
  const third = { kind: "Third" };
  const firstRaw = JSON.stringify(first);
  const secondRaw = JSON.stringify(second);
  const thirdRaw = JSON.stringify(third);
  const collector = new RawTranscriptCollector("test-adapter", Buffer.byteLength(firstRaw), 32);
  collector.addEvent(first, firstRaw);
  collector.addEvent(second, secondRaw);
  collector.addEvent(third, thirdRaw);
  const result = collector.finish();

  assert.deepEqual(result.raw.events, [first]);
  assert.equal(result.raw.complete, false);
  assert.equal(result.raw.capturedBytes, Buffer.byteLength(firstRaw));
  assert.equal(
    result.raw.totalBytes,
    Buffer.byteLength(firstRaw) + Buffer.byteLength(secondRaw) + Buffer.byteLength(thirdRaw),
  );
  assert.equal(result.raw.omittedEventCount, 2);
  assert.equal(
    result.raw.omittedSha256,
    createHash("sha256").update(secondRaw, "utf8").update(thirdRaw, "utf8").digest("hex"),
  );
});

test("stderr and non-JSON stdout have independent bounded captures", () => {
  const collector = new RawTranscriptCollector("test-adapter", 5, 4);
  collector.addStderr(Buffer.from("ab"));
  collector.addStderr(Buffer.from("cdef"));
  collector.addStdoutFragment("123456");
  const result = collector.finish();

  assert.deepEqual(result.raw.stderr.chunks, ["ab", "cd"]);
  assert.deepEqual(result.raw.stderr, {
    chunks: ["ab", "cd"],
    complete: false,
    capturedBytes: 4,
    totalBytes: 6,
  });
  assert.deepEqual(result.stdoutFragments, ["12345"]);
  assert.equal(result.stdoutComplete, false);
});
