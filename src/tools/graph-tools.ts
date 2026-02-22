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

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { SlotDB } from "../db/slot-db.js";

// Singleton DB instances
const dbInstances = new Map<string, SlotDB>();

function getSlotDB(stateDir: string): SlotDB {
  let db = dbInstances.get(stateDir);
  if (!db) {
    db = new SlotDB(stateDir);
    dbInstances.set(stateDir, db);
  }
  return db;
}

function extractScope(sessionKey: string): { userId: string; agentId: string } {
  const parts = sessionKey.split(":");
  const agentId = parts.length >= 2 ? parts[1] : "main";
  const userId = parts.length >= 3 ? parts.slice(2).join(":") : "default";
  return { userId, agentId };
}

function createResult(text: string, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    details: { toolResult: { text } },
    isError,
  };
}

export function registerGraphTools(api: OpenClawPluginApi): void {
  // ===========================================================================
  // Tool 1: memory_graph_entity_get
  // ===========================================================================
  api.registerTool({
    name: "memory_graph_entity_get",
    description: `Retrieve an entity from the graph by its ID, or list entities with optional filters (type, name). Entities represent people, projects, technologies, or concepts with their properties.`,
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Entity UUID to retrieve" })),
      type: Type.Optional(Type.String({ description: "Filter by entity type: person, project, technology, concept" })),
      name: Type.Optional(Type.String({ description: "Filter by name (partial match)" })),
    }),
    async execute(
      _id: string,
      params: { id?: string; type?: string; name?: string },
      ctx: any,
    ) {
      try {
        const stateDir = ctx?.stateDir || process.env.OPENCLAW_STATE_DIR || `${process.env.HOME}/.openclaw`;
        const sessionKey = ctx?.sessionKey || "agent:main:default";
        const { userId, agentId } = extractScope(sessionKey);
        const db = getSlotDB(stateDir);

        // If ID provided, get single entity
        if (params.id) {
          const entity = db.graph.getEntity(userId, agentId, params.id);
          if (!entity) {
            return createResult(`Entity with ID "${params.id}" not found.`);
          }
          return createResult(
            JSON.stringify(
              {
                id: entity.id,
                name: entity.name,
                type: entity.type,
                properties: entity.properties,
                created_at: entity.created_at,
                updated_at: entity.updated_at,
              },
              null,
              2,
            ),
          );
        }

        // Otherwise list with filters
        const filter: { type?: string; name?: string } = {};
        if (params.type) filter.type = params.type;
        if (params.name) filter.name = params.name;

        const entities = db.graph.listEntities(userId, agentId, Object.keys(filter).length > 0 ? filter : undefined);

        if (entities.length === 0) {
          return createResult(
            params.type || params.name
              ? `No entities found${params.type ? ` with type "${params.type}"` : ""}${params.name ? ` matching name "${params.name}"` : ""}.`
              : "No entities stored yet. Use memory_graph_entity_set to create entities.",
          );
        }

        const summary = entities.map((e) => ({
          id: e.id,
          name: e.name,
          type: e.type,
          properties: Object.keys(e.properties).length > 0 ? e.properties : undefined,
        }));

        return createResult(`📦 Found ${entities.length} entity(s):\n\n${JSON.stringify(summary, null, 2)}`);
      } catch (error) {
        return createResult(`Error: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  });

  // ===========================================================================
  // Tool 2: memory_graph_entity_set
  // ===========================================================================
  api.registerTool({
    name: "memory_graph_entity_set",
    description: `Create or update an entity in the graph. Entities represent key concepts like people, projects, technologies. Use this to build a knowledge graph of your work context.`,
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Entity UUID (omit to create new)" })),
      name: Type.String({ description: "Entity name (e.g., 'MrC', 'OpenClaw Project', 'React')" }),
      type: Type.String({ description: "Entity type: person, project, technology, concept" }),
      properties: Type.Optional(
        Type.Record(Type.String(), Type.Any(), {
          description: "Additional properties as key-value pairs",
        }),
      ),
    }),
    async execute(
      _id: string,
      params: { id?: string; name: string; type: string; properties?: Record<string, any> },
      ctx: any,
    ) {
      try {
        const stateDir = ctx?.stateDir || process.env.OPENCLAW_STATE_DIR || `${process.env.HOME}/.openclaw`;
        const sessionKey = ctx?.sessionKey || "agent:main:default";
        const { userId, agentId } = extractScope(sessionKey);
        const db = getSlotDB(stateDir);

        let entity;
        if (params.id) {
          // Update existing
          entity = db.graph.updateEntity(userId, agentId, params.id, {
            name: params.name,
            type: params.type,
            properties: params.properties,
          });
          if (!entity) {
            return createResult(`Entity with ID "${params.id}" not found.`, true);
          }
          return createResult(
            `✏️ Entity updated:\n${JSON.stringify(
              { id: entity.id, name: entity.name, type: entity.type, properties: entity.properties },
              null,
              2,
            )}`,
          );
        } else {
          // Create new
          entity = db.graph.createEntity(userId, agentId, {
            name: params.name,
            type: params.type,
            properties: params.properties,
          });
          return createResult(
            `✅ Entity created:\n${JSON.stringify(
              { id: entity.id, name: entity.name, type: entity.type, properties: entity.properties },
              null,
              2,
            )}`,
          );
        }
      } catch (error) {
        return createResult(`Error: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  });

  // ===========================================================================
  // Tool 3: memory_graph_rel_add
  // ===========================================================================
  api.registerTool({
    name: "memory_graph_rel_add",
    description: `Create a relationship between two entities. Relationships define how entities connect (e.g., person 'manages' project, project 'uses' technology). Weight indicates strength (0.0-1.0).`,
    parameters: Type.Object({
      source_id: Type.String({ description: "Source entity UUID" }),
      target_id: Type.String({ description: "Target entity UUID" }),
      relation_type: Type.String({ description: "Relationship type: manages, uses, depends_on, works_with, created_by, etc." }),
      weight: Type.Optional(Type.Number({ description: "Relationship strength 0.0-1.0 (default: 1.0)" })),
      properties: Type.Optional(
        Type.Record(Type.String(), Type.Any(), {
          description: "Additional relationship properties",
        }),
      ),
    }),
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
        const stateDir = ctx?.stateDir || process.env.OPENCLAW_STATE_DIR || `${process.env.HOME}/.openclaw`;
        const sessionKey = ctx?.sessionKey || "agent:main:default";
        const { userId, agentId } = extractScope(sessionKey);
        const db = getSlotDB(stateDir);

        // Verify entities exist
        const source = db.graph.getEntity(userId, agentId, params.source_id);
        const target = db.graph.getEntity(userId, agentId, params.target_id);

        if (!source) {
          return createResult(`Source entity "${params.source_id}" not found.`, true);
        }
        if (!target) {
          return createResult(`Target entity "${params.target_id}" not found.`, true);
        }

        const rel = db.graph.createRelationship(userId, agentId, {
          source_entity_id: params.source_id,
          target_entity_id: params.target_id,
          relation_type: params.relation_type,
          weight: params.weight,
          properties: params.properties,
        });

        return createResult(
          `🔗 Relationship created:\n` +
            `${source.name} --[${params.relation_type}]--> ${target.name}\n\n` +
            JSON.stringify(
              {
                id: rel.id,
                source: source.name,
                target: target.name,
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

  // ===========================================================================
  // Tool 4: memory_graph_rel_remove
  // ===========================================================================
  api.registerTool({
    name: "memory_graph_rel_remove",
    description: `Delete a relationship by its ID, or delete a specific relationship between two entities.`,
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Relationship UUID to delete" })),
      source_id: Type.Optional(Type.String({ description: "Source entity UUID (alternative to id)" })),
      target_id: Type.Optional(Type.String({ description: "Target entity UUID (alternative to id)" })),
      relation_type: Type.Optional(Type.String({ description: "Relation type (alternative to id)" })),
    }),
    async execute(
      _id: string,
      params: { id?: string; source_id?: string; target_id?: string; relation_type?: string },
      ctx: any,
    ) {
      try {
        const stateDir = ctx?.stateDir || process.env.OPENCLAW_STATE_DIR || `${process.env.HOME}/.openclaw`;
        const sessionKey = ctx?.sessionKey || "agent:main:default";
        const { userId, agentId } = extractScope(sessionKey);
        const db = getSlotDB(stateDir);

        if (params.id) {
          // Delete by ID
          const deleted = db.graph.deleteRelationship(userId, agentId, params.id);
          if (deleted) {
            return createResult(`✅ Relationship "${params.id}" deleted.`);
          } else {
            return createResult(`Relationship "${params.id}" not found.`);
          }
        }

        // Need source + target + relation_type
        if (!params.source_id || !params.target_id || !params.relation_type) {
          return createResult(
            "Error: Either provide 'id' or provide 'source_id', 'target_id', and 'relation_type'.",
            true,
          );
        }

        // Find relationship by source/target/type
        const rels = db.graph.getRelationships(userId, agentId, params.source_id, "outgoing");
        const rel = rels.find(
          (r) =>
            r.target_entity_id === params.target_id && r.relation_type === params.relation_type,
        );

        if (!rel) {
          return createResult(
            `Relationship not found: ${params.source_id} --[${params.relation_type}]--> ${params.target_id}`,
          );
        }

        const deleted = db.graph.deleteRelationship(userId, agentId, rel.id);
        if (deleted) {
          return createResult(
            `✅ Relationship deleted: ${params.source_id} --[${params.relation_type}]--> ${params.target_id}`,
          );
        } else {
          return createResult("Failed to delete relationship.");
        }
      } catch (error) {
        return createResult(`Error: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  });

  // ===========================================================================
  // Tool 5: memory_graph_search
  // ===========================================================================
  api.registerTool({
    name: "memory_graph_search",
    description: `Search the knowledge graph by traversing from a starting entity. Finds connected entities up to a specified depth. Useful for discovering relationships and context around a person, project, or concept.`,
    parameters: Type.Object({
      entity_id: Type.String({ description: "Starting entity UUID to traverse from" }),
      depth: Type.Optional(Type.Number({ description: "Traversal depth (1-3, default: 2)" })),
      relation_type: Type.Optional(Type.String({ description: "Filter by specific relation type" })),
    }),
    async execute(
      _id: string,
      params: { entity_id: string; depth?: number; relation_type?: string },
      ctx: any,
    ) {
      try {
        const stateDir = ctx?.stateDir || process.env.OPENCLAW_STATE_DIR || `${process.env.HOME}/.openclaw`;
        const sessionKey = ctx?.sessionKey || "agent:main:default";
        const { userId, agentId } = extractScope(sessionKey);
        const db = getSlotDB(stateDir);

        // Get starting entity
        const startEntity = db.graph.getEntity(userId, agentId, params.entity_id);
        if (!startEntity) {
          return createResult(`Entity "${params.entity_id}" not found.`, true);
        }

        const depth = Math.min(Math.max(params.depth || 2, 1), 3); // Clamp 1-3

        // Traverse graph
        const result = db.graph.traverseGraph(userId, agentId, params.entity_id, depth);

        // Filter by relation type if specified
        let relationships = result.relationships;
        if (params.relation_type) {
          relationships = relationships.filter((r) => r.relation_type === params.relation_type);
        }

        // Build readable output
        let output = `🕸️ Graph Traversal from "${startEntity.name}" (depth: ${depth})\n\n`;

        output += `📦 Entities (${result.entities.length}):\n`;
        result.entities.forEach((e) => {
          output += `  • ${e.name} (${e.type})${e.id === params.entity_id ? " [START]" : ""}\n`;
        });

        output += `\n🔗 Relationships (${relationships.length}):\n`;
        relationships.forEach((r) => {
          const source = result.entities.find((e) => e.id === r.source_entity_id);
          const target = result.entities.find((e) => e.id === r.target_entity_id);
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
