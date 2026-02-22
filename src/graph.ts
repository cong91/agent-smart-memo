/**
 * Graph Memory Storage - SQLite-based
 * Week 3: Entity and Relationship storage
 */

import sqlite3 from "sqlite3";
import { open, Database } from "sqlite";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";

export interface Entity {
  id: string;
  name: string;
  type: string;
  user_id: string;
  agent_id?: string;
  session_id?: string;
  metadata?: string;
  created_at: number;
  updated_at: number;
}

export interface Relationship {
  id: string;
  source_id: string;
  target_id: string;
  relationship: string;
  user_id: string;
  agent_id?: string;
  session_id?: string;
  metadata?: string;
  created_at: number;
  updated_at: number;
}

export interface GraphMemory {
  entity: string;
  relationship: string;
  target?: string;
  metadata?: Record<string, any>;
}

export class GraphStorage {
  private db: Database<sqlite3.Database, sqlite3.Statement> | null = null;
  private logger: any;
  private dbPath: string;

  constructor(logger: any) {
    this.logger = logger;
    // Store in OpenClaw data directory
    const dataDir = path.join(os.homedir(), ".openclaw", "data");
    this.dbPath = path.join(dataDir, "memory-graph.db");
    
    // Ensure directory exists
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
  }

  async initialize(): Promise<void> {
    this.db = await open({
      filename: this.dbPath,
      driver: sqlite3.Database
    });
    await this.initializeTables();
  }

