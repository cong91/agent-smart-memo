import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const sourceDir = join(root, "dist-openclaw");
const targetDir = join(root, "dist");

if (!existsSync(sourceDir)) {
  console.error(`[sync-openclaw-dist] Missing source dir: ${sourceDir}`);
  process.exit(1);
}

rmSync(targetDir, { recursive: true, force: true });
mkdirSync(targetDir, { recursive: true });
cpSync(sourceDir, targetDir, { recursive: true });

console.log(`[sync-openclaw-dist] Synced ${sourceDir} -> ${targetDir}`);
