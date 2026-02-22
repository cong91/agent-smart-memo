/**
 * GraphDB — SQLite-backed graph storage for entity relationships
 *
 * Implements entity-relationship graph in SQLite (no Neo4j needed)
 * Each entity and relationship is scoped by (user_id, agent_id)
 */

import { DatabaseSync } from "node:sqlite";

// ============================================================================
// Types
// ============================================================================

export interface Entity {
  id: string;
  name: string;
  type: "person" | "project" | "technology" | "concept" | string;
  properties: Record<string, unknown>;
  scope_user_id: string;
  scope_agent_id: string;
  created_at: string;
  updated_at: string;
}

export interface EntityRow {
  id: string;
  name: string;
  type: string;
  properties: string; // JSON-encoded
  scope_user_id: string;
  scope_agent_id: string;
  created_at: string;
  updated_at: string;
}

export interface Relationship {
  id: string;
  source_entity_id: string;
  target_entity_id: string;
  relation_type: string;
  weight: number;
  properties: Record<string, unknown>;
  scope_user_id: string;
  scope_agent_id: string;
  created_at: string;
}

export interface RelationshipRow {
  id: string;
  source_entity_id: string;
  target_entity_id: string;
  relation_type: string;
  weight: number;
  properties: string; // JSON-encoded
  scope_user_id: string;
  scope_agent_id: string;
  created_at: string;
}

export interface EntityCreateInput {
  name: string;
  type: string;
  properties?: Record<string, unknown>;
}

export interface RelationshipCreateInput {
  source_entity_id: string;
  target_entity_id: string;
  relation_type: string;
  weight?: number;
  properties?: Record<string, unknown>;
}

export interface EntityFilter {
  type?: string;
  name?: string;
}

export type RelationDirection = "outgoing" | "incoming" | "both";

// ============================================================================
// GraphDB Class
// ============================================================================

