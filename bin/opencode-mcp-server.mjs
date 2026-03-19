#!/usr/bin/env node
import process from "node:process";

const PROTOCOL_VERSION = "2024-11-05";

function makeTool(name, description, inputSchema) {
  return { name, description, inputSchema };
}

export function buildOpencodeMcpToolDescriptors() {
  return [
    makeTool(
      "asm_project_binding_preview",
      "Resolve ASM active project binding in read-only mode using project_id/project_alias/repo_root/session_project_alias selectors.",
      {
        type: "object",
        properties: {
          project_id: { type: "string" },
          project_alias: { type: "string" },
          repo_root: { type: "string" },
          session_project_alias: { type: "string" },
          allow_cross_project: { type: "boolean" },
        },
      },
    ),
    makeTool(
      "asm_project_opencode_search",
      "Run ASM read-only project-scoped retrieval for OpenCode after resolving project binding.",
      {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "number" },
          project_id: { type: "string" },
          project_alias: { type: "string" },
          repo_root: { type: "string" },
          session_project_alias: { type: "string" },
          explicit_project_id: { type: "string" },
          explicit_project_alias: { type: "string" },
          explicit_cross_project: { type: "boolean" },
        },
        required: ["query"],
      },
    ),
    makeTool(
      "asm_project_coding_packet",
      "Build coding packet (foundation lane) for OpenCode using ASM project-aware/code-aware retrieval context.",
      {
        type: "object",
        properties: {
          project_id: { type: "string" },
          project_alias: { type: "string" },
          query: { type: "string" },
          objective: { type: "string" },
          task_id: { type: "string" },
          tracker_issue_key: { type: "string" },
          task_title: { type: "string" },
          symbol_name: { type: "string" },
          relative_path: { type: "string" },
          route_path: { type: "string" },
          limit: { type: "number" },
          acceptance_criteria: { type: "array", items: { type: "string" } },
          constraints: { type: "array", items: { type: "string" } },
          out_of_scope: { type: "array", items: { type: "string" } },
          validation_commands: { type: "array", items: { type: "string" } },
        },
      },
    ),
  ];
}

let usecasePortPromise = null;
async function getUseCasePort() {
  if (!usecasePortPromise) {
    usecasePortPromise = (async () => {
      const { resolveAsmRuntimeConfig } = await import(new URL("../dist/shared/asm-config.js", import.meta.url));
      const { SlotDB } = await import(new URL("../dist/db/slot-db.js", import.meta.url));
      const { DefaultMemoryUseCasePort } = await import(new URL("../dist/core/usecases/default-memory-usecase-port.js", import.meta.url));
      const runtimeConfig = resolveAsmRuntimeConfig({ env: process.env, homeDir: process.env.HOME });
      const slotDbDir = runtimeConfig.slotDbDir;
      const db = new SlotDB(slotDbDir);
      return { db, usecase: new DefaultMemoryUseCasePort(db) };
    })();
  }
  return usecasePortPromise;
}

