import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { once } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function assert(condition: boolean, message: string): void {
	if (!condition) throw new Error(message);
}

interface JsonRpcMessage {
	jsonrpc: string;
	id?: number | string | null;
	method?: string;
	params?: any;
	result?: any;
	error?: any;
}

function encodeMessage(message: JsonRpcMessage): Buffer {
	const body = Buffer.from(JSON.stringify(message), "utf8");
	const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8");
	return Buffer.concat([header, body]);
}

async function waitForResponse(
	proc: ChildProcessWithoutNullStreams,
	predicate: (msg: JsonRpcMessage) => boolean,
	timeoutMs = 5000,
): Promise<JsonRpcMessage> {
	return await new Promise((resolve, reject) => {
		const procEvents = proc as unknown as EventEmitter;
		let buffer = Buffer.alloc(0);
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error("Timeout waiting for MCP response"));
		}, timeoutMs);

		const onData = (chunk: Buffer) => {
			buffer = Buffer.concat([buffer, chunk]);
			while (true) {
				const headerEnd = buffer.indexOf("\r\n\r\n");
				if (headerEnd === -1) return;

				const headerText = buffer.slice(0, headerEnd).toString("utf8");
				const match = headerText.match(/Content-Length:\s*(\d+)/i);
				if (!match) {
					buffer = buffer.slice(headerEnd + 4);
					continue;
				}

				const contentLength = Number(match[1]);
				const totalLength = headerEnd + 4 + contentLength;
				if (buffer.length < totalLength) return;

				const body = buffer.slice(headerEnd + 4, totalLength).toString("utf8");
				buffer = buffer.slice(totalLength);

				try {
					const parsed = JSON.parse(body) as JsonRpcMessage;
					if (predicate(parsed)) {
						cleanup();
						resolve(parsed);
						return;
					}
				} catch {
					// ignore unrelated malformed packet in test harness
				}
			}
		};

		const onExit = () => {
			cleanup();
			reject(new Error("MCP server exited before expected response"));
		};

		const cleanup = () => {
			clearTimeout(timer);
			proc.stdout?.off("data", onData);
			procEvents.off("exit", onExit);
		};

		proc.stdout?.on("data", onData);
		procEvents.on("exit", onExit);
	});
}

async function main() {
	const here = dirname(fileURLToPath(import.meta.url));
	const serverPath = join(here, "..", "bin", "opencode-mcp-server.mjs");
	const tempRoot = mkdtempSync(join(tmpdir(), "asm-opencode-mcp-"));
	const asmConfigPath = join(tempRoot, "config.json");
	const slotDbDir = join(tempRoot, "slotdb");

	writeFileSync(
		asmConfigPath,
		`${JSON.stringify(
			{
				schemaVersion: 1,
				core: {
					projectWorkspaceRoot: join(tempRoot, "workspace"),
					qdrantHost: "localhost",
					qdrantPort: 6333,
					qdrantCollection: "mrc_bot",
					qdrantVectorSize: 1024,
					llmBaseUrl: "http://localhost:8317/v1",
					llmApiKey: "test-key",
					llmModel: "gpt-5.4",
					embedBaseUrl: "http://localhost:11434",
					embedBackend: "ollama",
					embedModel: "qwen3-embedding:0.6b",
					embedDimensions: 1024,
					autoCaptureEnabled: true,
					autoCaptureMinConfidence: 0.7,
					contextWindowMaxTokens: 32000,
					summarizeEveryActions: 6,
					storage: {
						slotDbDir,
					},
				},
				adapters: {
					opencode: { enabled: true, mode: "read-only" },
				},
			},
			null,
			2,
		)}\n`,
		"utf8",
	);

	const proc: ChildProcessWithoutNullStreams = spawn(
		process.execPath,
		[serverPath],
		{
			stdio: ["pipe", "pipe", "pipe"],
			env: {
				...process.env,
				ASM_MCP_AGENT_ID: "opencode",
				ASM_CONFIG: asmConfigPath,
			},
		},
	);

	try {
		proc.stdin.write(
			encodeMessage({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2024-11-05",
					capabilities: {},
					clientInfo: { name: "smoke", version: "1.0.0" },
				},
			}),
		);

		const init = await waitForResponse(proc, (msg) => msg.id === 1);
		assert(
			init.result?.protocolVersion === "2024-11-05",
			"initialize response must return protocol version",
		);

		proc.stdin.write(
			encodeMessage({
				jsonrpc: "2.0",
				method: "notifications/initialized",
				params: {},
			}),
		);

		proc.stdin.write(
			encodeMessage({
				jsonrpc: "2.0",
				id: 2,
				method: "tools/list",
				params: {},
			}),
		);

		const toolsList = await waitForResponse(proc, (msg) => msg.id === 2);
		const tools = Array.isArray(toolsList.result?.tools)
			? toolsList.result.tools
			: [];
		const toolNames = tools.map((tool: any) => String(tool?.name || "")).sort();

		assert(
			toolNames.length === 3,
			"tools/list must return exactly 3 read-only tools",
		);
		assert(
			toolNames[0] === "asm_project_binding_preview",
			"missing asm_project_binding_preview",
		);
		assert(
			toolNames[1] === "asm_project_coding_packet",
			"missing asm_project_coding_packet",
		);
		assert(
			toolNames[2] === "asm_project_opencode_search",
			"missing asm_project_opencode_search",
		);

		console.log("✅ opencode MCP stdio smoke passed");
	} finally {
		proc.stdin.end();
		proc.kill("SIGTERM");
		await once(proc as unknown as EventEmitter, "exit");
	}
}

main().catch((error) => {
	console.error("❌ opencode MCP stdio smoke failed");
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
