/**
 * Graph Tools for OpenClaw Agent - Task 3.2
 *
 * 5 agent tools for graph operations:
 * - memory_graph_entity_get: Get entity by ID
 * - memory_graph_entity_set: Create/update entity
 * - memory_graph_rel_add: Create relationship
 * - memory_graph_rel_remove: Delete relationship
 * - memory_graph_search: Search entities + traverse graph
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import {
  configureOpenClawRuntime,
  createOpenClawResult,
  getMemoryUseCasePortForContext,
  getSessionKey,
  parseOpenClawSessionIdentity,
} from "../adapters/openclaw/tool-runtime.js";

function createResult(text: string, isError = false) {
  return createOpenClawResult(text, isError);
}

export function registerGraphTools(
  api: OpenClawPluginApi,
  options?: { stateDir?: string; slotDbDir?: string },
): void {
  configureOpenClawRuntime(options);

  // ==========================================================================
  // Tool 1: memory_graph_entity_get
  // ==========================================================================
  api.registerTool({
    name: "memory_graph_entity_get",
    label: "Graph Entity Get",
    description: `Retrieve an entity from the graph by its ID, or list entities with optional filters (type, name). Entities represent people, projects, technologies, or concepts with their properties.`,
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Entity UUID to retrieve" },
        type: { type: "string", description: "Filter by entity type: person, project, technology, concept" },
        name: { type: "string", description: "Filter by name (partial match)" },
      },
    },
    async execute(
      _id: string,
      params: { id?: string; type?: string; name?: string },
      ctx: any,
    ) {
      try {
        const sessionKey = getSessionKey(ctx);
        const { userId, agentId } = parseOpenClawSessionIdentity(sessionKey);
        const useCasePort = getMemoryUseCasePortForContext(ctx);

        const data = await useCasePort.run<typeof params, any>("graph.entity.get", {
          context: { userId, agentId },
          payload: params,
          meta: {
            source: "openclaw",
            toolName: "memory_graph_entity_get",
            requestId: _id,
          },
        });

        if (!data || (Array.isArray(data) && data.length === 0)) {
          return createResult(
            params.type || params.name
              ? `No entities found${params.type ? ` with type "${params.type}"` : ""}${params.name ? ` matching name "${params.name}"` : ""}.`
              : "No entities stored yet. Use memory_graph_entity_set to create entities.",
          );
        }

        if (!Array.isArray(data)) {
          return createResult(
            JSON.stringify(
              {
                id: data.id,
                name: data.name,
                type: data.type,
                properties: data.properties,
                created_at: data.created_at,
                updated_at: data.updated_at,
              },
              null,
              2,
            ),
          );
        }

        const summary = data.map((e: any) => ({
          id: e.id,
          name: e.name,
          type: e.type,
          properties: Object.keys(e.properties || {}).length > 0 ? e.properties : undefined,
        }));

        return createResult(`📦 Found ${data.length} entity(s):\n\n${JSON.stringify(summary, null, 2)}`);
      } catch (error) {
        return createResult(`Error: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  });

  // ==========================================================================
  // Tool 2: memory_graph_entity_set
  // ==========================================================================
  api.registerTool({
    name: "memory_graph_entity_set",
    label: "Graph Entity Set",
    description: `Create or update an entity in the graph. Entities represent key concepts like people, projects, technologies. Use this to build a knowledge graph of your work context.`,
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Entity UUID (omit to create new)" },
        name: { type: "string", description: "Entity name (e.g., 'MrC', 'OpenClaw Project', 'React')" },
        type: { type: "string", description: "Entity type: person, project, technology, concept" },
        properties: {
          type: "object",
          description: "Additional properties as key-value pairs",
        },
      },
      required: ["name", "type"],
    },
    async execute(
      _id: string,
      params: { id?: string; name: string; type: string; properties?: Record<string, any> },
      ctx: any,
    ) {
      try {
        const sessionKey = getSessionKey(ctx);
        const { userId, agentId } = parseOpenClawSessionIdentity(sessionKey);
        const useCasePort = getMemoryUseCasePortForContext(ctx);

        const entity = await useCasePort.run<typeof params, any>("graph.entity.set", {
          context: { userId, agentId },
          payload: params,
          meta: {
            source: "openclaw",
            toolName: "memory_graph_entity_set",
            requestId: _id,
          },
        });

        if (params.id) {
          return createResult(
            `✏️ Entity updated:\n${JSON.stringify(
              { id: entity.id, name: entity.name, type: entity.type, properties: entity.properties },
              null,
              2,
            )}`,
          );
        }

        return createResult(
          `✅ Entity created:\n${JSON.stringify(
            { id: entity.id, name: entity.name, type: entity.type, properties: entity.properties },
            null,
            2,
          )}`,
        );
      } catch (error) {
        return createResult(`Error: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  });

  // ==========================================================================
  // Tool 3: memory_graph_rel_add
  // ==========================================================================
  api.registerTool({
    name: "memory_graph_rel_add",
    label: "Graph Relationship Add",
    description: `Create a relationship between two entities. Relationships define how entities connect (e.g., person 'manages' project, project 'uses' technology). Weight indicates strength (0.0-1.0).`,
    parameters: {
      type: "object",
      properties: {
        source_id: { type: "string", description: "Source entity UUID" },
        target_id: { type: "string", description: "Target entity UUID" },
        relation_type: { type: "string", description: "Relationship type: manages, uses, depends_on, works_with, created_by, etc." },
        weight: { type: "number", description: "Relationship strength 0.0-1.0 (default: 1.0)" },
        properties: {
          type: "object",
          description: "Additional relationship properties",
        },
      },
      required: ["source_id", "target_id", "relation_type"],
    },
    async execute(
      _id: string,
      params: {
        source_id: string;
        target_id: string;
        relation_type: string;
        weight?: number;
        properties?: Record<string, any>;
      },
      ctx: any,
    ) {
      try {
        const sessionKey = getSessionKey(ctx);
        const { userId, agentId } = parseOpenClawSessionIdentity(sessionKey);
        const useCasePort = getMemoryUseCasePortForContext(ctx);

        const rel = await useCasePort.run<typeof params, any>("graph.rel.add", {
          context: { userId, agentId },
          payload: params,
          meta: {
            source: "openclaw",
            toolName: "memory_graph_rel_add",
            requestId: _id,
          },
        });

        const source = await useCasePort.run<{ id: string }, any>("graph.entity.get", {
          context: { userId, agentId },
          payload: { id: params.source_id },
          meta: { source: "openclaw", toolName: "memory_graph_rel_add", requestId: _id },
        });

        const target = await useCasePort.run<{ id: string }, any>("graph.entity.get", {
          context: { userId, agentId },
          payload: { id: params.target_id },
          meta: { source: "openclaw", toolName: "memory_graph_rel_add", requestId: _id },
        });

        return createResult(
          `🔗 Relationship created:\n` +
            `${source?.name || params.source_id} --[${params.relation_type}]--> ${target?.name || params.target_id}\n\n` +
            JSON.stringify(
              {
                id: rel.id,
                source: source?.name || params.source_id,
                target: target?.name || params.target_id,
                relation_type: rel.relation_type,
                weight: rel.weight,
                properties: rel.properties,
              },
              null,
              2,
            ),
        );
      } catch (error) {
        return createResult(`Error: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  });

  // ==========================================================================
  // Tool 4: memory_graph_rel_remove
  // ==========================================================================
  api.registerTool({
    name: "memory_graph_rel_remove",
    label: "Graph Relationship Remove",
    description: `Delete a relationship by its ID, or delete a specific relationship between two entities.`,
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Relationship UUID to delete" },
        source_id: { type: "string", description: "Source entity UUID (alternative to id)" },
        target_id: { type: "string", description: "Target entity UUID (alternative to id)" },
        relation_type: { type: "string", description: "Relation type (alternative to id)" },
      },
    },
    async execute(
      _id: string,
      params: { id?: string; source_id?: string; target_id?: string; relation_type?: string },
      ctx: any,
    ) {
      try {
        const sessionKey = getSessionKey(ctx);
        const { userId, agentId } = parseOpenClawSessionIdentity(sessionKey);
        const useCasePort = getMemoryUseCasePortForContext(ctx);

        const result = await useCasePort.run<typeof params, { deleted: boolean }>("graph.rel.remove", {
          context: { userId, agentId },
          payload: params,
          meta: {
            source: "openclaw",
            toolName: "memory_graph_rel_remove",
            requestId: _id,
          },
        });

        if (params.id) {
          return createResult(
            result.deleted
              ? `✅ Relationship "${params.id}" deleted.`
              : `Relationship "${params.id}" not found.`,
          );
        }

        if (!params.source_id || !params.target_id || !params.relation_type) {
          return createResult(
            "Error: Either provide 'id' or provide 'source_id', 'target_id', and 'relation_type'.",
            true,
          );
        }

        return createResult(
          result.deleted
            ? `✅ Relationship deleted: ${params.source_id} --[${params.relation_type}]--> ${params.target_id}`
            : `Relationship not found: ${params.source_id} --[${params.relation_type}]--> ${params.target_id}`,
        );
      } catch (error) {
        return createResult(`Error: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  });

  // ==========================================================================
  // Tool 5: memory_graph_search
  // ==========================================================================
  api.registerTool({
    name: "memory_graph_search",
    label: "Graph Search",
    description: `Search the knowledge graph by traversing from a starting entity. Finds connected entities up to a specified depth. Useful for discovering relationships and context around a person, project, or concept.`,
    parameters: {
      type: "object",
      properties: {
        entity_id: { type: "string", description: "Starting entity UUID to traverse from" },
        depth: { type: "number", description: "Traversal depth (1-3, default: 2)" },
        relation_type: { type: "string", description: "Filter by specific relation type" },
      },
      required: ["entity_id"],
    },
    async execute(
      _id: string,
      params: { entity_id: string; depth?: number; relation_type?: string },
      ctx: any,
    ) {
      try {
        const sessionKey = getSessionKey(ctx);
        const { userId, agentId } = parseOpenClawSessionIdentity(sessionKey);
        const useCasePort = getMemoryUseCasePortForContext(ctx);

        const startEntity = await useCasePort.run<{ id: string }, any>("graph.entity.get", {
          context: { userId, agentId },
          payload: { id: params.entity_id },
          meta: {
            source: "openclaw",
            toolName: "memory_graph_search",
            requestId: _id,
          },
        });

        if (!startEntity) {
          return createResult(`Entity "${params.entity_id}" not found.`, true);
        }

        const depth = Math.min(Math.max(params.depth || 2, 1), 3);
        const traversed = await useCasePort.run<typeof params, { entities: any[]; relationships: any[] }>("graph.search", {
          context: { userId, agentId },
          payload: {
            entity_id: params.entity_id,
            depth,
            relation_type: params.relation_type,
          },
          meta: {
            source: "openclaw",
            toolName: "memory_graph_search",
            requestId: _id,
          },
        });

        let output = `🕸️ Graph Traversal from "${startEntity.name}" (depth: ${depth})\n\n`;

        output += `📦 Entities (${traversed.entities.length}):\n`;
        traversed.entities.forEach((e) => {
          output += `  • ${e.name} (${e.type})${e.id === params.entity_id ? " [START]" : ""}\n`;
        });

        output += `\n🔗 Relationships (${traversed.relationships.length}):\n`;
        traversed.relationships.forEach((r) => {
          const source = traversed.entities.find((e) => e.id === r.source_entity_id);
          const target = traversed.entities.find((e) => e.id === r.target_entity_id);
          output += `  ${source?.name || "?"} --[${r.relation_type}]--> ${target?.name || "?"}`;
          if (r.weight !== 1.0) output += ` (weight: ${r.weight})`;
          output += `\n`;
        });

        return createResult(output);
      } catch (error) {
        return createResult(`Error: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  });
}
