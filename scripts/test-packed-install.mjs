import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as z from "zod/v4";
import { Client as ModernClient } from "@modelcontextprotocol/client";
import { StdioClientTransport as ModernStdioClientTransport } from "@modelcontextprotocol/client/stdio";
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
const sourcePackage = JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8"));

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
  for (const filename of ["skills/agda-proof/SKILL.md", "skills/agda-proof/references/tools.md",
    "skills/agda-proof/agents/openai.yaml", "plugin.json", "mcp.json", "INSTALL.md"]) {
    assert.equal(entries.includes(`package/${filename}`), true, `Missing ${filename}`);
  }
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
  assert.equal(invoked.stdout.startsWith(`agda-mcp ${sourcePackage.version}\n`), true);

  const installedPackage = JSON.parse(
    await readFile(path.join(installDirectory, "node_modules", "agda-mcp", "package.json"), "utf8"),
  );
  assert.equal(installedPackage.name, "agda-mcp");
  assert.equal(installedPackage.version, sourcePackage.version);
  assert.equal(installedPackage.license, "MIT");

  // Discovery must work from an installed tarball, outside the checkout, with
  // Agda deliberately unavailable; resources must match the installed bytes.
  for (const modern of [false, true]) {
  const client = modern
    ? new ModernClient({ name: "packed-modern-test", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } })
    : new Client({ name: "packed-legacy-test", version: "1" });
  const ClientTransport = modern ? ModernStdioClientTransport : StdioClientTransport;
  const transport = new ClientTransport({ command: executable, cwd: installDirectory,
    env: { ...getDefaultEnvironment(), AGDA_MCP_OPTIONS: JSON.stringify({ agdaExecutable: "agda-intentionally-unavailable" }) },
    stderr: "pipe" });
  try {
    await client.connect(transport);
    assert.deepEqual(client.getServerCapabilities().extensions["io.modelcontextprotocol/skills"], {});
    const listed = await client.request({ method: "skills/list" }, z.object({ skills: z.array(z.object({
      uri: z.string(), frontmatter: z.record(z.string(), z.unknown()), resources: z.array(z.object({
        uri: z.string(), digest: z.string(), size: z.number()
      }))
    })) }));
    assert.equal(listed.skills.length, 1);
    const skill = listed.skills[0];
    assert.equal(skill.uri, "skill://agda-proof/SKILL.md");
    const got = await client.request({ method: "skills/get", params: { uri: skill.uri } }, z.object({ skill: z.unknown() }));
    assert.deepEqual(got.skill, skill);
    for (const resource of skill.resources) {
      const read = await client.readResource({ uri: resource.uri });
      const bytes = Buffer.from(read.contents[0].text, "utf8");
      assert.equal(bytes.length, resource.size);
      assert.equal(`sha256:${createHash("sha256").update(bytes).digest("hex")}`, resource.digest);
      const relative = resource.uri.slice("skill://agda-proof/".length);
      const installed = await readFile(path.join(installDirectory, "node_modules", "agda-mcp", "skills", "agda-proof", relative));
      assert.deepEqual(bytes, installed);
    }
    assert.ok(skill.resources.some((entry) => entry.uri.endsWith("/references/tools.md")));
    const resources = await client.listResources();
    assert.equal(resources.resources.length, skill.resources.length);
    if (modern) assert.equal(client.getProtocolEra(), "modern");
    assert.equal((await client.listTools()).tools.length, 18);
    console.log(`Packed ${modern ? "modern" : "v1 legacy"} install: discovery and all digests verified without Agda`);
  } finally {
    await client.close();
  }
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
