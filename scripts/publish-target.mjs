import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const target = process.argv[2];
if (!target || !["openclaw", "paperclip", "core"].includes(target)) {
  console.error("Usage: node scripts/publish-target.mjs <openclaw|paperclip|core>");
  process.exit(1);
}

const pkgDir = join(process.cwd(), "artifacts", "npm", target);
if (!existsSync(pkgDir)) {
  console.error(`[publish-target] Missing package dir ${pkgDir}. Run package:${target} first.`);
  process.exit(1);
}

const args = process.argv.includes("--dry-run") ? ["publish", "--access", "public", "--dry-run"] : ["publish", "--access", "public"];
const res = spawnSync("npm", args, { cwd: pkgDir, stdio: "inherit", shell: process.platform === "win32" });
process.exit(res.status ?? 1);
