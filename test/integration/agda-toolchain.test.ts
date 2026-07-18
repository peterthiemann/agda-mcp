import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test("detects the Agda 2.8.0 integration baseline when available", async (context) => {
  let numericVersion: string;
  try {
    const result = await execFileAsync("agda", ["--numeric-version"], {
      encoding: "utf8",
    });
    numericVersion = result.stdout.trim();
  } catch (error: unknown) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "unknown";
    context.skip(`Agda is unavailable (${code})`);
    return;
  }

  if (numericVersion !== "2.8.0") {
    context.skip(`Agda ${numericVersion} is installed; baseline integration requires 2.8.0`);
    return;
  }

  assert.equal(numericVersion, "2.8.0");
});