function response(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function errorResponse(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

let outputTransportMode = "content-length";

function setOutputTransportMode(mode) {
  if (mode === "json-line" || mode === "content-length") {
    outputTransportMode = mode;
  }
}

function writeMessage(message) {
  const encoded = JSON.stringify(message);
  if (outputTransportMode === "json-line") {
    process.stdout.write(`${encoded}\n`);
    return;
  }

  const body = Buffer.from(encoded, "utf8");
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8");
  process.stdout.write(Buffer.concat([header, body]));
}

async function handleToolCall(name, args) {
  const { usecase } = await getUseCasePort();
  const context = {
    userId: process.env.ASM_MCP_USER_ID || "default",
    agentId: process.env.ASM_MCP_AGENT_ID || "opencode",
  };

  if (name === "asm_project_binding_preview") {
    const data = await usecase.run("project.binding_preview", {
      context,
      meta: { source: "cli", toolName: "asm.mcp.opencode.binding_preview" },
      payload: args || {},
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }

  if (name === "asm_project_opencode_search") {
    const data = await usecase.run("project.opencode_search", {
      context,
      meta: { source: "cli", toolName: "asm.mcp.opencode.search" },
      payload: args || {},
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }

  if (name === "asm_project_coding_packet") {
    const data = await usecase.run("project.coding_packet", {
      context,
      meta: { source: "cli", toolName: "asm.mcp.opencode.coding_packet" },
      payload: args || {},
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }

  return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
}

async function processRpcMessage(message) {
  const { id, method, params } = message || {};
  const hasId = id !== undefined && id !== null;

  if (method === "initialize") {
    if (!hasId) return;
    writeMessage(response(id, {
      protocolVersion: PROTOCOL_VERSION,
      serverInfo: { name: "asm-opencode-mcp", version: "1.0.0" },
      capabilities: { tools: { listChanged: false } },
    }));
    return;
  }

  if (method === "notifications/initialized") {
    return;
  }

  if (method === "tools/list") {
    if (!hasId) return;
    writeMessage(response(id, { tools: buildOpencodeMcpToolDescriptors() }));
    return;
  }

  if (method === "tools/call") {
    if (!hasId) return;
    try {
      const result = await handleToolCall(params?.name, params?.arguments || {});
      writeMessage(response(id, result));
    } catch (error) {
      writeMessage(response(id, {
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      }));
    }
    return;
  }

  if (!hasId) {
    return;
  }

  writeMessage(errorResponse(id, -32601, `Method not found: ${method}`));
}

function findHeaderBoundary(buffer) {
  const crlf = buffer.indexOf("\r\n\r\n");
  if (crlf !== -1) {
    return { headerEnd: crlf, separatorLength: 4 };
  }

  const lf = buffer.indexOf("\n\n");
  if (lf !== -1) {
    return { headerEnd: lf, separatorLength: 2 };
  }

  return null;
}

function takeJsonLineMessage(buffer) {
  if (!buffer.length) return null;
  const first = String.fromCharCode(buffer[0]);
  if (first !== "{" && first !== "[") return null;

  const newlineIndex = buffer.indexOf("\n");
  if (newlineIndex === -1) return null;

  const line = buffer.slice(0, newlineIndex).toString("utf8").trim();
  if (!line) {
    return { consumed: newlineIndex + 1, message: null };
  }

  return { consumed: newlineIndex + 1, message: line };
}

export async function runOpencodeMcpServer() {
  let buffer = Buffer.alloc(0);
  let requestChain = Promise.resolve();

  const enqueue = (message) => {
    requestChain = requestChain
      .then(() => processRpcMessage(message))
      .catch((error) => {
        writeMessage(errorResponse(null, -32603, error instanceof Error ? error.message : String(error)));
      });
  };

  const onData = (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (true) {
      const boundary = findHeaderBoundary(buffer);
      if (boundary) {
        const { headerEnd, separatorLength } = boundary;
        const headerText = buffer.slice(0, headerEnd).toString("utf8");
        const match = headerText.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          buffer = buffer.slice(headerEnd + separatorLength);
          continue;
        }

        const contentLength = Number(match[1]);
        const totalLength = headerEnd + separatorLength + contentLength;
        if (!Number.isFinite(contentLength) || contentLength < 0) {
          buffer = buffer.slice(headerEnd + separatorLength);
          continue;
        }
        if (buffer.length < totalLength) break;

        const body = buffer.slice(headerEnd + separatorLength, totalLength).toString("utf8");
        buffer = buffer.slice(totalLength);
        setOutputTransportMode("content-length");

        try {
          const message = JSON.parse(body);
          enqueue(message);
        } catch (error) {
          writeMessage(errorResponse(null, -32700, error instanceof Error ? error.message : String(error)));
        }
        continue;
      }

      const jsonLine = takeJsonLineMessage(buffer);
      if (!jsonLine) {
        break;
      }

      buffer = buffer.slice(jsonLine.consumed);
      if (!jsonLine.message) {
        continue;
      }
      setOutputTransportMode("json-line");

      try {
        const message = JSON.parse(jsonLine.message);
        enqueue(message);
      } catch (error) {
        writeMessage(errorResponse(null, -32700, error instanceof Error ? error.message : String(error)));
      }
    }
  };

  if (typeof process.stdin.resume === "function") {
    process.stdin.resume();
  }

  process.stdin.on("data", onData);

  await new Promise((resolve) => {
    let closed = false;
    const finish = () => {
      if (closed) return;
      closed = true;
      resolve(undefined);
    };

    process.stdin.on("end", finish);
    process.stdin.on("close", finish);
    process.on("SIGINT", finish);
    process.on("SIGTERM", finish);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runOpencodeMcpServer();
}
