import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const target = process.argv[2];

if (!target || !["openclaw", "paperclip", "core"].includes(target)) {
  console.error("Usage: node scripts/prepare-package-target.mjs <openclaw|paperclip|core>");
  process.exit(1);
}

const root = process.cwd();
const sourceDistByTarget = {
  openclaw: "dist-openclaw",
  paperclip: "dist-paperclip",
  core: "dist-core",
};

const sourceEntryByTarget = {
  openclaw: "./index.js",
  paperclip: "./entries/paperclip.js",
  core: "./entries/core.js",
};

const sourceDist = join(root, sourceDistByTarget[target]);
if (!existsSync(sourceDist)) {
  console.error(`[prepare-package-target] Missing build output for ${target}: ${sourceDist}`);
  process.exit(1);
}

const outDir = join(root, "artifacts", "npm", target);
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const filesToCopy = ["README.md", "LICENSE", "CONFIG.example.json"];
for (const file of filesToCopy) {
  const from = join(root, file);
  if (existsSync(from)) cpSync(from, join(outDir, file));
}

if (target === "openclaw") {
  const pluginJson = join(root, "openclaw.plugin.json");
  if (existsSync(pluginJson)) cpSync(pluginJson, join(outDir, "openclaw.plugin.json"));
}

const outDist = join(outDir, "dist");
cpSync(sourceDist, outDist, { recursive: true });

const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const baseName = String(rootPkg.name || "@mrc2204/agent-smart-memo").replace(/\/+$/, "");
const packageName = target === "openclaw" ? baseName : `${baseName}-${target}`;
const packageDescription = {
  openclaw: rootPkg.description || "Agent Smart Memo OpenClaw plugin",
  paperclip: "Paperclip adapter/runtime package for Agent Smart Memo core",
  core: "Runtime-agnostic core contracts and use-cases for Agent Smart Memo",
}[target];

const pkg = {
  name: packageName,
  version: rootPkg.version,
  description: packageDescription,
  type: "module",
  main: `dist/${sourceEntryByTarget[target].replace(/^\.\//, "")}`,
  exports: {
    ".": `./dist/${sourceEntryByTarget[target].replace(/^\.\//, "")}`,
  },
  types: `dist/${sourceEntryByTarget[target].replace(/\.js$/, ".d.ts").replace(/^\.\//, "")}`,
  files: ["dist/", "README.md", "LICENSE", "CONFIG.example.json"],
  license: rootPkg.license,
  author: rootPkg.author,
  repository: rootPkg.repository,
  publishConfig: rootPkg.publishConfig || { access: "public" },
  keywords: Array.isArray(rootPkg.keywords) ? rootPkg.keywords : undefined,
  dependencies: { ...(rootPkg.dependencies || {}) },
};

if (target === "openclaw") {
  pkg.openclaw = {
    extensions: ["./dist/index.js"],
  };
  pkg.files.push("openclaw.plugin.json");
  pkg.devDependencies = { openclaw: "*" };
} else {
  // Ensure non-openclaw packages do not pull openclaw runtime dependency.
  pkg.devDependencies = {};
}

writeFileSync(join(outDir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`, "utf8");

console.log(`[prepare-package-target] Prepared ${target} package at ${outDir}`);
