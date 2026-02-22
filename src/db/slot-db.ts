/**
 * SlotDB — SQLite-backed structured slot storage
 *
 * Uses Node.js built-in node:sqlite (available since Node 22+).
 * Each slot is a key-value pair scoped by (user_id, agent_id).
 * Keys use dot-notation: "profile.name", "preferences.theme", etc.
 * Values are stored as JSON strings.
 */

import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { GraphDB } from "./graph-db.js";

// Re-export GraphDB types
export { GraphDB };
export type {
  Entity,
  EntityRow,
  Relationship,
  RelationshipRow,
  EntityCreateInput,
  RelationshipCreateInput,
  EntityFilter,
  RelationDirection,
} from "./graph-db.js";

// ============================================================================
// Types
// ============================================================================

export interface Slot {
  id: string;
  scope_user_id: string;
  scope_agent_id: string;
  category: string;
  key: string;
  value: unknown;
  source: "auto_capture" | "manual" | "tool";
  confidence: number;
  version: number;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
}

export interface SlotRow {
  id: string;
  scope_user_id: string;
  scope_agent_id: string;
  category: string;
  key: string;
  value: string; // JSON-encoded
  source: string;
  confidence: number;
  version: number;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
}

export interface SlotSetInput {
  key: string;
  value: unknown;
  category?: string;
  source?: "auto_capture" | "manual" | "tool";
  confidence?: number;
  expires_at?: string | null;
}

export interface SlotGetInput {
  key?: string;
  category?: string;
}

export interface SlotListInput {
  category?: string;
  prefix?: string;
}

// ============================================================================
// SlotDB Class
// ============================================================================

