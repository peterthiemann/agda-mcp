import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const testRoot = fileURLToPath(new URL("../.test-dist/test/", import.meta.url));
const requestedGroup = process.argv[2];
const searchRoot = requestedGroup ? path.join(testRoot, requestedGroup) : testRoot;

async function findTests(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const tests = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      tests.push(...(await findTests(entryPath)));
    } else if (entry.isFile() && entry.name.endsWith(".test.js")) {
      tests.push(entryPath);
    }
  }

  return tests;
}

const tests = (await findTests(searchRoot)).sort();
if (tests.length === 0) {
  throw new Error(`No compiled tests found below ${pathToFileURL(searchRoot).href}`);
}

const child = spawn(process.execPath, ["--test", ...tests], {
  stdio: "inherit",
  shell: false,
});

child.once("error", (error) => {
  throw error;
});

const exitCode = await new Promise((resolve) => {
  child.once("exit", (code, signal) => {
    if (signal !== null) {
      process.stderr.write(`Test process terminated by ${signal}\n`);
      resolve(1);
      return;
    }
    resolve(code ?? 1);
  });
});

process.exitCode = exitCode;
