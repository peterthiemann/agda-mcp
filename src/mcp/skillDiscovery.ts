import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer, ProtocolError, INVALID_PARAMS } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { parse } from "yaml";


export const SKILL_URI = "skill://agda-proof/SKILL.md";
export const SKILLS_EXTENSION = "io.modelcontextprotocol/skills";
const CACHE = { resultType: "complete" as const, ttlMs: 0, cacheScope: "public" as const };
const requestParams = z.object({ _meta: z.record(z.string(), z.unknown()).optional() });
/** Resolve relative to this installed package, never the client's cwd. */
function bundledSkillDirectory(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(directory, "package.json"))) {
    const parent = dirname(directory);
    if (parent === directory) throw new Error("Cannot locate agda-mcp package root");
    directory = parent;
  }
  return join(directory, "skills", "agda-proof");
}

export function loadSkillCatalog(directory = bundledSkillDirectory()) {
  const files = new Map<string, { text: string; mimeType: string; bytes: Buffer }>();
  function visit(current: string): void {
    if (lstatSync(current).isSymbolicLink()) throw new Error(`Skill symlinks are not supported: ${current}`);
    for (const name of readdirSync(current).sort()) {
      const filename = join(current, name);
      const stat = lstatSync(filename);
      if (stat.isSymbolicLink()) throw new Error(`Skill symlinks are not supported: ${filename}`);
      if (stat.isDirectory()) visit(filename);
      else if (stat.isFile()) {
        const path = relative(directory, filename).split("\\").join("/");
        const uri = `skill://agda-proof/${path.split("/").map(encodeURIComponent).join("/")}`;
        const bytes = readFileSync(filename);
        files.set(uri, { bytes, text: bytes.toString("utf8"),
          mimeType: path.endsWith(".md") ? "text/markdown" : "application/yaml" });
      }
    }
  }
  visit(directory);
  const entrypoint = files.get(SKILL_URI);
  const match = entrypoint?.text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
  if (!match?.[1]) throw new Error("Bundled skill has no YAML frontmatter");
  const frontmatter = z.object({
    name: z.literal("agda-proof"),
    description: z.string().refine((value) => value.trim().length > 0),
  }).passthrough().parse(parse(match[1]));
  if (files.size > 512 || [...files.values()].reduce((size, file) => size + file.bytes.length, 0) > 16777216) {
    throw new Error("Bundled skill exceeds MCP Skills limits");
  }
  // A process-lifetime byte snapshot keeps listings, digests, and reads consistent.
  const skill = {
    uri: SKILL_URI,
    frontmatter,
    resources: [...files].map(([uri, file]) => ({ uri,
      digest: `sha256:${createHash("sha256").update(file.bytes).digest("hex")}`, size: file.bytes.length })),
  };
  return { skill, files };
}

export function registerSkillDiscovery(server: McpServer): void {
  const catalog = loadSkillCatalog();
  server.server.registerCapabilities({ extensions: { [SKILLS_EXTENSION]: {} } });
  for (const [uri, file] of catalog.files) {
    server.registerResource(uri === SKILL_URI ? "agda-proof" : uri.slice("skill://agda-proof/".length), uri,
      { mimeType: file.mimeType,
        ...(uri === SKILL_URI ? { description: catalog.skill.frontmatter.description } : {}) },
      async () => ({ ...CACHE, contents: [{ uri, mimeType: file.mimeType, text: file.text }] }));
  }
  server.server.setRequestHandler("skills/list", {
    params: requestParams.extend({ cursor: z.string().optional() }),
  }, async (params) => {
    if (params.cursor !== undefined) throw new ProtocolError(INVALID_PARAMS, "Unknown skills cursor");
    return { ...CACHE, skills: [catalog.skill] };
  });
  server.server.setRequestHandler("skills/get", {
    params: requestParams.extend({ uri: z.string() }),
  }, async (params) => {
    if (params.uri !== SKILL_URI) throw new ProtocolError(INVALID_PARAMS, "Unknown skill URI");
    return { ...CACHE, skill: catalog.skill };
  });
}