export class SlotDB {
  private db: DatabaseSync;
  private stateDir: string;
  public graph: GraphDB;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
    const dbDir = join(stateDir, "agent-memo");
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }
    const dbPath = join(dbDir, "slots.db");
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
    this.graph = new GraphDB(this.db);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS slots (
        id TEXT PRIMARY KEY,
        scope_user_id TEXT NOT NULL DEFAULT '',
        scope_agent_id TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL DEFAULT 'custom',
        key TEXT NOT NULL,
        value TEXT NOT NULL DEFAULT '""',
        source TEXT NOT NULL DEFAULT 'tool',
        confidence REAL NOT NULL DEFAULT 1.0,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT,
        UNIQUE(scope_user_id, scope_agent_id, category, key)
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_slots_scope
        ON slots(scope_user_id, scope_agent_id)
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_slots_category
        ON slots(category)
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_slots_key
        ON slots(key)
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_slots_updated
        ON slots(updated_at DESC)
    `);
  }

  // --------------------------------------------------------------------------
  // CRUD
  // --------------------------------------------------------------------------

  /**
   * Set (upsert) a slot. Creates or updates, incrementing version.
   */
  set(
    scopeUserId: string,
    scopeAgentId: string,
    input: SlotSetInput,
  ): Slot {
    const now = new Date().toISOString();
    const category = input.category || this.inferCategory(input.key);
    const valueJson = JSON.stringify(input.value);
    const source = input.source || "tool";
    const confidence = input.confidence ?? 1.0;

    // Try to get existing
    const selectStmt = this.db.prepare(
      `SELECT * FROM slots
       WHERE scope_user_id = ? AND scope_agent_id = ? AND key = ?`,
    );
    const existing = selectStmt.get(scopeUserId, scopeAgentId, input.key) as SlotRow | undefined;

    if (existing) {
      // Update existing slot
      const newVersion = existing.version + 1;
      const updateStmt = this.db.prepare(
        `UPDATE slots
         SET value = ?, category = ?, source = ?, confidence = ?,
             version = ?, updated_at = ?, expires_at = ?
         WHERE id = ?`,
      );
      updateStmt.run(
        valueJson,
        category,
        source,
        confidence,
        newVersion,
        now,
        input.expires_at || null,
        existing.id,
      );

      return {
        ...existing,
        category,
        value: input.value,
        source: source as Slot["source"],
        confidence,
        version: newVersion,
        updated_at: now,
        expires_at: input.expires_at || null,
      };
    }

    // Insert new slot
    const id = `${category}:${input.key}:${Date.now()}`;
    const insertStmt = this.db.prepare(
      `INSERT INTO slots (id, scope_user_id, scope_agent_id, category, key, value, source, confidence, version, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    );
    insertStmt.run(
      id,
      scopeUserId,
      scopeAgentId,
      category,
      input.key,
      valueJson,
      source,
      confidence,
      now,
      now,
      input.expires_at || null,
    );

    return {
      id,
      scope_user_id: scopeUserId,
      scope_agent_id: scopeAgentId,
      category,
      key: input.key,
      value: input.value,
      source: source as Slot["source"],
      confidence,
      version: 1,
      created_at: now,
      updated_at: now,
      expires_at: input.expires_at || null,
    };
  }

  /**
   * Get a single slot by key, or all slots in a category.
   */
  get(
    scopeUserId: string,
    scopeAgentId: string,
    input: SlotGetInput,
  ): Slot | Slot[] | null {
    this.cleanExpired(scopeUserId, scopeAgentId);

    if (input.key) {
      const stmt = this.db.prepare(
        `SELECT * FROM slots
         WHERE scope_user_id = ? AND scope_agent_id = ? AND key = ?`,
      );
      const row = stmt.get(scopeUserId, scopeAgentId, input.key) as SlotRow | undefined;

      if (!row) return null;
      return this.rowToSlot(row);
    }

    if (input.category) {
      const stmt = this.db.prepare(
        `SELECT * FROM slots
         WHERE scope_user_id = ? AND scope_agent_id = ? AND category = ?
         ORDER BY key ASC`,
      );
      const rows = stmt.all(scopeUserId, scopeAgentId, input.category) as unknown as SlotRow[];

      return rows.map((r) => this.rowToSlot(r));
    }

    // Return all slots
    const stmt = this.db.prepare(
      `SELECT * FROM slots
       WHERE scope_user_id = ? AND scope_agent_id = ?
       ORDER BY category ASC, key ASC`,
    );
    const rows = stmt.all(scopeUserId, scopeAgentId) as unknown as SlotRow[];

    return rows.map((r) => this.rowToSlot(r));
  }

  /**
   * List slots with optional filtering.
   */
  list(
    scopeUserId: string,
    scopeAgentId: string,
    input?: SlotListInput,
  ): Slot[] {
    this.cleanExpired(scopeUserId, scopeAgentId);

    let query = `SELECT * FROM slots WHERE scope_user_id = ? AND scope_agent_id = ?`;
    const params: (string | number | null)[] = [scopeUserId, scopeAgentId];

    if (input?.category) {
      query += ` AND category = ?`;
      params.push(input.category);
    }

    if (input?.prefix) {
      query += ` AND key LIKE ?`;
      params.push(`${input.prefix}%`);
    }

    query += ` ORDER BY category ASC, key ASC`;

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as unknown as SlotRow[];
    return rows.map((r) => this.rowToSlot(r));
  }

  /**
   * Delete a slot by key.
   */
  delete(
    scopeUserId: string,
    scopeAgentId: string,
    key: string,
  ): boolean {
    const stmt = this.db.prepare(
      `DELETE FROM slots
       WHERE scope_user_id = ? AND scope_agent_id = ? AND key = ?`,
    );
    const result = stmt.run(scopeUserId, scopeAgentId, key);
    return result.changes > 0;
  }

  /**
   * Get the current state as a structured object for injection.
   */
  getCurrentState(
    scopeUserId: string,
    scopeAgentId: string,
  ): Record<string, Record<string, unknown>> {
    this.cleanExpired(scopeUserId, scopeAgentId);

    const stmt = this.db.prepare(
      `SELECT * FROM slots
       WHERE scope_user_id = ? AND scope_agent_id = ?
       ORDER BY category ASC, key ASC`,
    );
    const rows = stmt.all(scopeUserId, scopeAgentId) as unknown as SlotRow[];

    const state: Record<string, Record<string, unknown>> = {};

    for (const row of rows) {
      if (!state[row.category]) {
        state[row.category] = {};
      }
      try {
        state[row.category][row.key] = JSON.parse(row.value);
      } catch {
        state[row.category][row.key] = row.value;
      }
    }

    return state;
  }

  /**
   * Get count of slots for a scope.
   */
  count(scopeUserId: string, scopeAgentId: string): number {
    const stmt = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM slots
       WHERE scope_user_id = ? AND scope_agent_id = ?`,
    );
    const result = stmt.get(scopeUserId, scopeAgentId) as { cnt: number };
    return result.cnt;
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private rowToSlot(row: SlotRow): Slot {
    let parsedValue: unknown;
    try {
      parsedValue = JSON.parse(row.value);
    } catch {
      parsedValue = row.value;
    }
    return {
      ...row,
      value: parsedValue,
      source: row.source as Slot["source"],
    };
  }

  private inferCategory(key: string): string {
    const prefix = key.split(".")[0];
    const knownCategories = [
      "profile",
      "preferences",
      "project",
      "environment",
    ];
    if (knownCategories.includes(prefix)) {
      return prefix;
    }
    return "custom";
  }

  private cleanExpired(scopeUserId: string, scopeAgentId: string): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      `DELETE FROM slots
       WHERE scope_user_id = ? AND scope_agent_id = ?
         AND expires_at IS NOT NULL AND expires_at < ?`,
    );
    stmt.run(scopeUserId, scopeAgentId, now);
  }

  close(): void {
    this.db.close();
  }
}