export class GraphDB {
  private db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.migrate();
  }

  private migrate(): void {
    // Create entities table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        properties TEXT NOT NULL DEFAULT '{}',
        scope_user_id TEXT NOT NULL DEFAULT '',
        scope_agent_id TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    // Create relationships table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS relationships (
        id TEXT PRIMARY KEY,
        source_entity_id TEXT NOT NULL,
        target_entity_id TEXT NOT NULL,
        relation_type TEXT NOT NULL,
        weight REAL NOT NULL DEFAULT 1.0,
        properties TEXT NOT NULL DEFAULT '{}',
        scope_user_id TEXT NOT NULL DEFAULT '',
        scope_agent_id TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        UNIQUE(source_entity_id, target_entity_id, relation_type)
      )
    `);

    // Create indexes for performance
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_scope ON entities(scope_user_id, scope_agent_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_relationships_scope ON relationships(scope_user_id, scope_agent_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_relationships_source ON relationships(source_entity_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_relationships_target ON relationships(target_entity_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_relationships_type ON relationships(relation_type)`);
  }

  // ==========================================================================
  // Entity CRUD
  // ==========================================================================

  createEntity(
    scopeUserId: string,
    scopeAgentId: string,
    input: EntityCreateInput,
  ): Entity {
    const now = new Date().toISOString();
    const id = this.generateUUID();
    const propertiesJson = JSON.stringify(input.properties || {});

    const insertStmt = this.db.prepare(
      `INSERT INTO entities (id, name, type, properties, scope_user_id, scope_agent_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    insertStmt.run(id, input.name, input.type, propertiesJson, scopeUserId, scopeAgentId, now, now);

    return {
      id,
      name: input.name,
      type: input.type,
      properties: input.properties || {},
      scope_user_id: scopeUserId,
      scope_agent_id: scopeAgentId,
      created_at: now,
      updated_at: now,
    };
  }

  getEntity(scopeUserId: string, scopeAgentId: string, id: string): Entity | null {
    const stmt = this.db.prepare(
      `SELECT * FROM entities WHERE id = ? AND scope_user_id = ? AND scope_agent_id = ?`
    );
    const row = stmt.get(id, scopeUserId, scopeAgentId) as EntityRow | undefined;

    if (!row) return null;
    return this.rowToEntity(row);
  }

  listEntities(
    scopeUserId: string,
    scopeAgentId: string,
    filter?: EntityFilter,
  ): Entity[] {
    let query = `SELECT * FROM entities WHERE scope_user_id = ? AND scope_agent_id = ?`;
    const params: unknown[] = [scopeUserId, scopeAgentId];

    if (filter?.type) {
      query += ` AND type = ?`;
      params.push(filter.type);
    }

    if (filter?.name) {
      query += ` AND name LIKE ?`;
      params.push(`%${filter.name}%`);
    }

    query += ` ORDER BY updated_at DESC`;

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as EntityRow[];
    return rows.map((r) => this.rowToEntity(r));
  }

  updateEntity(
    scopeUserId: string,
    scopeAgentId: string,
    id: string,
    updates: Partial<EntityCreateInput>,
  ): Entity | null {
    const existing = this.getEntity(scopeUserId, scopeAgentId, id);
    if (!existing) return null;

    const now = new Date().toISOString();
    const name = updates.name ?? existing.name;
    const type = updates.type ?? existing.type;
    const properties = updates.properties ?? existing.properties;
    const propertiesJson = JSON.stringify(properties);

    const updateStmt = this.db.prepare(
      `UPDATE entities SET name = ?, type = ?, properties = ?, updated_at = ?
       WHERE id = ? AND scope_user_id = ? AND scope_agent_id = ?`
    );
    updateStmt.run(name, type, propertiesJson, now, id, scopeUserId, scopeAgentId);

    return {
      ...existing,
      name,
      type,
      properties,
      updated_at: now,
    };
  }

  deleteEntity(scopeUserId: string, scopeAgentId: string, id: string): boolean {
    // First delete all relationships involving this entity
    const deleteRelsStmt = this.db.prepare(
      `DELETE FROM relationships 
       WHERE (source_entity_id = ? OR target_entity_id = ?) 
       AND scope_user_id = ? AND scope_agent_id = ?`
    );
    deleteRelsStmt.run(id, id, scopeUserId, scopeAgentId);

    // Then delete the entity
    const deleteStmt = this.db.prepare(
      `DELETE FROM entities WHERE id = ? AND scope_user_id = ? AND scope_agent_id = ?`
    );
    const result = deleteStmt.run(id, scopeUserId, scopeAgentId);
    return result.changes > 0;
  }

  // ==========================================================================
  // Relationship CRUD
  // ==========================================================================

  createRelationship(
    scopeUserId: string,
    scopeAgentId: string,
    input: RelationshipCreateInput,
  ): Relationship {
    const now = new Date().toISOString();
    const id = this.generateUUID();
    const weight = input.weight ?? 1.0;
    const propertiesJson = JSON.stringify(input.properties || {});

    const insertStmt = this.db.prepare(
      `INSERT INTO relationships (id, source_entity_id, target_entity_id, relation_type, weight, properties, scope_user_id, scope_agent_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_entity_id, target_entity_id, relation_type) DO UPDATE SET
       weight = excluded.weight, properties = excluded.properties, created_at = excluded.created_at`
    );
    insertStmt.run(
      id,
      input.source_entity_id,
      input.target_entity_id,
      input.relation_type,
      weight,
      propertiesJson,
      scopeUserId,
      scopeAgentId,
      now,
    );

    return {
      id,
      source_entity_id: input.source_entity_id,
      target_entity_id: input.target_entity_id,
      relation_type: input.relation_type,
      weight,
      properties: input.properties || {},
      scope_user_id: scopeUserId,
      scope_agent_id: scopeAgentId,
      created_at: now,
    };
  }

  getRelationship(scopeUserId: string, scopeAgentId: string, id: string): Relationship | null {
    const stmt = this.db.prepare(
      `SELECT * FROM relationships WHERE id = ? AND scope_user_id = ? AND scope_agent_id = ?`
    );
    const row = stmt.get(id, scopeUserId, scopeAgentId) as RelationshipRow | undefined;

    if (!row) return null;
    return this.rowToRelationship(row);
  }

  getRelationships(
    scopeUserId: string,
    scopeAgentId: string,
    entityId: string,
    direction: RelationDirection = "both",
  ): Relationship[] {
    let query: string;
    const params: unknown[] = [scopeUserId, scopeAgentId];

    if (direction === "outgoing") {
      query = `SELECT * FROM relationships WHERE scope_user_id = ? AND scope_agent_id = ? AND source_entity_id = ?`;
      params.push(entityId);
    } else if (direction === "incoming") {
      query = `SELECT * FROM relationships WHERE scope_user_id = ? AND scope_agent_id = ? AND target_entity_id = ?`;
      params.push(entityId);
    } else {
      query = `SELECT * FROM relationships WHERE scope_user_id = ? AND scope_agent_id = ? AND (source_entity_id = ? OR target_entity_id = ?)`;
      params.push(entityId, entityId);
    }

    query += ` ORDER BY weight DESC`;

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as RelationshipRow[];
    return rows.map((r) => this.rowToRelationship(r));
  }

  deleteRelationship(scopeUserId: string, scopeAgentId: string, id: string): boolean {
    const stmt = this.db.prepare(
      `DELETE FROM relationships WHERE id = ? AND scope_user_id = ? AND scope_agent_id = ?`
    );
    const result = stmt.run(id, scopeUserId, scopeAgentId);
    return result.changes > 0;
  }

  // ==========================================================================
  // Graph Traversal
  // ==========================================================================

  traverseGraph(
    scopeUserId: string,
    scopeAgentId: string,
    startEntityId: string,
    maxDepth: number = 2,
  ): { entities: Entity[]; relationships: Relationship[] } {
    const entities = new Map<string, Entity>();
    const relationships = new Map<string, Relationship>();
    const visited = new Set<string>();
    let currentLevel = [startEntityId];

    for (let depth = 0; depth < maxDepth && currentLevel.length > 0; depth++) {
      const nextLevel: string[] = [];

      for (const entityId of currentLevel) {
        if (visited.has(entityId)) continue;
        visited.add(entityId);

        const entity = this.getEntity(scopeUserId, scopeAgentId, entityId);
        if (entity) {
          entities.set(entityId, entity);

          const rels = this.getRelationships(scopeUserId, scopeAgentId, entityId, "both");
          for (const rel of rels) {
            relationships.set(rel.id, rel);
            const otherId = rel.source_entity_id === entityId ? rel.target_entity_id : rel.source_entity_id;
            if (!visited.has(otherId)) {
              nextLevel.push(otherId);
            }
          }
        }
      }

      currentLevel = nextLevel;
    }

    return {
      entities: Array.from(entities.values()),
      relationships: Array.from(relationships.values()),
    };
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  private rowToEntity(row: EntityRow): Entity {
    return {
      ...row,
      properties: JSON.parse(row.properties || "{}"),
    };
  }

  private rowToRelationship(row: RelationshipRow): Relationship {
    return {
      ...row,
      properties: JSON.parse(row.properties || "{}"),
    };
  }

  private generateUUID(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }
}
