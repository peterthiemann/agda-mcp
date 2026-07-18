#!/usr/bin/env node

import { runCli } from "./cli.js";

try {
  process.exitCode = await runCli(process.argv.slice(2), {
    stdout: process.stdout,
    stderr: process.stderr,
  });
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`agda-mcp: ${message}\n`);
  process.exitCode = 1;
}
