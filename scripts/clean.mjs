import { rm } from "node:fs/promises";

const allowedPaths = new Set(["dist", ".test-dist", "coverage"]);

for (const path of process.argv.slice(2)) {
  if (!allowedPaths.has(path)) {
    throw new Error(`Refusing to clean unexpected path: ${path}`);
  }
  await rm(path, { recursive: true, force: true });
}
