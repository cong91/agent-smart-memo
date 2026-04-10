import { readFileSync, writeFileSync } from "node:fs";

export const ASM_WIKI_FIRST_BLOCK_VERSION = "2026-04-09";
const BLOCK_START = "<!-- ASM-WIKI-FIRST-BOOTSTRAP:START";
const BLOCK_END = "<!-- ASM-WIKI-FIRST-BOOTSTRAP:END -->";

export interface ReinforcementPatchResult {
	path: string;
	status: "patched" | "updated" | "already-current" | "missing-target";
	changed: boolean;
	blockVersion: string;
}

function buildManagedBlock(): string {
	return [
		`${BLOCK_START} version=${ASM_WIKI_FIRST_BLOCK_VERSION} -->`,
		"## ASM wiki-first bootstrap (managed by ASM)",
		"",
		"- Treat wiki pages as the primary working surface for project-specific work.",
		"- Use ASM runtime contract state for `projectWorkspaceRoot`, `slotDbDir`, and `wikiDir`.",
		"- Prefer `wiki-first` mode for implementation/debug/planning/investigation runs.",
		"- Treat this file as reinforcement only; installer/runtime config remains source-of-truth.",
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
		return {
			path,
			status: "missing-target",
			changed: false,
			blockVersion: ASM_WIKI_FIRST_BLOCK_VERSION,
		};
	}
}
