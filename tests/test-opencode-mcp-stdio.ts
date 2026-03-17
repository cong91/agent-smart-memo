import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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
  proc: ReturnType<typeof spawn>,
  predicate: (msg: JsonRpcMessage) => boolean,
  timeoutMs = 5000,
): Promise<JsonRpcMessage> {
  return await new Promise((resolve, reject) => {
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
      proc.off("exit", onExit);
    };

    proc.stdout?.on("data", onData);
    proc.on("exit", onExit);
  });
}

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const serverPath = join(here, "..", "bin", "opencode-mcp-server.mjs");

  const proc = spawn(process.execPath, [serverPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ASM_MCP_AGENT_ID: "opencode" },
  });

  try {
    proc.stdin.write(encodeMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "smoke", version: "1.0.0" },
      },
    }));

    const init = await waitForResponse(proc, (msg) => msg.id === 1);
    assert(init.result?.protocolVersion === "2024-11-05", "initialize response must return protocol version");

    proc.stdin.write(encodeMessage({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    }));

    proc.stdin.write(encodeMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    }));

    const toolsList = await waitForResponse(proc, (msg) => msg.id === 2);
    const tools = Array.isArray(toolsList.result?.tools) ? toolsList.result.tools : [];
    const toolNames = tools.map((tool: any) => String(tool?.name || "")).sort();

    assert(toolNames.length === 2, "tools/list must return exactly 2 read-only tools");
    assert(toolNames[0] === "asm_project_binding_preview", "missing asm_project_binding_preview");
    assert(toolNames[1] === "asm_project_opencode_search", "missing asm_project_opencode_search");

    console.log("✅ opencode MCP stdio smoke passed");
  } finally {
    proc.stdin.end();
    proc.kill("SIGTERM");
    await once(proc, "exit");
  }
}

main().catch((error) => {
  console.error("❌ opencode MCP stdio smoke failed");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
