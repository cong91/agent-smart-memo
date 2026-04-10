import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	doctorAsmSharedConfig,
	getAsmSharedConfig,
	invalidateAsmSharedConfigCache,
	loadAsmSharedConfig,
	resolveAsmAdapterLocalConfig,
	resolveAsmConfigPath,
	resolveAsmConfigPathInfo,
	resolveAsmCoreProjectWorkspaceRoot,
	resolveAsmCoreSlotDbDir,
} from "../src/shared/asm-config.js";

function assert(condition: boolean, message: string): void {
	if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

function assertEqual(
	actual: unknown,
	expected: unknown,
	message: string,
): void {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a !== e) {
		throw new Error(`${message}\nactual=${a}\nexpected=${e}`);
	}
}

const TEST_ROOT = join(tmpdir(), `agent-memo-asm-shared-config-${Date.now()}`);
const HOME_DIR = join(TEST_ROOT, "home");
const CONFIG_DIR = join(HOME_DIR, ".config", "asm");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

console.log("\n🧪 ASM Shared Config Slice 2 Tests\n");

try {
	mkdirSync(CONFIG_DIR, { recursive: true });

	writeFileSync(
		CONFIG_PATH,
		JSON.stringify(
			{
				schemaVersion: 1,
				core: {
					projectWorkspaceRoot: "~/workspace/projects",
					storage: {
						slotDbDir: "~/data/slotdb",
					},
				},
				adapters: {
					openclaw: {
						enabled: true,
						pluginMode: "runtime",
					},
					opencode: {
						enabled: true,
						mode: "read-only",
					},
					broken: "should-be-ignored",
				},
			},
			null,
			2,
		),
		"utf8",
	);

	const defaultPath = resolveAsmConfigPath({
		homeDir: HOME_DIR,
		env: {} as NodeJS.ProcessEnv,
	});
	assertEqual(
		defaultPath,
		CONFIG_PATH,
		"default path must resolve to ~/.config/asm/config.json",
	);
	console.log("✅ default shared config path");

	const explicitPath = resolveAsmConfigPath({
		homeDir: HOME_DIR,
		env: { ASM_CONFIG: join(HOME_DIR, "override.json") } as NodeJS.ProcessEnv,
	});
	assertEqual(
		explicitPath,
		join(HOME_DIR, "override.json"),
		"ASM_CONFIG must override default path",
	);

	const explicitInfo = resolveAsmConfigPathInfo({
		homeDir: HOME_DIR,
		configPath: CONFIG_PATH,
		env: { ASM_CONFIG: join(HOME_DIR, "override.json") } as NodeJS.ProcessEnv,
	});
	assertEqual(
		explicitInfo.source,
		"explicit",
		"explicit configPath must take precedence over ASM_CONFIG",
	);

	const envInfo = resolveAsmConfigPathInfo({
		homeDir: HOME_DIR,
		env: { ASM_CONFIG: join(HOME_DIR, "override.json") } as NodeJS.ProcessEnv,
	});
	assertEqual(
		envInfo.source,
		"env",
		"ASM_CONFIG path source must be env when explicit path missing",
	);
	assertEqual(
		envInfo.exists,
		false,
		"non-existing ASM_CONFIG path must be marked exists=false",
	);
	console.log("✅ ASM_CONFIG precedence + path source semantics");

	invalidateAsmSharedConfigCache(CONFIG_PATH);
	const firstLoad = loadAsmSharedConfig({
		configPath: CONFIG_PATH,
		homeDir: HOME_DIR,
		reload: false,
	});
	assert(
		firstLoad.lifecycle.cache === "miss",
		"first load should be cache miss",
	);
	assert(
		firstLoad.lifecycle.status === "ok",
		"valid config must return status=ok",
	);

	const secondLoad = loadAsmSharedConfig({
		configPath: CONFIG_PATH,
		homeDir: HOME_DIR,
		reload: false,
	});
	assert(
		secondLoad.lifecycle.cache === "hit",
		"second load should be cache hit",
	);
	assert(secondLoad.lifecycle.status === "ok", "cache hit keeps status=ok");

	const reloadLoad = loadAsmSharedConfig({
		configPath: CONFIG_PATH,
		homeDir: HOME_DIR,
		reload: true,
	});
	assert(
		reloadLoad.lifecycle.cache === "bypass",
		"reload=true should bypass cache",
	);
	assert(
		reloadLoad.lifecycle.source === "explicit",
		"explicit config path should mark source=explicit",
	);

	const viaGet = getAsmSharedConfig({
		configPath: CONFIG_PATH,
		homeDir: HOME_DIR,
	});
	assert(
		viaGet.lifecycle.status === "ok",
		"get helper should mirror load semantics",
	);
	console.log("✅ load/reload lifecycle + get semantics");

	const coreSlotDbDir = resolveAsmCoreSlotDbDir({
		configPath: CONFIG_PATH,
		homeDir: HOME_DIR,
	});
	assertEqual(
		coreSlotDbDir,
		join(HOME_DIR, "data", "slotdb"),
		"core.storage.slotDbDir should resolve with ~ expansion",
	);

	const workspaceRoot = resolveAsmCoreProjectWorkspaceRoot({
		configPath: CONFIG_PATH,
		homeDir: HOME_DIR,
	});
	assertEqual(
		workspaceRoot,
		join(HOME_DIR, "workspace", "projects"),
		"core.projectWorkspaceRoot should resolve with ~ expansion",
	);
	console.log("✅ core/global config resolution");

	const openclawConfig = resolveAsmAdapterLocalConfig("openclaw", {
		configPath: CONFIG_PATH,
		homeDir: HOME_DIR,
	});
	assertEqual(
		openclawConfig,
		{ enabled: true, pluginMode: "runtime" },
		"must resolve adapter-local config under adapters.openclaw",
	);

	const brokenConfig = resolveAsmAdapterLocalConfig("broken", {
		configPath: CONFIG_PATH,
		homeDir: HOME_DIR,
	});
	assertEqual(
		brokenConfig,
		undefined,
		"non-object adapter entries must be ignored",
	);

	const doctor = doctorAsmSharedConfig({
		configPath: CONFIG_PATH,
		homeDir: HOME_DIR,
	});
	assertEqual(doctor.status, "ok", "doctor should report ok for valid config");
	assertEqual(
		doctor.hasCore,
		true,
		"doctor should report hasCore=true when core exists",
	);
	assert(
		doctor.adapterNames.includes("openclaw"),
		"doctor should list adapter names",
	);
	assert(
		doctor.warnings.some((item) => item.includes("adapters.broken")),
		"doctor should expose normalization warnings",
	);
	console.log("✅ adapter-local isolation + doctor semantics");

	writeFileSync(
		CONFIG_PATH,
		JSON.stringify(
			{
				schemaVersion: 1,
				projectWorkspaceRoot: "~/legacy-workspace",
				storage: {
					slotDbDir: "~/legacy-slotdb",
				},
			},
			null,
			2,
		),
		"utf8",
	);

	const legacySlotDbDir = resolveAsmCoreSlotDbDir({
		configPath: CONFIG_PATH,
		homeDir: HOME_DIR,
		reload: true,
	});
	assertEqual(
		legacySlotDbDir,
		join(HOME_DIR, "legacy-slotdb"),
		"legacy top-level slotDbDir must remain compatible",
	);

	const legacyWorkspaceRoot = resolveAsmCoreProjectWorkspaceRoot({
		configPath: CONFIG_PATH,
		homeDir: HOME_DIR,
		reload: true,
	});
	assertEqual(
		legacyWorkspaceRoot,
		join(HOME_DIR, "legacy-workspace"),
		"legacy top-level projectWorkspaceRoot must remain compatible",
	);

	const legacyDoctor = doctorAsmSharedConfig({
		configPath: CONFIG_PATH,
		homeDir: HOME_DIR,
		reload: true,
	});
	assertEqual(
		legacyDoctor.legacyKeys.projectWorkspaceRoot,
		true,
		"doctor should detect legacy projectWorkspaceRoot",
	);
	assertEqual(
		legacyDoctor.legacyKeys.storageSlotDbDir,
		true,
		"doctor should detect legacy storage.slotDbDir",
	);
	console.log("✅ migration compatibility direction + legacy doctor signals");

	const invalidJsonPath = join(CONFIG_DIR, "invalid.json");
	writeFileSync(invalidJsonPath, "{ not-json", "utf8");
	const invalidLoad = loadAsmSharedConfig({
		configPath: invalidJsonPath,
		homeDir: HOME_DIR,
		reload: true,
	});
	assertEqual(
		invalidLoad.lifecycle.status,
		"invalid_json",
		"invalid JSON should be safe-failure with status=invalid_json",
	);

	const missingPath = join(CONFIG_DIR, "missing.json");
	const missingDoctor = doctorAsmSharedConfig({
		configPath: missingPath,
		homeDir: HOME_DIR,
		reload: true,
	});
	assertEqual(
		missingDoctor.status,
		"missing",
		"doctor should report missing for absent file",
	);
	assertEqual(
		missingDoctor.exists,
		false,
		"doctor missing config should have exists=false",
	);
	console.log("✅ safe failure behavior for invalid/missing config");

	console.log("\n🎉 ASM shared config Slice 3 tests passed\n");
} finally {
	rmSync(TEST_ROOT, { recursive: true, force: true });
}
