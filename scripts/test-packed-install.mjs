import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const temporary = await mkdtemp(path.join(tmpdir(), "agda-mcp-package-"));
const installDirectory = path.join(temporary, "install");
const npmEnvironment = {
  ...process.env,
  npm_config_cache: path.join(temporary, "npm-cache"),
};

try {
  const packed = await execFileAsync(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: npmEnvironment,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  const records = JSON.parse(packed.stdout);
  const filename = records[0]?.filename;
  assert.equal(typeof filename, "string", "npm pack did not return a tarball filename");
  const tarball = path.join(temporary, filename);

  const listing = await execFileAsync("tar", ["-tf", tarball], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  const entries = listing.stdout.trim().split("\n");
  assert.equal(entries.includes("package/package.json"), true);
  assert.equal(entries.includes("package/README.md"), true);
  assert.equal(entries.includes("package/LICENSE"), true);
  assert.equal(entries.includes("package/dist/index.js"), true);
  assert.equal(entries.some((entry) => entry.startsWith("package/test/")), false);
  assert.equal(entries.some((entry) => entry.includes("fixtures")), false);
  assert.equal(entries.some((entry) => entry.endsWith(".agdai")), false);

  await mkdir(installDirectory);
  await execFileAsync(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
    {
      cwd: installDirectory,
      encoding: "utf8",
      env: npmEnvironment,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  const executable = path.join(
    installDirectory,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "agda-mcp.cmd" : "agda-mcp",
  );
  const invoked = await execFileAsync(executable, ["--help"], {
    cwd: installDirectory,
    encoding: "utf8",
  });
  assert.match(invoked.stdout, /agda-mcp 0\.1\.0/u);

  const installedPackage = JSON.parse(
    await readFile(path.join(installDirectory, "node_modules", "agda-mcp", "package.json"), "utf8"),
  );
  assert.equal(installedPackage.name, "agda-mcp");
  assert.equal(installedPackage.version, "0.1.0");
  assert.equal(installedPackage.license, "MIT");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
