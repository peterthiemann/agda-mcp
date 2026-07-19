import assert from "node:assert/strict";
import test from "node:test";

import { normalizeAgdaPosition, normalizeAgdaRange } from "../../src/normalization/ranges.js";

test("Agda code-point positions become UTF-16 offsets", () => {
  const source = "module Unicode where\n\nvalue = λ x → 🙂\n";
  const emojiOffset = source.indexOf("🙂");
  const prefix = source.slice(0, emojiOffset);
  const position = normalizeAgdaPosition(source, {
    line: 3,
    col: [...source.split("\n")[2]!.slice(0, source.split("\n")[2]!.indexOf("🙂"))].length + 1,
    pos: [...prefix].length + 1,
  });
  assert.equal(position.utf16Offset, emojiOffset);
  assert.equal(position.line, 3);
});

test("empty and reversed native ranges are handled safely", () => {
  assert.equal(normalizeAgdaRange("abc", []), undefined);
  assert.throws(() =>
    normalizeAgdaRange("abc", [
      {
        start: { line: 1, col: 3, pos: 3 },
        end: { line: 1, col: 2, pos: 2 },
      },
    ]),
  );
});
