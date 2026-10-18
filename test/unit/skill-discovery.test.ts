import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";

import { loadSkillCatalog, SKILL_URI, SKILLS_EXTENSION } from "../../src/mcp/skillDiscovery.js";
import { createAgdaMcpServer } from "../../src/mcp/stdioServer.js";

const skillSchema = z.object({
  uri: z.string(), frontmatter: z.record(z.string(), z.unknown()),
  resources: z.array(z.object({ uri: z.string(), digest: z.string(), size: z.number() })),
});
const listResult = z.object({ resultType: z.literal("complete"), skills: z.array(skillSchema),
  ttlMs: z.number(), cacheScope: z.literal("public") });
const getResult = z.object({ resultType: z.literal("complete"), skill: skillSchema });

test("discovery works without Agda and serves a complete, verifiable bundled skill", async () => {
  const server = createAgdaMcpServer(async () => { throw new Error("Agda must not start for discovery"); });
  const client = new Client({ name: "skill-discovery-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    assert.deepEqual(client.getServerCapabilities()?.extensions?.[SKILLS_EXTENSION], {});
    assert.ok(client.getServerCapabilities()?.resources);
    const listed = await client.request({ method: "skills/list" }, listResult);
    assert.equal(listed.skills.length, 1);
    const skill = listed.skills[0]!;
    assert.equal(skill.uri, SKILL_URI);
    const source = await readFile("skills/agda-proof/SKILL.md", "utf8");
    assert.equal(skill.frontmatter.name, "agda-proof");
    assert.ok(String(skill.frontmatter.description).includes("Agda"));
    const got = await client.request({ method: "skills/get", params: { uri: SKILL_URI } }, getResult);
    assert.deepEqual(got.skill, skill);
    const resources = await client.listResources();
    assert.deepEqual(resources.resources.map((resource) => resource.uri).sort(), skill.resources.map((file) => file.uri).sort());
    assert.ok(skill.resources.some((file) => file.uri.endsWith("/references/tools.md")));
    assert.ok(skill.resources.some((file) => file.uri.endsWith("/agents/openai.yaml")));
    for (const entry of skill.resources) {
      const read = await client.readResource({ uri: entry.uri });
      assert.equal(read.contents.length, 1);
      const content = read.contents[0]!;
      assert.ok("text" in content);
      const bytes = Buffer.from(content.text as string);
      assert.equal(bytes.length, entry.size);
      assert.equal(`sha256:${createHash("sha256").update(bytes).digest("hex")}`, entry.digest);
      if (entry.uri === SKILL_URI) assert.equal(content.text, source);
    }
    for (const uri of ["skill://agda-proof/missing.md", "file:///etc/passwd", "skill://other/SKILL.md", "skill://agda-proof/%2e%2e/package.json"]) {
      await assert.rejects(client.readResource({ uri }), (error: unknown) => error instanceof McpError && error.code === ErrorCode.InvalidParams);
      await assert.rejects(client.request({ method: "skills/get", params: { uri } }, getResult),
        (error: unknown) => error instanceof McpError && error.code === ErrorCode.InvalidParams);
    }
    await assert.rejects(client.request({ method: "skills/list", params: { cursor: "invalid" } }, listResult),
      (error: unknown) => error instanceof McpError && error.code === ErrorCode.InvalidParams);
    await assert.rejects(client.request({ method: "skills/get", params: {} }, getResult));
    assert.equal((await client.listTools()).tools.length, 18);
  } finally {
    await client.close();
    await server.close();
  }
});

test("catalog is a byte snapshot, preserves additional frontmatter, and rejects symlinks", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "agda-skill-catalog-"));
  try {
    await writeFile(join(temporary, "SKILL.md"), "---\nname: agda-proof\ndescription: Dévelop Agda proofs\nmetadata:\n  custom: retained\n---\nα → β\n");
    const catalog = loadSkillCatalog(temporary);
    assert.deepEqual(catalog.skill.frontmatter.metadata, { custom: "retained" });
    const before = catalog.files.get(SKILL_URI)!.text;
    await writeFile(join(temporary, "SKILL.md"), "changed");
    assert.equal(catalog.files.get(SKILL_URI)!.text, before);
    await assert.rejects(async () => loadSkillCatalog(temporary), /no YAML frontmatter/);
    await symlink(join(temporary, "SKILL.md"), join(temporary, "outside.md"));
    assert.throws(() => loadSkillCatalog(temporary), /symlinks/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
