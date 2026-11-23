import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const hosted = "https://postoir.com/mcp";

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(root, path), "utf8")) as Record<string, unknown>;
}

async function filesUnder(directory: string): Promise<string[]> {
  const result: string[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(join(root, current), { withFileTypes: true })) {
      const relative = join(current, entry.name);
      if (entry.isDirectory()) await walk(relative);
      else result.push(relative);
    }
  };
  await walk(directory);
  return result.sort();
}

test("plugin manifests share the package identity and stay free of credentials", async () => {
  const pkg = await readJson("package.json");
  const manifests = [
    "plugin.json",
    "postoir-plugin/.claude-plugin/plugin.json",
    ".cursor-plugin/plugin.json",
    ".codex-plugin/plugin.json",
    ".grok-plugin/plugin.json",
    "gemini-extension.json",
  ];
  for (const path of manifests) {
    const manifest = await readJson(path);
    assert.equal(manifest.name, "postoir", path);
    assert.equal(manifest.version, pkg.version, path);
  }

  const portable = await readJson("plugin.json");
  assert.deepEqual(Object.keys(portable).sort(), [
    "$schema",
    "author",
    "description",
    "extensions",
    "homepage",
    "keywords",
    "license",
    "name",
    "repository",
    "version",
  ]);
  const mcp = await readJson("mcp.json");
  assert.deepEqual(mcp.mcpServers, { postoir: { type: "streamable-http", url: hosted } });
  const claudeMcp = await readJson(".mcp.json");
  assert.deepEqual(claudeMcp.mcpServers, {
    postoir: { type: "http", url: hosted },
  });
  const gemini = await readJson("gemini-extension.json");
  assert.deepEqual(gemini.mcpServers, { postoir: { type: "http", url: hosted } });

  const openAi = (
    (portable.extensions as Record<string, unknown>)["com.openai"] as Record<string, unknown>
  ).interface as Record<string, unknown>;
  assert.equal(openAi.privacyPolicyURL, "https://postoir.com/privacy");
  assert.equal(openAi.termsOfServiceURL, "https://postoir.com/terms");
  assert.equal(openAi.composerIcon, "./assets/icon.png");
  assert.equal(openAi.logo, "./assets/logo.png");
  assert.equal(openAi.logoDark, "./assets/logo-dark.png");

  const cursorPlugin = await readJson(".cursor-plugin/plugin.json");
  assert.equal(cursorPlugin.logo, "assets/logo.png");
  const cursorMarket = await readJson(".cursor-plugin/marketplace.json");
  const cursorPlugins = cursorMarket.plugins as Array<{ logo?: string }>;
  assert.equal(cursorPlugins[0]?.logo, "assets/logo.png");

  const packaged = pkg.files as string[];
  for (const path of [
    ...manifests,
    "mcp.json",
    ".mcp.json",
    "POSTOIR.md",
    "assets/icon.png",
    "assets/logo-dark.png",
    "assets/logo.png",
    ".agents/plugins/marketplace.json",
  ])
    assert.ok(
      packaged.some((entry) => path === entry || path.startsWith(`${entry}/`)),
      path,
    );

  const claudeMarket = await readJson(".claude-plugin/marketplace.json");
  const claudePlugins = claudeMarket.plugins as Array<{ source: string }>;
  assert.equal(claudePlugins[0]?.source, "./postoir-plugin");
  const claudePlugin = await readJson("postoir-plugin/.claude-plugin/plugin.json");
  assert.equal(claudePlugin.privacyPolicyUrl, "https://postoir.com/privacy");

  const grokMarket = await readJson(".grok-plugin/marketplace.json");
  const grokPlugins = grokMarket.plugins as Array<{ source: { path: string } }>;
  assert.equal(grokPlugins[0]?.source.path, "postoir-plugin");
  for (const relative of [
    ".mcp.json",
    ".grok-plugin/plugin.json",
    ...(await filesUnder("skills/postoir")),
  ]) {
    assert.equal(
      await readFile(join(root, "postoir-plugin", relative), "utf8"),
      await readFile(join(root, relative), "utf8"),
      relative,
    );
  }

  const serialized = JSON.stringify({
    portable,
    mcp,
    claudeMcp,
    claude: await readJson(".claude-plugin/marketplace.json"),
    cursor: await readJson(".cursor-plugin/marketplace.json"),
    codex: await readJson(".agents/plugins/marketplace.json"),
    grok: await readJson(".grok-plugin/marketplace.json"),
  });
  assert.equal(serialized.includes("Bearer"), false);
  assert.equal(serialized.includes("apiKey"), false);
  assert.equal(serialized.includes("POSTOIR_API_KEY"), false);
});