  private async initializeTables(): Promise<void> {
    if (!this.db) throw new Error("Database not initialized");

    // Entities table
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'unknown',
        user_id TEXT NOT NULL,
        agent_id TEXT,
        session_id TEXT,
        metadata TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    // Relationships table
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS relationships (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        target_id TEXT,
        relationship TEXT NOT NULL,
        user_id TEXT NOT NULL,
        agent_id TEXT,
        session_id TEXT,
        metadata TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (source_id) REFERENCES entities(id) ON DELETE CASCADE
      )
    `);

    // Indexes for performance
    await this.db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_user ON entities(user_id)`);
    await this.db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name)`);
    await this.db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type)`);
    await this.db.exec(`CREATE INDEX IF NOT EXISTS idx_relationships_user ON relationships(user_id)`);
    await this.db.exec(`CREATE INDEX IF NOT EXISTS idx_relationships_source ON relationships(source_id)`);
    await this.db.exec(`CREATE INDEX IF NOT EXISTS idx_relationships_target ON relationships(target_id)`);
    await this.db.exec(`CREATE INDEX IF NOT EXISTS idx_relationships_type ON relationships(relationship)`);
  }

  /**
   * Create or update an entity
   */
  async upsertEntity(entity: Omit<Entity, "id" | "created_at" | "updated_at"> & { id?: string }): Promise<Entity> {
    if (!this.db) throw new Error("Database not initialized");

    const now = Date.now();
    const id = entity.id || crypto.randomUUID();
    
    const existing = await this.db.get<{ id: string }>("SELECT id FROM entities WHERE id = ?", id);
    
    if (existing) {
      // Update
      await this.db.run(`
        UPDATE entities 
        SET name = ?, type = ?, agent_id = ?, session_id = ?, metadata = ?, updated_at = ?
        WHERE id = ? AND user_id = ?
      `,
        entity.name,
        entity.type,
        entity.agent_id || null,
        entity.session_id || null,
        entity.metadata ? JSON.stringify(entity.metadata) : null,
        now,
        id,
        entity.user_id
      );
    } else {
      // Insert
      await this.db.run(`
        INSERT INTO entities (id, name, type, user_id, agent_id, session_id, metadata, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        id,
        entity.name,
        entity.type,
        entity.user_id,
        entity.agent_id || null,
        entity.session_id || null,
        entity.metadata ? JSON.stringify(entity.metadata) : null,
        now,
        now
      );
    }

    return {
      id,
      name: entity.name,
      type: entity.type,
      user_id: entity.user_id,
      agent_id: entity.agent_id,
      session_id: entity.session_id,
      metadata: entity.metadata ? JSON.stringify(entity.metadata) : undefined,
      created_at: now,
      updated_at: now,
    };
  }

  /**
   * Get entity by ID
   */
  async getEntity(id: string, userId: string): Promise<Entity | null> {
    if (!this.db) throw new Error("Database not initialized");
    const row = await this.db.get<any>("SELECT * FROM entities WHERE id = ? AND user_id = ?", id, userId);
    if (!row) return null;
    return this.mapEntity(row);
  }

  /**
   * Get entity by name
   */
  async getEntityByName(name: string, userId: string): Promise<Entity | null> {
    if (!this.db) throw new Error("Database not initialized");
    const row = await this.db.get<any>("SELECT * FROM entities WHERE name = ? AND user_id = ?", name, userId);
    if (!row) return null;
    return this.mapEntity(row);
  }

  /**
   * Search entities
   */
  async searchEntities(params: {
    userId: string;
    query?: string;
    type?: string;
    agentId?: string;
    sessionId?: string;
    limit?: number;
  }): Promise<Entity[]> {
    if (!this.db) throw new Error("Database not initialized");
    const { userId, query, type, agentId, sessionId, limit = 10 } = params;
    
    let sql = "SELECT * FROM entities WHERE user_id = ?";
    const args: any[] = [userId];

    if (query) {
      sql += " AND (name LIKE ? OR type LIKE ?)";
      args.push(`%${query}%`, `%${query}%`);
    }

    if (type) {
      sql += " AND type = ?";
      args.push(type);
    }

    if (agentId) {
      sql += " AND (agent_id = ? OR agent_id IS NULL)";
      args.push(agentId);
    }

    if (sessionId) {
      sql += " AND (session_id = ? OR session_id IS NULL)";
      args.push(sessionId);
    }

    sql += " ORDER BY updated_at DESC LIMIT ?";
    args.push(limit);

    const rows = await this.db.all<any[]>(sql, ...args);
    return rows.map(r => this.mapEntity(r));
  }

  /**
   * Create a relationship
   */
  async createRelationship(rel: Omit<Relationship, "id" | "created_at" | "updated_at"> & { id?: string }): Promise<Relationship> {
    if (!this.db) throw new Error("Database not initialized");
    const now = Date.now();
    const id = rel.id || crypto.randomUUID();

    await this.db.run(`
      INSERT OR REPLACE INTO relationships 
      (id, source_id, target_id, relationship, user_id, agent_id, session_id, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      id,
      rel.source_id,
      rel.target_id || null,
      rel.relationship,
      rel.user_id,
      rel.agent_id || null,
      rel.session_id || null,
      rel.metadata ? JSON.stringify(rel.metadata) : null,
      now,
      now
    );

    return {
      id,
      source_id: rel.source_id,
      target_id: rel.target_id,
      relationship: rel.relationship,
      user_id: rel.user_id,
      agent_id: rel.agent_id,
      session_id: rel.session_id,
      metadata: rel.metadata ? JSON.stringify(rel.metadata) : undefined,
      created_at: now,
      updated_at: now,
    };
  }

  /**
   * Get relationships for an entity
   */
  async getRelationships(params: {
    entityId: string;
    userId: string;
    direction?: "outgoing" | "incoming" | "both";
    relationship?: string;
  }): Promise<Array<Relationship & { source_name?: string; target_name?: string }>> {
    if (!this.db) throw new Error("Database not initialized");
    const { entityId, userId, direction = "both", relationship } = params;
    
    const results: Array<Relationship & { source_name?: string; target_name?: string }> = [];

    if (direction === "outgoing" || direction === "both") {
      let sql = `
        SELECT r.*, e1.name as source_name, e2.name as target_name
        FROM relationships r
        JOIN entities e1 ON r.source_id = e1.id
        LEFT JOIN entities e2 ON r.target_id = e2.id
        WHERE r.source_id = ? AND r.user_id = ?
      `;
      const args: any[] = [entityId, userId];

      if (relationship) {
        sql += " AND r.relationship = ?";
        args.push(relationship);
      }

      const rows = await this.db.all<any[]>(sql, ...args);
      results.push(...rows.map(r => this.mapRelationship(r)));
    }

    if (direction === "incoming" || direction === "both") {
      let sql = `
        SELECT r.*, e1.name as source_name, e2.name as target_name
        FROM relationships r
        JOIN entities e1 ON r.source_id = e1.id
        LEFT JOIN entities e2 ON r.target_id = e2.id
        WHERE r.target_id = ? AND r.user_id = ?
      `;
      const args: any[] = [entityId, userId];

      if (relationship) {
        sql += " AND r.relationship = ?";
        args.push(relationship);
      }

      const rows = await this.db.all<any[]>(sql, ...args);
      results.push(...rows.map(r => this.mapRelationship(r)));
    }

    return results;
  }

  /**
   * Search by relationship pattern
   */
  async searchByPattern(params: {
    userId: string;
    entity?: string;
    relationship?: string;
    target?: string;
    limit?: number;
  }): Promise<Array<{ entity: string; relationship: string; target?: string; metadata?: any }>> {
    if (!this.db) throw new Error("Database not initialized");
    const { userId, entity, relationship, target, limit = 20 } = params;

    let sql = `
      SELECT e.name as entity, r.relationship, e2.name as target, r.metadata
      FROM relationships r
      JOIN entities e ON r.source_id = e.id
      LEFT JOIN entities e2 ON r.target_id = e2.id
      WHERE r.user_id = ?
    `;
    const args: any[] = [userId];

    if (entity) {
      sql += " AND e.name LIKE ?";
      args.push(`%${entity}%`);
    }

    if (relationship) {
      sql += " AND r.relationship = ?";
      args.push(relationship);
    }

    if (target) {
      sql += " AND (e2.name LIKE ? OR e2.name IS NULL)";
      args.push(`%${target}%`);
    }

    sql += " ORDER BY r.updated_at DESC LIMIT ?";
    args.push(limit);

    const rows = await this.db.all<any[]>(sql, ...args);
    return rows.map(r => ({
      entity: r.entity,
      relationship: r.relationship,
      target: r.target,
      metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
    }));
  }

  /**
   * Delete entity and its relationships
   */
  async deleteEntity(id: string, userId: string): Promise<boolean> {
    if (!this.db) throw new Error("Database not initialized");
    const result = await this.db.run("DELETE FROM entities WHERE id = ? AND user_id = ?", id, userId);
    return (result.changes || 0) > 0;
  }

  /**
   * Get graph statistics
   */
  async getStats(userId: string): Promise<{ entities: number; relationships: number }> {
    if (!this.db) throw new Error("Database not initialized");
    const entityCount = await this.db.get<{ count: number }>("SELECT COUNT(*) as count FROM entities WHERE user_id = ?", userId);
    const relCount = await this.db.get<{ count: number }>("SELECT COUNT(*) as count FROM relationships WHERE user_id = ?", userId);
    
    return {
      entities: entityCount?.count || 0,
      relationships: relCount?.count || 0,
    };
  }

  private mapEntity(row: any): Entity {
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      user_id: row.user_id,
      agent_id: row.agent_id || undefined,
      session_id: row.session_id || undefined,
      metadata: row.metadata,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private mapRelationship(row: any): Relationship & { source_name?: string; target_name?: string } {
    return {
      id: row.id,
      source_id: row.source_id,
      target_id: row.target_id || undefined,
      relationship: row.relationship,
      user_id: row.user_id,
      agent_id: row.agent_id || undefined,
      session_id: row.session_id || undefined,
      metadata: row.metadata,
      created_at: row.created_at,
      updated_at: row.updated_at,
      source_name: row.source_name,
      target_name: row.target_name,
    };
  }

  async close(): Promise<void> {
    if (this.db) {
      await this.db.close();
      this.db = null;
    }
  }
}

/**
 * Extract entities and relationships from text
 * Simple rule-based extraction (can be enhanced with NLP)
 */
export class EntityExtractor {
  /**
   * Extract entities from text
   */
  extractEntities(text: string): Array<{ name: string; type: string }> {
    const entities: Array<{ name: string; type: string }> = [];
    const lower = text.toLowerCase();

    // Person patterns
    const personPatterns = [
      /\b([A-Z][a-z]+) (?:is|was|works|lives|said|told|met|knows)/g,
      /\bmy (?:friend|colleague|boss|manager|teacher) ([A-Z][a-z]+)/gi,
      /\b([A-Z][a-z]+) (?:and|with) (?:me|I)\b/g,
    ];

    for (const pattern of personPatterns) {
      const matches = text.matchAll(pattern);
      for (const match of matches) {
        const name = match[1];
        if (name && name.length > 1 && !this.isCommonWord(name)) {
          entities.push({ name, type: "person" });
        }
      }
    }

    // Organization patterns
    const orgPatterns = [
      /\b(?:at|from|work[s]? at|works? for) ([A-Z][a-zA-Z]*(?:\s+[A-Z][a-zA-Z]+)?)\b/g,
      /\b([A-Z][a-zA-Z]*(?:\s+[A-Z][a-zA-Z]+)?) (?:company|inc|corp|ltd|llc)\b/gi,
    ];

    for (const pattern of orgPatterns) {
      const matches = text.matchAll(pattern);
      for (const match of matches) {
        const name = match[1];
        if (name && name.length > 1) {
          entities.push({ name, type: "organization" });
        }
      }
    }

    // Project/Product patterns
    if (lower.includes("project") || lower.includes("product")) {
      const projectMatch = text.match(/\bproject\s+["']?([A-Z][a-zA-Z0-9]*)["']?/gi);
      if (projectMatch) {
        for (const m of projectMatch) {
          const name = m.replace(/project\s+/i, "").replace(/["']/g, "");
          if (name) entities.push({ name, type: "project" });
        }
      }
    }

    // Location patterns
    const locationPatterns = [
      /\b(?:in|from|at|live[s]? in|located in)\s+([A-Z][a-zA-Z]*(?:\s+[A-Z][a-zA-Z]+)?)\b/g,
    ];

    for (const pattern of locationPatterns) {
      const matches = text.matchAll(pattern);
      for (const match of matches) {
        const name = match[1];
        if (name && name.length > 1 && !this.isCommonWord(name)) {
          entities.push({ name, type: "location" });
        }
      }
    }

    // Remove duplicates
    const seen = new Set<string>();
    return entities.filter(e => {
      const key = `${e.name}:${e.type}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /**
   * Extract relationships between entities
   */
  extractRelationships(text: string, entities: Array<{ name: string; type: string }>): Array<{
    source: string;
    relationship: string;
    target?: string;
  }> {
    const relationships: Array<{ source: string; relationship: string; target?: string }> = [];
    const lower = text.toLowerCase();

    for (const entity of entities) {
      // Work relationships
      if (lower.includes("work") && lower.includes(entity.name.toLowerCase())) {
        const workMatch = text.match(new RegExp(`${entity.name}.*work.*as\s+(?:a\s+)?([^,.]+)`, "i"));
        if (workMatch) {
          relationships.push({
            source: entity.name,
            relationship: "WORKS_AS",
            target: workMatch[1].trim(),
          });
        }
      }

      // Location relationships
      if (entity.type === "person" && lower.includes("live")) {
        const locMatch = text.match(new RegExp(`${entity.name}.*live[s]?\s+in\s+([A-Z][a-zA-Z]+)`, "i"));
        if (locMatch) {
          relationships.push({
            source: entity.name,
            relationship: "LIVES_IN",
            target: locMatch[1],
          });
        }
      }

      // Project relationships
      if (entity.type === "person") {
        const projectMatch = text.match(new RegExp(`${entity.name}.*(?:work[s]?\s+on|project)\s+([A-Z][a-zA-Z0-9]+)`, "i"));
        if (projectMatch) {
          relationships.push({
            source: entity.name,
            relationship: "WORKS_ON",
            target: projectMatch[1],
          });
        }
      }

      // Preference relationships
      const prefPatterns = [
        { pattern: new RegExp(`${entity.name}.*(?:like|love|enjoy)[s]?\s+([^,.]+)`, "i"), rel: "LIKES" },
        { pattern: new RegExp(`${entity.name}.*(?:dislike|hate)[s]?\s+([^,.]+)`, "i"), rel: "DISLIKES" },
        { pattern: new RegExp(`${entity.name}.*(?:prefer)[s]?\s+([^,.]+)`, "i"), rel: "PREFERS" },
      ];

      for (const { pattern, rel } of prefPatterns) {
        const match = text.match(pattern);
        if (match) {
          relationships.push({
            source: entity.name,
            relationship: rel,
            target: match[1].trim(),
          });
        }
      }

      // Knows relationship (met with)
      const knowsMatch = text.match(new RegExp(`(?:met|know[s]?)\s+${entity.name}`, "i"));
      if (knowsMatch) {
        relationships.push({
          source: "user", // Implicit user
          relationship: "KNOWS",
          target: entity.name,
        });
      }
    }

    return relationships;
  }

  private isCommonWord(word: string): boolean {
    const commonWords = new Set([
      "the", "and", "for", "are", "but", "not", "you", "all", "can", "her", "was", "one", "our",
      "this", "that", "with", "have", "from", "they", "she", "will", "would", "there", "their",
      "what", "said", "each", "which", "about", "could", "other", "after", "first", "never",
      "these", "think", "where", "being", "every", "great", "might", "shall", "still", "those",
      "while", "should", "only", "over", "such", "take", "than", "them", "well", "were",
    ]);
    return commonWords.has(word.toLowerCase());
  }
}
