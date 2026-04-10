import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const ASM_WIKI_FIRST_BLOCK_VERSION = "2026-04-10";
const BLOCK_START = "<!-- ASM-WIKI-FIRST-BOOTSTRAP:START";
const BLOCK_END = "<!-- ASM-WIKI-FIRST-BOOTSTRAP:END -->";

export interface ReinforcementPatchResult {
	path: string;
	status:
		| "created"
		| "patched"
		| "updated"
		| "already-current"
		| "missing-target";
	changed: boolean;
	blockVersion: string;
}

function buildManagedBlock(): string {
	return [
		`${BLOCK_START} version=${ASM_WIKI_FIRST_BLOCK_VERSION} -->`,
		"## ASM wiki-first bootstrap (managed by ASM)",
		"",
		"Read order:",
		"1. Start from `memory/wiki/index.md`, `schema.md`, and `log.md`.",
		"2. Treat wiki markdown as the working surface for repo-specific context.",
		"3. Resolve runtime paths from ASM shared config / plugin runtime, not from this file.",
		"",
		"Storage boundary:",
		"- SlotDB/runtime state = control/runtime truth.",
		"- `memory/wiki/` markdown = agent-facing working surface.",
		"- QMD/backend state remains canonical persistence.",
		"",
		"Rules:",
		"- Keep this file reinforcement-only, not full project memory.",
		"- Do not treat AGENTS.md snippets as source-of-truth over wiki/runtime state.",
		"- Prefer wiki-first investigation over snippet-first cognition.",
		BLOCK_END,
	].join("\n");
}

function replaceManagedBlock(content: string, block: string): string {
	const startIndex = content.indexOf(BLOCK_START);
	const endIndex = content.indexOf(BLOCK_END);
	if (startIndex >= 0 && endIndex >= startIndex) {
		const suffixIndex = endIndex + BLOCK_END.length;
		return (
			`${content
				.slice(0, startIndex)
				.replace(/[\t ]*$/u, "")
				.replace(
					/\n*$/u,
					"\n\n",
				)}${block}\n${content.slice(suffixIndex).replace(/^\n*/u, "")}`.trimEnd() +
			"\n"
		);
	}

	const base = content.trimEnd();
	return `${base ? `${base}\n\n` : ""}${block}\n`;
}

export function patchReinforcementSurface(
	path: string,
	options: { createIfMissing?: boolean } = {},
): ReinforcementPatchResult {
	const block = buildManagedBlock();
	try {
		const current = readFileSync(path, "utf8");
		if (current.includes(block)) {
			return {
				path,
				status: "already-current",
				changed: false,
				blockVersion: ASM_WIKI_FIRST_BLOCK_VERSION,
			};
		}

		const hadManagedBlock =
			current.includes(BLOCK_START) && current.includes(BLOCK_END);
		const next = replaceManagedBlock(current, block);
		writeFileSync(path, next, "utf8");
		return {
			path,
			status: hadManagedBlock ? "updated" : "patched",
			changed: true,
			blockVersion: ASM_WIKI_FIRST_BLOCK_VERSION,
		};
	} catch {
		if (options.createIfMissing) {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, `${block}\n`, "utf8");
			return {
				path,
				status: "created",
				changed: true,
				blockVersion: ASM_WIKI_FIRST_BLOCK_VERSION,
			};
		}
		return {
			path,
			status: "missing-target",
			changed: false,
			blockVersion: ASM_WIKI_FIRST_BLOCK_VERSION,
		};
	}
}
