import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hashFile = path.join(repoRoot, "src", "canvas-host", "a2ui", ".bundle.hash");
const outputFile = path.join(repoRoot, "src", "canvas-host", "a2ui", "a2ui.bundle.js");
const a2uiRendererDir = path.join(repoRoot, "vendor", "a2ui", "renderers", "lit");
const a2uiAppDir = path.join(repoRoot, "apps", "shared", "OpenClawKit", "Tools", "CanvasA2UI");
const inputPaths = [
  path.join(repoRoot, "package.json"),
  path.join(repoRoot, "pnpm-lock.yaml"),
  a2uiRendererDir,
  a2uiAppDir,
];

function runCommand(command, args) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    cwd: repoRoot,
    shell: process.platform === "win32",
  });

  if (typeof result.status === "number" && result.status !== 0) {
    process.exit(result.status);
  }
  if (result.error) {
    throw result.error;
  }
}

async function walk(entryPath, files) {
  const stat = await fs.stat(entryPath);
  if (stat.isDirectory()) {
    const entries = await fs.readdir(entryPath);
    for (const entry of entries) {
      await walk(path.join(entryPath, entry), files);
    }
    return;
  }
  files.push(entryPath);
}

function normalize(p) {
  return p.split(path.sep).join("/");
}

async function computeHash() {
  const files = [];
  for (const inputPath of inputPaths) {
    await walk(inputPath, files);
  }
  files.sort((a, b) => normalize(a).localeCompare(normalize(b)));

  const hash = createHash("sha256");
  for (const filePath of files) {
    const rel = normalize(path.relative(repoRoot, filePath));
    hash.update(rel);
    hash.update("\0");
    hash.update(await fs.readFile(filePath));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function main() {
  if (!existsSync(a2uiRendererDir) || !existsSync(a2uiAppDir)) {
    if (existsSync(outputFile)) {
      console.log("A2UI sources missing; keeping prebuilt bundle.");
      return;
    }
    throw new Error(`A2UI sources missing and no prebuilt bundle found at: ${outputFile}`);
  }

  const currentHash = await computeHash();
  if (existsSync(hashFile) && existsSync(outputFile)) {
    const previousHash = await fs.readFile(hashFile, "utf8");
    if (previousHash.trim() === currentHash) {
      console.log("A2UI bundle up to date; skipping.");
      return;
    }
  }

  runCommand("pnpm", ["-s", "exec", "tsc", "-p", path.join(a2uiRendererDir, "tsconfig.json")]);

  const rolldownPinned = path.join(
    repoRoot,
    "node_modules",
    ".pnpm",
    "rolldown@1.0.0-rc.9",
    "node_modules",
    "rolldown",
    "bin",
    "cli.mjs",
  );
  const rolldownWorkspace = path.join(
    repoRoot,
    "node_modules",
    ".pnpm",
    "node_modules",
    "rolldown",
    "bin",
    "cli.mjs",
  );
  const rolldownConfig = path.join(a2uiAppDir, "rolldown.config.mjs");

  if (existsSync(rolldownWorkspace)) {
    runCommand("node", [rolldownWorkspace, "-c", rolldownConfig]);
  } else if (existsSync(rolldownPinned)) {
    runCommand("node", [rolldownPinned, "-c", rolldownConfig]);
  } else {
    runCommand("pnpm", ["-s", "dlx", "rolldown", "-c", rolldownConfig]);
  }

  await fs.mkdir(path.dirname(hashFile), { recursive: true });
  await fs.writeFile(hashFile, `${currentHash}\n`, "utf8");
}

main().catch((error) => {
  console.error("A2UI bundling failed. Re-run with: pnpm canvas:a2ui:bundle");
  console.error("If this persists, verify pnpm deps and try again.");
  console.error(error);
  process.exit(1);
});
