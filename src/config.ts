/**
 * @deprecated
 * Legacy runtime config module is intentionally neutralized.
 * Runtime configuration must come from ASM shared config via:
 *   - resolveAsmRuntimeConfig(...) in src/shared/asm-config.ts
 *   - resolveAsmCore* helpers for read-only access
 */

function throwDeprecatedConfigAccess(symbolName: string): never {
	throw new Error(
		`[ASM-104] ${symbolName} is deprecated in src/config.ts. ` +
			"Use src/shared/asm-config.ts (ASM shared config) as the single runtime source-of-truth.",
	);
}

/**
 * @deprecated Legacy symbol retained only for import compatibility.
 * Any runtime access throws to prevent hidden env/default fallback behavior.
 */
export const PluginConfig = new Proxy({} as Record<string, unknown>, {
	get(_target, prop) {
		return throwDeprecatedConfigAccess(`PluginConfig.${String(prop)}`);
	},
}) as Record<string, unknown>;

/**
 * @deprecated Legacy symbol retained only for import compatibility.
 */
export async function validateConfig(): Promise<{
	qdrant: boolean;
	ollama: boolean;
}> {
	return throwDeprecatedConfigAccess("validateConfig()");
}

/**
 * @deprecated Legacy symbol retained only for import compatibility.
 */
export function printConfig(): void {
	return throwDeprecatedConfigAccess("printConfig()");
}
