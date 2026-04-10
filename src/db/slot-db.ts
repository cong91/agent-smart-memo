/**
 * SlotDB — SQLite-backed structured slot storage
 *
 * Uses Node.js built-in node:sqlite (available since Node 22+).
 * Each slot is a key-value pair scoped by (user_id, agent_id).
 * Keys use dot-notation: "profile.name", "preferences.theme", etc.
 * Values are stored as JSON strings.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { populateUniversalCodeGraphForFile } from "../core/graph/code-graph-populator.js";
import { buildSymbolId } from "../core/ingest/ids.js";
import { buildChunkArtifacts } from "../core/ingest/ingest-pipeline.js";
import { extractSemanticBlocks } from "../core/ingest/semantic-block-extractor.js";
import { getSlotTTL } from "../shared/memory-config.js";
import {
	resolveLegacyStateDirInput,
	resolveSlotDbDir,
} from "../shared/slotdb-path.js";
import { GraphDB } from "./graph-db.js";

export type {
	Entity,
	EntityCreateInput,
	EntityFilter,
	EntityRow,
	RelationDirection,
	Relationship,
	RelationshipCreateInput,
	RelationshipRow,
} from "./graph-db.js";
// Re-export GraphDB types
export { GraphDB };

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

export interface ProjectRegisterInput {
	project_id?: string;
	project_name?: string;
	project_alias: string;
	repo_root?: string;
	repo_remote?: string;
	active_version?: string;
	allow_alias_update?: boolean;
	reuse_existing_repo_root?: boolean;
}

export interface ProjectRecord {
	project_id: string;
	scope_user_id: string;
	scope_agent_id: string;
	project_name: string;
	repo_root: string | null;
	repo_remote_primary: string | null;
	active_version: string | null;
	lifecycle_status:
		| "active"
		| "archived"
		| "disabled"
		| "detached"
		| "deindexed"
		| "purged";
	created_at: string;
	updated_at: string;
}

export interface ProjectDeindexResult {
	project_id: string;
	lifecycle_status: "deindexed";
	deindexed_at: string;
	reason: string | null;
	affected: {
		files: number;
		chunks: number;
		symbols: number;
	};
	searchable: false;
}

export interface ProjectDetachResult {
	project_id: string;
	lifecycle_status: "detached";
	detached_at: string;
	reason: string | null;
	detached_fields: {
		repo_root: boolean;
		repo_remote_primary: boolean;
		active_version: boolean;
		aliases_removed: number;
		tracker_mappings_removed: number;
	};
	searchable: false;
	next_actions: {
		reattach_via_register_or_update: true;
		reversible_by_re_register: true;
	};
}

export interface ProjectUnregisterResult {
	project_id: string;
	lifecycle_status: "disabled";
	unregistered_at: string;
	mode: "safe";
	reason: string | null;
	detached_fields: {
		aliases_removed: number;
		tracker_mappings_removed: number;
	};
	registration_state: {
		registration_status: "draft";
		validation_status: "warn";
	};
	searchable: false;
	audit: {
		deindexed_first: boolean;
		confirm_required: true;
	};
}

export interface ProjectPurgePreviewResult {
	project_id: string;
	current_lifecycle_status: ProjectRecord["lifecycle_status"];
	purge_guard: {
		destructive: true;
		allowed: boolean;
		reason: string;
		requires_lifecycle_status: "disabled";
		requires_confirm: true;
	};
	affected: {
		project_row: 1;
		aliases: number;
		tracker_mappings: number;
		registration_state: number;
		index_runs: number;
		watch_state: number;
		file_index_state: number;
		chunk_registry: number;
		symbol_registry: number;
		task_registry: number;
	};
	previewed_at: string;
}

export interface ProjectPurgeResult {
	project_id: string;
	lifecycle_status: "purged";
	purged_at: string;
	reason: string | null;
	deleted: {
		project_row: 1;
		aliases: number;
		tracker_mappings: number;
		registration_state: number;
		index_runs: number;
		watch_state: number;
		file_index_state: number;
		chunk_registry: number;
		symbol_registry: number;
		task_registry: number;
	};
	searchable: false;
	recoverable: false;
	audit: {
		confirm_required: true;
		allowed_from_lifecycle_status: "disabled";
	};
}

export interface ProjectAliasRecord {
	id: string;
	project_id: string;
	scope_user_id: string;
	scope_agent_id: string;
	project_alias: string;
	is_primary: number;
	created_at: string;
	updated_at: string;
}

export interface ProjectTrackerMappingInput {
	project_id: string;
	tracker_type: "jira" | "github" | "other";
	tracker_space_key?: string;
	tracker_project_id?: string;
	default_epic_key?: string;
	board_key?: string;
	active_version?: string;
	external_project_url?: string;
}

export interface ProjectTrackerMappingRecord {
	id: string;
	project_id: string;
	scope_user_id: string;
	scope_agent_id: string;
	tracker_type: "jira" | "github" | "other";
	tracker_space_key: string | null;
	tracker_project_id: string | null;
	default_epic_key: string | null;
	board_key: string | null;
	active_version: string | null;
	external_project_url: string | null;
	created_at: string;
	updated_at: string;
}

export interface ProjectRegistrationStateRecord {
	project_id: string;
	scope_user_id: string;
	scope_agent_id: string;
	registration_status: "draft" | "registered" | "validated" | "blocked";
	validation_status: "pending" | "ok" | "warn" | "error";
	validation_notes: string | null;
	completeness_score: number;
	missing_required_fields: string[];
	last_validated_at: string | null;
	updated_at: string;
}

export interface ProjectReindexDiffInput {
	project_id: string;
	source_rev?: string | null;
	trigger_type?: "bootstrap" | "incremental" | "manual" | "repair";
	index_profile?: string;
	full_snapshot?: boolean;
	paths?: Array<{
		relative_path: string;
		checksum?: string | null;
		module?: string | null;
		language?: string | null;
		content?: string | null;
	}>;
}

interface ProjectSymbolUpsertInput {
	symbol_id: string;
	project_id: string;
	relative_path: string;
	module: string | null;
	language: string;
	symbol_name: string;
	symbol_fqn: string;
	symbol_kind: string;
	signature_hash?: string | null;
	index_state: string;
	active: number;
	tombstone_at: string | null;
	indexed_at: string | null;
}

interface ProjectChunkUpsertInput {
	chunk_id: string;
	project_id: string;
	file_id: string | null;
	relative_path: string | null;
	chunk_kind: string;
	symbol_id: string | null;
	task_id?: string | null;
	checksum: string;
	qdrant_point_id?: string | null;
	index_state: string;
	active: number;
	tombstone_at: string | null;
	indexed_at: string | null;
}

export interface ProjectIndexWatchState {
	project_id: string;
	scope_user_id: string;
	scope_agent_id: string;
	last_source_rev: string | null;
	last_checksum_snapshot: Record<string, string>;
	updated_at: string;
}

export interface ProjectReindexDiffResult {
	run_id: string;
	project_id: string;
	trigger_type: "bootstrap" | "incremental" | "manual" | "repair";
	index_profile: string;
	source_rev: string | null;
	changed: string[];
	unchanged: string[];
	deleted: string[];
	run_state: "indexed" | "error";
	watch_state: {
		last_source_rev: string | null;
		updated_at: string;
	};
}

export interface ProjectTaskRegistryUpsertInput {
	task_id: string;
	project_id: string;
	task_title: string;
	task_type?: string | null;
	task_status?: string | null;
	parent_task_id?: string | null;
	related_task_ids?: string[];
	files_touched?: string[];
	symbols_touched?: string[];
	commit_refs?: string[];
	diff_refs?: string[];
	decision_notes?: string | null;
	tracker_issue_key?: string | null;
}

export interface TaskRegistryRecord {
	task_id: string;
	scope_user_id: string;
	scope_agent_id: string;
	project_id: string;
	task_title: string;
	task_type: string | null;
	task_status: string | null;
	parent_task_id: string | null;
	related_task_ids: string[];
	files_touched: string[];
	symbols_touched: string[];
	commit_refs: string[];
	diff_refs: string[];
	decision_notes: string | null;
	tracker_issue_key: string | null;
	updated_at: string;
}

export interface ProjectTaskLineageContextInput {
	project_id: string;
	task_id?: string;
	tracker_issue_key?: string;
	task_title?: string;
	include_related?: boolean;
	include_parent_chain?: boolean;
}

export interface ProjectTaskLineageContextResult {
	focus: {
		project_id: string;
		task_id: string;
		tracker_issue_key: string | null;
		task_title: string;
	};
	parent_chain: TaskRegistryRecord[];
	related_tasks: TaskRegistryRecord[];
	touched_files: string[];
	touched_symbols: string[];
	commit_refs: string[];
	decision_notes: string[];
}

export interface ProjectHybridSearchInput {
	project_id: string;
	query: string;
	limit?: number;
	debug?: boolean;
	path_prefix?: string[];
	module?: string[];
	language?: string[];
	task_id?: string[];
	tracker_issue_key?: string[];
	task_context?: {
		task_id?: string;
		tracker_issue_key?: string;
		task_title?: string;
		include_related?: boolean;
		include_parent_chain?: boolean;
	};
}

export interface ProjectHybridSearchResultItem {
	source:
		| "file_index_state"
		| "symbol_registry"
		| "chunk_registry"
		| "task_registry";
	id: string;
	score: number;
	project_id: string;
	relative_path?: string;
	module?: string | null;
	language?: string | null;
	symbol_name?: string;
	symbol_kind?: string;
	task_id?: string;
	task_title?: string;
	tracker_issue_key?: string | null;
	snippet: string;
}

export interface ProjectHybridSearchTaskContextResolution {
	status: "not_requested" | "resolved" | "selector_not_resolved";
	reason?: string;
	selector: {
		task_id?: string;
		tracker_issue_key?: string;
		task_title?: string;
	};
	recoverable: boolean;
}

export interface ProjectHybridSearchResult {
	query: string;
	project_id: string;
	project_lifecycle_status?: ProjectRecord["lifecycle_status"];
	searchable?: boolean;
	tombstone_summary?: {
		files: number;
		chunks: number;
		symbols: number;
	};
	count: number;
	task_lineage_context: ProjectTaskLineageContextResult | null;
	task_context_resolution: ProjectHybridSearchTaskContextResolution;
	results: ProjectHybridSearchResultItem[];
	debug?: {
		query_intent: {
			looks_code_intent: boolean;
			looks_identifier_query: boolean;
			query_tokens: string[];
		};
		candidate_counts: {
			file_index_state: number;
			symbol_registry: number;
			chunk_registry: number;
			task_registry: number;
		};
		top_candidates: {
			file_index_state: Array<Record<string, unknown>>;
			symbol_registry: Array<Record<string, unknown>>;
			chunk_registry: Array<Record<string, unknown>>;
			task_registry: Array<Record<string, unknown>>;
		};
	};
}

export interface ProjectLegacyBackfillInput {
	mode?: "dry_run" | "apply";
	only_project_ids?: string[];
	only_aliases?: string[];
	force_registration_state?: boolean;
	source?: "repo_root" | "repo_remote" | "task_registry" | "mixed";
}

export interface ProjectLegacyBackfillItem {
	project_id: string;
	project_name: string;
	inferred_aliases: string[];
	inferred_tracker_mappings: Array<{
		tracker_type: "jira" | "github" | "other";
		tracker_space_key: string | null;
		tracker_project_id: string | null;
		default_epic_key: string | null;
		confidence: number;
		source: "repo_remote" | "task_registry";
	}>;
	actions: string[];
	warnings: string[];
}

export interface ProjectLegacyBackfillResult {
	mode: "dry_run" | "apply";
	source: "repo_root" | "repo_remote" | "task_registry" | "mixed";
	scanned_projects: number;
	candidates: number;
	updated_aliases: number;
	updated_tracker_mappings: number;
	updated_registration_states: number;
	migration_state_upserts: number;
	items: ProjectLegacyBackfillItem[];
}

export interface ProjectChangeOverlayQueryInput {
	project_id: string;
	task_id?: string;
	tracker_issue_key?: string;
	task_title?: string;
	feature_key?:
		| "project_onboarding_registration_indexing"
		| "code_aware_retrieval"
		| "heartbeat_health_runtime_integrity"
		| "change_aware_impact"
		| "post_entry_review_decision_support";
	feature_name?: string;
	include_related?: boolean;
	include_parent_chain?: boolean;
}

export interface ProjectChangeOverlaySymbol {
	symbol_name: string;
	symbol_kind?: string;
	symbol_fqn?: string;
	relative_path?: string;
	source: "task_registry" | "symbol_registry";
}

export interface ProjectChangeOverlayResult {
	status: "ok" | "selector_not_resolved";
	reason?: string;
	selector: {
		task_id?: string;
		tracker_issue_key?: string;
		task_title?: string;
	};
	recoverable: boolean;
	project_id: string;
	focus: {
		task_id: string;
		task_title: string;
		tracker_issue_key: string | null;
	};
	changed_files: string[];
	related_symbols: ProjectChangeOverlaySymbol[];
	commit_refs: string[];
}

export interface ProjectFeaturePackProjectOnboardingIndexingSnapshot {
	project: ProjectRecord;
	aliases: ProjectAliasRecord[];
	registration: ProjectRegistrationStateRecord | null;
	tracker_mappings: ProjectTrackerMappingRecord[];
	active_file_paths: string[];
	recent_files: Array<{
		relative_path: string;
		module: string | null;
		language: string | null;
	}>;
	recent_symbols: Array<{
		symbol_name: string;
		symbol_kind: string;
		symbol_fqn: string;
		relative_path: string;
	}>;
	recent_tasks: Array<{
		task_id: string;
		task_title: string;
		tracker_issue_key: string | null;
		task_status: string | null;
	}>;
	recent_index_runs: Array<{
		run_id: string;
		trigger_type: string;
		state: string;
		started_at: string;
		finished_at: string | null;
	}>;
}

// ============================================================================
// SlotDB Class
// ============================================================================

export class SlotDB {
	private db: DatabaseSync;
	private stateDir: string;
	private slotDbDir: string;
	public graph: GraphDB;

	constructor(stateDirOrSlotDbDir: string, options?: { slotDbDir?: string }) {
		this.stateDir = stateDirOrSlotDbDir;

		// Priority resolver for new config/env flow.
		// If explicit slotDbDir option is provided, it is treated as already-resolved target dir.
		if (options?.slotDbDir) {
			this.slotDbDir = resolveSlotDbDir({
				slotDbDir: options.slotDbDir,
				stateDir: stateDirOrSlotDbDir,
			});
		} else {
			// Backward compatibility for legacy constructor callsites that pass OPENCLAW_STATE_DIR.
			this.slotDbDir = resolveLegacyStateDirInput(stateDirOrSlotDbDir);
		}

		if (!existsSync(this.slotDbDir)) {
			mkdirSync(this.slotDbDir, { recursive: true });
		}

		const dbPath = join(this.slotDbDir, "slots.db");
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

		this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        project_id TEXT NOT NULL,
        scope_user_id TEXT NOT NULL DEFAULT '',
        scope_agent_id TEXT NOT NULL DEFAULT '',
        project_name TEXT NOT NULL,
        repo_root TEXT,
        repo_remote_primary TEXT,
        active_version TEXT,
        lifecycle_status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (scope_user_id, scope_agent_id, project_id)
      )
    `);

		this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_scope_repo_root
      ON projects(scope_user_id, scope_agent_id, repo_root)
      WHERE repo_root IS NOT NULL AND repo_root != ''
    `);

		this.db.exec(`
      CREATE TABLE IF NOT EXISTS project_aliases (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        scope_user_id TEXT NOT NULL DEFAULT '',
        scope_agent_id TEXT NOT NULL DEFAULT '',
        project_alias TEXT NOT NULL,
        is_primary INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(scope_user_id, scope_agent_id, project_alias)
      )
    `);

		this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_project_aliases_project
      ON project_aliases(scope_user_id, scope_agent_id, project_id)
    `);

		this.db.exec(`
      CREATE TABLE IF NOT EXISTS project_tracker_mappings (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        scope_user_id TEXT NOT NULL DEFAULT '',
        scope_agent_id TEXT NOT NULL DEFAULT '',
        tracker_type TEXT NOT NULL,
        tracker_space_key TEXT,
        tracker_project_id TEXT,
        default_epic_key TEXT,
        board_key TEXT,
        active_version TEXT,
        external_project_url TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(scope_user_id, scope_agent_id, project_id, tracker_type)
      )
    `);

		this.db.exec(`
      CREATE TABLE IF NOT EXISTS project_registration_state (
        project_id TEXT NOT NULL,
        scope_user_id TEXT NOT NULL DEFAULT '',
        scope_agent_id TEXT NOT NULL DEFAULT '',
        registration_status TEXT NOT NULL,
        validation_status TEXT NOT NULL,
        validation_notes TEXT,
        completeness_score INTEGER NOT NULL DEFAULT 0,
        missing_required_fields TEXT,
        last_validated_at TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (scope_user_id, scope_agent_id, project_id)
      )
    `);

		// ASM-76 (v5.1) bootstrap: metadata/control plane schema for ingest & reindex lifecycle.
		this.db.exec(`
      CREATE TABLE IF NOT EXISTS index_runs (
        run_id TEXT NOT NULL,
        scope_user_id TEXT NOT NULL DEFAULT '',
        scope_agent_id TEXT NOT NULL DEFAULT '',
        project_id TEXT NOT NULL,
        index_profile TEXT NOT NULL,
        trigger_type TEXT NOT NULL,
        state TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        error_message TEXT,
        PRIMARY KEY (scope_user_id, scope_agent_id, run_id)
      )
    `);

		this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_index_runs_project_state
      ON index_runs(scope_user_id, scope_agent_id, project_id, state, started_at)
    `);

		this.db.exec(`
      CREATE TABLE IF NOT EXISTS file_index_state (
        file_id TEXT NOT NULL,
        scope_user_id TEXT NOT NULL DEFAULT '',
        scope_agent_id TEXT NOT NULL DEFAULT '',
        project_id TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        module TEXT,
        language TEXT,
        checksum TEXT NOT NULL,
        last_commit_sha TEXT,
        index_state TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        tombstone_at TEXT,
        indexed_at TEXT,
        PRIMARY KEY (scope_user_id, scope_agent_id, file_id),
        UNIQUE(scope_user_id, scope_agent_id, project_id, relative_path)
      )
    `);

		this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_file_state_project_path
      ON file_index_state(scope_user_id, scope_agent_id, project_id, relative_path)
    `);

		this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunk_registry (
        chunk_id TEXT NOT NULL,
        scope_user_id TEXT NOT NULL DEFAULT '',
        scope_agent_id TEXT NOT NULL DEFAULT '',
        project_id TEXT NOT NULL,
        file_id TEXT,
        relative_path TEXT,
        chunk_kind TEXT NOT NULL,
        symbol_id TEXT,
        task_id TEXT,
        checksum TEXT NOT NULL,
        qdrant_point_id TEXT,
        index_state TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        tombstone_at TEXT,
        indexed_at TEXT,
        PRIMARY KEY (scope_user_id, scope_agent_id, chunk_id)
      )
    `);

		this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_chunk_project_state
      ON chunk_registry(scope_user_id, scope_agent_id, project_id, index_state, active)
    `);

		this.db.exec(`
      CREATE TABLE IF NOT EXISTS symbol_registry (
        symbol_id TEXT NOT NULL,
        scope_user_id TEXT NOT NULL DEFAULT '',
        scope_agent_id TEXT NOT NULL DEFAULT '',
        project_id TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        module TEXT,
        language TEXT NOT NULL,
        symbol_name TEXT NOT NULL,
        symbol_fqn TEXT NOT NULL,
        symbol_kind TEXT NOT NULL,
        signature_hash TEXT,
        index_state TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        tombstone_at TEXT,
        indexed_at TEXT,
        PRIMARY KEY (scope_user_id, scope_agent_id, symbol_id)
      )
    `);

		this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_symbol_project_module_name
      ON symbol_registry(scope_user_id, scope_agent_id, project_id, module, symbol_name)
    `);

		this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_registry (
        task_id TEXT NOT NULL,
        scope_user_id TEXT NOT NULL DEFAULT '',
        scope_agent_id TEXT NOT NULL DEFAULT '',
        project_id TEXT NOT NULL,
        task_title TEXT NOT NULL,
        task_type TEXT,
        task_status TEXT,
        parent_task_id TEXT,
        related_task_ids TEXT,
        files_touched TEXT,
        symbols_touched TEXT,
        commit_refs TEXT,
        diff_refs TEXT,
        decision_notes TEXT,
        tracker_issue_key TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (scope_user_id, scope_agent_id, task_id)
      )
    `);

		this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_task_project_parent
      ON task_registry(scope_user_id, scope_agent_id, project_id, parent_task_id)
    `);

		this.db.exec(`
      CREATE TABLE IF NOT EXISTS migration_state (
        migration_id TEXT NOT NULL,
        scope_user_id TEXT NOT NULL DEFAULT '',
        scope_agent_id TEXT NOT NULL DEFAULT '',
        schema_from TEXT NOT NULL,
        schema_to TEXT NOT NULL,
        applied_at TEXT NOT NULL,
        status TEXT NOT NULL,
        notes TEXT,
        PRIMARY KEY (scope_user_id, scope_agent_id, migration_id)
      )
    `);

		// ASM-78 (v5.1) incremental reindex watch-state + diff/checksum control plane.
		this.db.exec(`
      CREATE TABLE IF NOT EXISTS project_index_watch_state (
        project_id TEXT NOT NULL,
        scope_user_id TEXT NOT NULL DEFAULT '',
        scope_agent_id TEXT NOT NULL DEFAULT '',
        last_source_rev TEXT,
        last_checksum_snapshot TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL,
        PRIMARY KEY (scope_user_id, scope_agent_id, project_id)
      )
    `);

		this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_project_watch_updated
      ON project_index_watch_state(scope_user_id, scope_agent_id, updated_at)
    `);
	}

	// --------------------------------------------------------------------------
	// CRUD
	// --------------------------------------------------------------------------

	/**
	 * Set (upsert) a slot. Creates or updates, incrementing version.
	 */
	set(scopeUserId: string, scopeAgentId: string, input: SlotSetInput): Slot {
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
		const existing = selectStmt.get(scopeUserId, scopeAgentId, input.key) as
			| SlotRow
			| undefined;

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
				input.expires_at !== undefined ? input.expires_at : existing.expires_at,
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
				expires_at:
					input.expires_at !== undefined
						? input.expires_at
						: existing.expires_at,
			};
		}

		// Insert new slot
		const id = randomUUID();
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
			const row = stmt.get(scopeUserId, scopeAgentId, input.key) as
				| SlotRow
				| undefined;

			if (!row) return null;
			return this.rowToSlot(row);
		}

		if (input.category) {
			const stmt = this.db.prepare(
				`SELECT * FROM slots
         WHERE scope_user_id = ? AND scope_agent_id = ? AND category = ?
         ORDER BY key ASC`,
			);
			const rows = stmt.all(
				scopeUserId,
				scopeAgentId,
				input.category,
			) as unknown as SlotRow[];

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
	delete(scopeUserId: string, scopeAgentId: string, key: string): boolean {
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

	registerProject(
		scopeUserId: string,
		scopeAgentId: string,
		input: ProjectRegisterInput,
	): {
		project: ProjectRecord;
		alias: ProjectAliasRecord;
		registration: ProjectRegistrationStateRecord;
	} {
		const projectAlias = this.normalizeProjectAlias(input.project_alias);
		if (!projectAlias) {
			throw new Error("project_alias is required");
		}

		const now = new Date().toISOString();
		const projectId = this.normalizeProjectId(input.project_id) || randomUUID();
		const projectName =
			this.normalizeProjectName(input.project_name) || projectAlias;
		const normalizedRepoRoot = this.normalizeRepoRoot(input.repo_root);
		const normalizedRepoRemote = this.normalizeRepoRemote(input.repo_remote);

		const existingAlias = this.getProjectByAlias(
			scopeUserId,
			scopeAgentId,
			projectAlias,
		);
		if (
			existingAlias &&
			existingAlias.project.project_id !== projectId &&
			!input.allow_alias_update
		) {
			throw new Error(
				`project_alias "${projectAlias}" is already mapped to another project_id`,
			);
		}

		let targetProjectId = projectId;
		const existingByRepoRoot =
			input.reuse_existing_repo_root && normalizedRepoRoot
				? this.findProjectByRepoRoot(
						scopeUserId,
						scopeAgentId,
						normalizedRepoRoot,
					)
				: null;
		if (existingByRepoRoot) {
			targetProjectId = existingByRepoRoot.project_id;
		}

		const existing = this.getProjectById(
			scopeUserId,
			scopeAgentId,
			targetProjectId,
		);
		if (existing) {
			const updateProject = this.db.prepare(
				`UPDATE projects
         SET project_name = ?, repo_root = ?, repo_remote_primary = ?, active_version = ?, updated_at = ?
         WHERE scope_user_id = ? AND scope_agent_id = ? AND project_id = ?`,
			);
			updateProject.run(
				projectName || existing.project_name,
				normalizedRepoRoot ?? existing.repo_root,
				normalizedRepoRemote ?? existing.repo_remote_primary,
				input.active_version ?? existing.active_version,
				now,
				scopeUserId,
				scopeAgentId,
				targetProjectId,
			);
		} else {
			const insertProject = this.db.prepare(
				`INSERT INTO projects (
          project_id, scope_user_id, scope_agent_id, project_name, repo_root, repo_remote_primary, active_version, lifecycle_status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
			);
			insertProject.run(
				targetProjectId,
				scopeUserId,
				scopeAgentId,
				projectName,
				normalizedRepoRoot,
				normalizedRepoRemote,
				input.active_version || null,
				now,
				now,
			);
		}

		this.upsertProjectAlias(
			scopeUserId,
			scopeAgentId,
			targetProjectId,
			projectAlias,
			true,
			now,
			input.allow_alias_update === true,
		);

		const project = this.getProjectById(
			scopeUserId,
			scopeAgentId,
			targetProjectId,
		);
		if (!project) throw new Error("failed to persist project registry record");

		const registration = this.upsertProjectRegistrationState(
			scopeUserId,
			scopeAgentId,
			{
				project_id: targetProjectId,
				registration_status: "registered",
				validation_status: "ok",
				validation_notes: null,
				completeness_score: this.computeRegistrationCompleteness(
					project,
					projectAlias,
				),
				missing_required_fields: this.computeMissingRegistrationFields(
					project,
					projectAlias,
				),
				last_validated_at: now,
			},
		);

		const alias = this.getProjectAlias(scopeUserId, scopeAgentId, projectAlias);
		if (!alias) throw new Error("failed to persist project alias");

		return { project, alias, registration };
	}

	private findProjectByRepoRoot(
		scopeUserId: string,
		scopeAgentId: string,
		repoRoot: string,
	): ProjectRecord | null {
		const normalizedRepoRoot = this.normalizeRepoRoot(repoRoot);
		if (!normalizedRepoRoot) return null;
		const stmt = this.db.prepare(
			`SELECT * FROM projects WHERE scope_user_id = ? AND scope_agent_id = ? AND repo_root = ? LIMIT 1`,
		);
		const row = stmt.get(scopeUserId, scopeAgentId, normalizedRepoRoot) as
			| ProjectRecord
			| undefined;
		return row || null;
	}

	getProjectById(
		scopeUserId: string,
		scopeAgentId: string,
		projectId: string,
	): ProjectRecord | null {
		const stmt = this.db.prepare(
			`SELECT * FROM projects WHERE scope_user_id = ? AND scope_agent_id = ? AND project_id = ?`,
		);
		const row = stmt.get(scopeUserId, scopeAgentId, projectId) as
			| ProjectRecord
			| undefined;
		return row || null;
	}

	getProjectAlias(
		scopeUserId: string,
		scopeAgentId: string,
		projectAlias: string,
	): ProjectAliasRecord | null {
		const normalizedAlias = this.normalizeProjectAlias(projectAlias);
		const stmt = this.db.prepare(
			`SELECT * FROM project_aliases WHERE scope_user_id = ? AND scope_agent_id = ? AND project_alias = ?`,
		);
		const row = stmt.get(scopeUserId, scopeAgentId, normalizedAlias) as
			| ProjectAliasRecord
			| undefined;
		return row || null;
	}

	getProjectByAlias(
		scopeUserId: string,
		scopeAgentId: string,
		projectAlias: string,
	): {
		project: ProjectRecord;
		alias: ProjectAliasRecord;
	} | null {
		const normalizedAlias = this.normalizeProjectAlias(projectAlias);
		const stmt = this.db.prepare(
			`SELECT p.project_id, p.scope_user_id, p.scope_agent_id, p.project_name, p.repo_root, p.repo_remote_primary,
              p.active_version, p.lifecycle_status, p.created_at, p.updated_at,
              a.id as alias_id, a.project_alias, a.is_primary, a.created_at as alias_created_at, a.updated_at as alias_updated_at
       FROM project_aliases a
       JOIN projects p ON p.project_id = a.project_id
         AND p.scope_user_id = a.scope_user_id
         AND p.scope_agent_id = a.scope_agent_id
       WHERE a.scope_user_id = ? AND a.scope_agent_id = ? AND a.project_alias = ?`,
		);
		const row = stmt.get(scopeUserId, scopeAgentId, normalizedAlias) as
			| Record<string, unknown>
			| undefined;
		if (!row) return null;

		return {
			project: {
				project_id: String(row.project_id),
				scope_user_id: String(row.scope_user_id),
				scope_agent_id: String(row.scope_agent_id),
				project_name: String(row.project_name),
				repo_root: row.repo_root ? String(row.repo_root) : null,
				repo_remote_primary: row.repo_remote_primary
					? String(row.repo_remote_primary)
					: null,
				active_version: row.active_version ? String(row.active_version) : null,
				lifecycle_status: String(row.lifecycle_status) as
					| "active"
					| "archived"
					| "disabled"
					| "detached"
					| "deindexed"
					| "purged",
				created_at: String(row.created_at),
				updated_at: String(row.updated_at),
			},
			alias: {
				id: String(row.alias_id),
				project_id: String(row.project_id),
				scope_user_id: String(row.scope_user_id),
				scope_agent_id: String(row.scope_agent_id),
				project_alias: String(row.project_alias),
				is_primary: Number(row.is_primary),
				created_at: String(row.alias_created_at),
				updated_at: String(row.alias_updated_at),
			},
		};
	}

	listProjects(
		scopeUserId: string,
		scopeAgentId: string,
	): Array<{
		project: ProjectRecord;
		aliases: ProjectAliasRecord[];
		registration: ProjectRegistrationStateRecord | null;
	}> {
		const projectsStmt = this.db.prepare(
			`SELECT * FROM projects WHERE scope_user_id = ? AND scope_agent_id = ? ORDER BY updated_at DESC`,
		);
		const projects = projectsStmt.all(
			scopeUserId,
			scopeAgentId,
		) as unknown as ProjectRecord[];

		const aliasesStmt = this.db.prepare(
			`SELECT * FROM project_aliases WHERE scope_user_id = ? AND scope_agent_id = ? ORDER BY is_primary DESC, project_alias ASC`,
		);
		const aliases = aliasesStmt.all(
			scopeUserId,
			scopeAgentId,
		) as unknown as ProjectAliasRecord[];

		const aliasesByProject = new Map<string, ProjectAliasRecord[]>();
		for (const alias of aliases) {
			const list = aliasesByProject.get(alias.project_id) || [];
			list.push(alias);
			aliasesByProject.set(alias.project_id, list);
		}

		return projects.map((project) => ({
			project,
			aliases: aliasesByProject.get(project.project_id) || [],
			registration: this.getProjectRegistrationState(
				scopeUserId,
				scopeAgentId,
				project.project_id,
			),
		}));
	}

	setProjectTrackerMapping(
		scopeUserId: string,
		scopeAgentId: string,
		input: ProjectTrackerMappingInput,
	): ProjectTrackerMappingRecord {
		const now = new Date().toISOString();
		const existing = this.getProjectTrackerMapping(
			scopeUserId,
			scopeAgentId,
			input.project_id,
			input.tracker_type,
		);

		if (existing) {
			const stmt = this.db.prepare(
				`UPDATE project_tracker_mappings
         SET tracker_space_key = ?, tracker_project_id = ?, default_epic_key = ?, board_key = ?,
             active_version = ?, external_project_url = ?, updated_at = ?
         WHERE scope_user_id = ? AND scope_agent_id = ? AND project_id = ? AND tracker_type = ?`,
			);
			stmt.run(
				input.tracker_space_key || null,
				input.tracker_project_id || null,
				input.default_epic_key || null,
				input.board_key || null,
				input.active_version || null,
				input.external_project_url || null,
				now,
				scopeUserId,
				scopeAgentId,
				input.project_id,
				input.tracker_type,
			);
		} else {
			const stmt = this.db.prepare(
				`INSERT INTO project_tracker_mappings (
          id, project_id, scope_user_id, scope_agent_id, tracker_type, tracker_space_key, tracker_project_id,
          default_epic_key, board_key, active_version, external_project_url, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			);
			stmt.run(
				randomUUID(),
				input.project_id,
				scopeUserId,
				scopeAgentId,
				input.tracker_type,
				input.tracker_space_key || null,
				input.tracker_project_id || null,
				input.default_epic_key || null,
				input.board_key || null,
				input.active_version || null,
				input.external_project_url || null,
				now,
				now,
			);
		}

		const mapping = this.getProjectTrackerMapping(
			scopeUserId,
			scopeAgentId,
			input.project_id,
			input.tracker_type,
		);
		if (!mapping) throw new Error("failed to persist project tracker mapping");
		return mapping;
	}

	getProjectTrackerMapping(
		scopeUserId: string,
		scopeAgentId: string,
		projectId: string,
		trackerType: "jira" | "github" | "other",
	): ProjectTrackerMappingRecord | null {
		const stmt = this.db.prepare(
			`SELECT * FROM project_tracker_mappings WHERE scope_user_id = ? AND scope_agent_id = ? AND project_id = ? AND tracker_type = ?`,
		);
		const row = stmt.get(scopeUserId, scopeAgentId, projectId, trackerType) as
			| ProjectTrackerMappingRecord
			| undefined;
		return row || null;
	}

	getProjectRegistrationState(
		scopeUserId: string,
		scopeAgentId: string,
		projectId: string,
	): ProjectRegistrationStateRecord | null {
		const stmt = this.db.prepare(
			`SELECT * FROM project_registration_state WHERE scope_user_id = ? AND scope_agent_id = ? AND project_id = ?`,
		);
		const row = stmt.get(scopeUserId, scopeAgentId, projectId) as
			| {
					project_id: string;
					scope_user_id: string;
					scope_agent_id: string;
					registration_status: "draft" | "registered" | "validated" | "blocked";
					validation_status: "pending" | "ok" | "warn" | "error";
					validation_notes: string | null;
					completeness_score: number;
					missing_required_fields: string | null;
					last_validated_at: string | null;
					updated_at: string;
			  }
			| undefined;
		if (!row) return null;
		return {
			project_id: row.project_id,
			scope_user_id: row.scope_user_id,
			scope_agent_id: row.scope_agent_id,
			registration_status: row.registration_status,
			validation_status: row.validation_status,
			validation_notes: row.validation_notes,
			completeness_score: row.completeness_score,
			missing_required_fields: this.parseJsonArrayField(
				row.missing_required_fields,
			),
			last_validated_at: row.last_validated_at,
			updated_at: row.updated_at,
		};
	}

	updateProjectRegistrationState(
		scopeUserId: string,
		scopeAgentId: string,
		input: {
			project_id: string;
			registration_status: "draft" | "registered" | "validated" | "blocked";
			validation_status: "pending" | "ok" | "warn" | "error";
			validation_notes?: string | null;
			completeness_score: number;
			missing_required_fields: string[];
			last_validated_at?: string | null;
		},
	): ProjectRegistrationStateRecord {
		return this.upsertProjectRegistrationState(scopeUserId, scopeAgentId, {
			...input,
			validation_notes: input.validation_notes ?? null,
			last_validated_at: input.last_validated_at ?? new Date().toISOString(),
		});
	}

	getProjectIndexWatchState(
		scopeUserId: string,
		scopeAgentId: string,
		projectId: string,
	): ProjectIndexWatchState | null {
		const stmt = this.db.prepare(
			`SELECT * FROM project_index_watch_state WHERE scope_user_id = ? AND scope_agent_id = ? AND project_id = ?`,
		);
		const row = stmt.get(scopeUserId, scopeAgentId, projectId) as
			| {
					project_id: string;
					scope_user_id: string;
					scope_agent_id: string;
					last_source_rev: string | null;
					last_checksum_snapshot: string | null;
					updated_at: string;
			  }
			| undefined;

		if (!row) return null;
		return {
			project_id: row.project_id,
			scope_user_id: row.scope_user_id,
			scope_agent_id: row.scope_agent_id,
			last_source_rev: row.last_source_rev,
			last_checksum_snapshot: this.parseChecksumMap(row.last_checksum_snapshot),
			updated_at: row.updated_at,
		};
	}

	deindexProject(
		scopeUserId: string,
		scopeAgentId: string,
		input: { project_id: string; reason?: string | null },
	): ProjectDeindexResult {
		const projectId = String(input.project_id || "").trim();
		if (!projectId) throw new Error("project_id is required");

		const project = this.getProjectById(scopeUserId, scopeAgentId, projectId);
		if (!project) {
			throw new Error(`project_id '${projectId}' is not registered`);
		}

		const now = new Date().toISOString();
		const reason =
			input.reason == null ? null : String(input.reason).trim() || null;

		const fileCountStmt = this.db.prepare(
			`SELECT COUNT(*) as cnt FROM file_index_state
       WHERE scope_user_id = ? AND scope_agent_id = ? AND project_id = ? AND active = 1`,
		);
		const chunkCountStmt = this.db.prepare(
			`SELECT COUNT(*) as cnt FROM chunk_registry
       WHERE scope_user_id = ? AND scope_agent_id = ? AND project_id = ? AND active = 1`,
		);
		const symbolCountStmt = this.db.prepare(
			`SELECT COUNT(*) as cnt FROM symbol_registry
       WHERE scope_user_id = ? AND scope_agent_id = ? AND project_id = ? AND active = 1`,
		);

		const files = Number(
			(
				fileCountStmt.get(scopeUserId, scopeAgentId, projectId) as
					| { cnt: number }
					| undefined
			)?.cnt || 0,
		);
		const chunks = Number(
			(
				chunkCountStmt.get(scopeUserId, scopeAgentId, projectId) as
					| { cnt: number }
					| undefined
			)?.cnt || 0,
		);
		const symbols = Number(
			(
				symbolCountStmt.get(scopeUserId, scopeAgentId, projectId) as
					| { cnt: number }
					| undefined
			)?.cnt || 0,
		);

		this.db
			.prepare(
				`UPDATE file_index_state
       SET index_state = 'stale', active = 0, tombstone_at = ?, indexed_at = ?
       WHERE scope_user_id = ? AND scope_agent_id = ? AND project_id = ? AND active = 1`,
			)
			.run(now, now, scopeUserId, scopeAgentId, projectId);

		this.db
			.prepare(
				`UPDATE chunk_registry
       SET index_state = 'stale', active = 0, tombstone_at = ?, indexed_at = ?
       WHERE scope_user_id = ? AND scope_agent_id = ? AND project_id = ? AND active = 1`,
			)
			.run(now, now, scopeUserId, scopeAgentId, projectId);

		this.db
			.prepare(
				`UPDATE symbol_registry
       SET index_state = 'stale', active = 0, tombstone_at = ?, indexed_at = ?
       WHERE scope_user_id = ? AND scope_agent_id = ? AND project_id = ? AND active = 1`,
			)
			.run(now, now, scopeUserId, scopeAgentId, projectId);

		this.db
			.prepare(
				`UPDATE projects
       SET lifecycle_status = 'deindexed', updated_at = ?
       WHERE scope_user_id = ? AND scope_agent_id = ? AND project_id = ?`,
			)
			.run(now, scopeUserId, scopeAgentId, projectId);

		this.insertIndexRun(scopeUserId, scopeAgentId, {
			run_id: randomUUID(),
			project_id: projectId,
			index_profile: "default",
			trigger_type: "manual",
			state: "indexed",
			started_at: now,
			finished_at: now,
			error_message: reason ? `deindex:${reason}` : "deindex",
		});

		return {
			project_id: projectId,
			lifecycle_status: "deindexed",
			deindexed_at: now,
			reason,
			affected: {
				files,
				chunks,
				symbols,
			},
			searchable: false,
		};
	}

	detachProject(
		scopeUserId: string,
		scopeAgentId: string,
		input: { project_id: string; reason?: string | null },
	): ProjectDetachResult {
		const projectId = String(input.project_id || "").trim();
		if (!projectId) throw new Error("project_id is required");

		const project = this.getProjectById(scopeUserId, scopeAgentId, projectId);
		if (!project) {
			throw new Error(`project_id '${projectId}' is not registered`);
		}

		const reason =
			input.reason == null ? null : String(input.reason).trim() || null;
		if (project.lifecycle_status !== "deindexed") {
			this.deindexProject(scopeUserId, scopeAgentId, {
				project_id: projectId,
				reason: reason || "detach_precondition_deindex",
			});
		}

		const now = new Date().toISOString();
		const aliasesRemoved = Number(
			(
				this.db
					.prepare(
						`SELECT COUNT(*) as cnt FROM project_aliases
       WHERE scope_user_id = ? AND scope_agent_id = ? AND project_id = ?`,
					)
					.get(scopeUserId, scopeAgentId, projectId) as
					| { cnt: number }
					| undefined
			)?.cnt || 0,
		);
		const trackerMappingsRemoved = Number(
			(
				this.db
					.prepare(
						`SELECT COUNT(*) as cnt FROM project_tracker_mappings
       WHERE scope_user_id = ? AND scope_agent_id = ? AND project_id = ?`,
					)
					.get(scopeUserId, scopeAgentId, projectId) as
					| { cnt: number }
					| undefined
			)?.cnt || 0,
		);

		this.db
			.prepare(
				`DELETE FROM project_aliases
       WHERE scope_user_id = ? AND scope_agent_id = ? AND project_id = ?`,
			)
			.run(scopeUserId, scopeAgentId, projectId);

		this.db
			.prepare(
				`DELETE FROM project_tracker_mappings
       WHERE scope_user_id = ? AND scope_agent_id = ? AND project_id = ?`,
			)
			.run(scopeUserId, scopeAgentId, projectId);

		this.db
			.prepare(
				`UPDATE projects
       SET lifecycle_status = 'detached', repo_root = NULL, repo_remote_primary = NULL, active_version = NULL, updated_at = ?
       WHERE scope_user_id = ? AND scope_agent_id = ? AND project_id = ?`,
			)
			.run(now, scopeUserId, scopeAgentId, projectId);

		return {
			project_id: projectId,
			lifecycle_status: "detached",
			detached_at: now,
			reason,
			detached_fields: {
				repo_root: project.repo_root != null,
				repo_remote_primary: project.repo_remote_primary != null,
				active_version: project.active_version != null,
				aliases_removed: aliasesRemoved,
				tracker_mappings_removed: trackerMappingsRemoved,
			},
			searchable: false,
			next_actions: {
				reattach_via_register_or_update: true,
				reversible_by_re_register: true,
			},
		};
	}

	unregisterProject(
		scopeUserId: string,
		scopeAgentId: string,
		input: {
			project_id: string;
			confirm?: boolean;
			mode?: "safe";
			reason?: string | null;
		},
	): ProjectUnregisterResult {
		const projectId = String(input.project_id || "").trim();
		if (!projectId) throw new Error("project_id is required");

		const mode = input.mode || "safe";
		if (mode !== "safe") {
			throw new Error("project.unregister currently supports mode='safe' only");
		}
		if (input.confirm !== true) {
			throw new Error("project.unregister requires explicit confirm=true");
		}

		const project = this.getProjectById(scopeUserId, scopeAgentId, projectId);
		if (!project) {
			throw new Error(`project_id '${projectId}' is not registered`);
		}

		const reason =
			input.reason == null ? null : String(input.reason).trim() || null;
		let deindexedFirst = false;
		if (project.lifecycle_status !== "deindexed") {
			this.deindexProject(scopeUserId, scopeAgentId, {
				project_id: projectId,
				reason: reason || "unregister_precondition_deindex",
			});
			deindexedFirst = true;
		}

		const now = new Date().toISOString();
		const aliasesRemoved = Number(
			(
				this.db
					.prepare(
						`SELECT COUNT(*) as cnt FROM project_aliases
       WHERE scope_user_id = ? AND scope_agent_id = ? AND project_id = ?`,
					)
					.get(scopeUserId, scopeAgentId, projectId) as
					| { cnt: number }
					| undefined
			)?.cnt || 0,
		);
		const trackerMappingsRemoved = Number(
			(
				this.db
					.prepare(
						`SELECT COUNT(*) as cnt FROM project_tracker_mappings
       WHERE scope_user_id = ? AND scope_agent_id = ? AND project_id = ?`,
					)
					.get(scopeUserId, scopeAgentId, projectId) as
					| { cnt: number }
					| undefined
			)?.cnt || 0,
		);

		this.db
			.prepare(
				`DELETE FROM project_aliases
       WHERE scope_user_id = ? AND scope_agent_id = ? AND project_id = ?`,
			)
			.run(scopeUserId, scopeAgentId, projectId);

		this.db
			.prepare(
				`DELETE FROM project_tracker_mappings
       WHERE scope_user_id = ? AND scope_agent_id = ? AND project_id = ?`,
			)
			.run(scopeUserId, scopeAgentId, projectId);

		this.db
			.prepare(
				`UPDATE projects
       SET lifecycle_status = 'disabled', repo_root = NULL, repo_remote_primary = NULL, active_version = NULL, updated_at = ?
       WHERE scope_user_id = ? AND scope_agent_id = ? AND project_id = ?`,
			)
			.run(now, scopeUserId, scopeAgentId, projectId);

		this.upsertProjectRegistrationState(scopeUserId, scopeAgentId, {
			project_id: projectId,
			registration_status: "draft",
			validation_status: "warn",
			validation_notes: reason ? `unregistered:${reason}` : "unregistered",
			completeness_score: 0,
			missing_required_fields: ["project_alias", "repo_root"],
			last_validated_at: now,
		});

		return {
			project_id: projectId,
			lifecycle_status: "disabled",
			unregistered_at: now,
			mode,
			reason,
			detached_fields: {
				aliases_removed: aliasesRemoved,
				tracker_mappings_removed: trackerMappingsRemoved,
			},
			registration_state: {
				registration_status: "draft",
				validation_status: "warn",
			},
			searchable: false,
			audit: {
				deindexed_first: deindexedFirst,
				confirm_required: true,
			},
		};
	}

	purgePreviewProject(
		scopeUserId: string,
		scopeAgentId: string,
		input: { project_id: string },
	): ProjectPurgePreviewResult {
		const projectId = String(input.project_id || "").trim();
		if (!projectId) throw new Error("project_id is required");

		const project = this.getProjectById(scopeUserId, scopeAgentId, projectId);
		if (!project) {
			throw new Error(`project_id '${projectId}' is not registered`);
		}

		const countBy = (table: string) =>
			Number(
				(
					this.db
						.prepare(
							`SELECT COUNT(*) as cnt FROM ${table}
         WHERE scope_user_id = ? AND scope_agent_id = ? AND project_id = ?`,
						)
						.get(scopeUserId, scopeAgentId, projectId) as
						| { cnt: number }
						| undefined
				)?.cnt || 0,
			);

		const canPurge = project.lifecycle_status === "disabled";
		const reason = canPurge
			? "safe to purge: lifecycle_status is disabled and explicit confirm is still required"
			: `purge blocked: lifecycle_status must be disabled (current=${project.lifecycle_status})`;

		return {
			project_id: projectId,
			current_lifecycle_status: project.lifecycle_status,
			purge_guard: {
				destructive: true,
				allowed: canPurge,
				reason,
				requires_lifecycle_status: "disabled",
				requires_confirm: true,
			},
			affected: {
				project_row: 1,
				aliases: countBy("project_aliases"),
				tracker_mappings: countBy("project_tracker_mappings"),
				registration_state: countBy("project_registration_state"),
				index_runs: countBy("index_runs"),
				watch_state: countBy("project_index_watch_state"),
				file_index_state: countBy("file_index_state"),
				chunk_registry: countBy("chunk_registry"),
				symbol_registry: countBy("symbol_registry"),
				task_registry: countBy("task_registry"),
			},
			previewed_at: new Date().toISOString(),
		};
	}

	purgeProject(
		scopeUserId: string,
		scopeAgentId: string,
		input: { project_id: string; confirm?: boolean; reason?: string | null },
	): ProjectPurgeResult {
		const projectId = String(input.project_id || "").trim();
		if (!projectId) throw new Error("project_id is required");
		if (input.confirm !== true) {
			throw new Error("project.purge requires explicit confirm=true");
		}

		const preview = this.purgePreviewProject(scopeUserId, scopeAgentId, {
			project_id: projectId,
		});
		if (!preview.purge_guard.allowed) {
			throw new Error(preview.purge_guard.reason);
		}

		const now = new Date().toISOString();
		const reason =
			input.reason == null ? null : String(input.reason).trim() || null;

		const deleted = {
			project_row: 1 as const,
			aliases: preview.affected.aliases,
			tracker_mappings: preview.affected.tracker_mappings,
			registration_state: preview.affected.registration_state,
			index_runs: preview.affected.index_runs,
			watch_state: preview.affected.watch_state,
			file_index_state: preview.affected.file_index_state,
			chunk_registry: preview.affected.chunk_registry,
			symbol_registry: preview.affected.symbol_registry,
			task_registry: preview.affected.task_registry,
		};

		this.db.exec("BEGIN");
		try {
			this.db
				.prepare(
					`DELETE FROM project_aliases
         WHERE scope_user_id = ? AND scope_agent_id = ? AND project_id = ?`,
				)
				.run(scopeUserId, scopeAgentId, projectId);

			this.db
				.prepare(
					`DELETE FROM project_tracker_mappings
         WHERE scope_user_id = ? AND scope_agent_id = ? AND project_id = ?`,
				)
				.run(scopeUserId, scopeAgentId, projectId);

			this.db
				.prepare(
					`DELETE FROM project_registration_state
         WHERE scope_user_id = ? AND scope_agent_id = ? AND project_id = ?`,
				)
				.run(scopeUserId, scopeAgentId, projectId);

			this.db
				.prepare(
					`DELETE FROM index_runs
         WHERE scope_user_id = ? AND scope_agent_id = ? AND project_id = ?`,
				)
				.run(scopeUserId, scopeAgentId, projectId);

			this.db
				.prepare(
					`DELETE FROM project_index_watch_state
         WHERE scope_user_id = ? AND scope_agent_id = ? AND project_id = ?`,
				)
				.run(scopeUserId, scopeAgentId, projectId);

			this.db
				.prepare(
					`DELETE FROM file_index_state
         WHERE scope_user_id = ? AND scope_agent_id = ? AND project_id = ?`,
				)
				.run(scopeUserId, scopeAgentId, projectId);

			this.db
				.prepare(
					`DELETE FROM chunk_registry
         WHERE scope_user_id = ? AND scope_agent_id = ? AND project_id = ?`,
				)
				.run(scopeUserId, scopeAgentId, projectId);

			this.db
				.prepare(
					`DELETE FROM symbol_registry
         WHERE scope_user_id = ? AND scope_agent_id = ? AND project_id = ?`,
				)
				.run(scopeUserId, scopeAgentId, projectId);

			this.db
				.prepare(
					`DELETE FROM task_registry
         WHERE scope_user_id = ? AND scope_agent_id = ? AND project_id = ?`,
				)
				.run(scopeUserId, scopeAgentId, projectId);

			this.db
				.prepare(
					`DELETE FROM projects
         WHERE scope_user_id = ? AND scope_agent_id = ? AND project_id = ?`,
				)
				.run(scopeUserId, scopeAgentId, projectId);

			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}

		return {
			project_id: projectId,
			lifecycle_status: "purged",
			purged_at: now,
			reason,
			deleted,
			searchable: false,
			recoverable: false,
			audit: {
				confirm_required: true,
				allowed_from_lifecycle_status: "disabled",
			},
		};
	}

	reindexProjectByDiff(
		scopeUserId: string,
		scopeAgentId: string,
		input: ProjectReindexDiffInput,
	): ProjectReindexDiffResult {
		const now = new Date().toISOString();
		const runId = randomUUID();
		const triggerType = input.trigger_type || "incremental";
		const indexProfile = (input.index_profile || "default").trim() || "default";
		const sourceRev = input.source_rev?.trim() || null;

		if (!input.project_id || !String(input.project_id).trim()) {
			throw new Error("project_id is required");
		}

		const project = this.getProjectById(
			scopeUserId,
			scopeAgentId,
			input.project_id,
		);
		if (!project) {
			throw new Error(`project_id '${input.project_id}' is not registered`);
		}

		const watch = this.getProjectIndexWatchState(
			scopeUserId,
			scopeAgentId,
			input.project_id,
		);
		const previousSnapshot = watch?.last_checksum_snapshot || {};

		const currentSnapshot = new Map<string, string>();
		for (const item of input.paths || []) {
			const relativePath = this.normalizeRelativePath(item.relative_path);
			if (!relativePath) continue;
			const checksum = (item.checksum || "").trim() || "__missing__";
			currentSnapshot.set(relativePath, checksum);
		}

		const changed: string[] = [];
		const unchanged: string[] = [];

		for (const [relativePath, checksum] of currentSnapshot.entries()) {
			const prev = previousSnapshot[relativePath];
			if (!prev || prev !== checksum) changed.push(relativePath);
			else unchanged.push(relativePath);
		}

		const deleted: string[] = [];
		const treatAsFullSnapshot =
			input.full_snapshot === true || triggerType === "bootstrap";
		if (treatAsFullSnapshot) {
			for (const prevPath of Object.keys(previousSnapshot)) {
				if (!currentSnapshot.has(prevPath)) deleted.push(prevPath);
			}
		}

		this.insertIndexRun(scopeUserId, scopeAgentId, {
			run_id: runId,
			project_id: input.project_id,
			index_profile: indexProfile,
			trigger_type: triggerType,
			state: "indexing",
			started_at: now,
			finished_at: null,
			error_message: null,
		});

		try {
			const nowIso = new Date().toISOString();
			for (const relativePath of changed) {
				const item = (input.paths || []).find(
					(p) => this.normalizeRelativePath(p.relative_path) === relativePath,
				);
				const fileId = this.makeScopedId(input.project_id, relativePath);
				const language = item?.language || null;
				this.upsertFileIndexState(scopeUserId, scopeAgentId, {
					file_id: fileId,
					project_id: input.project_id,
					relative_path: relativePath,
					module: item?.module || null,
					language,
					checksum: currentSnapshot.get(relativePath) || "__missing__",
					last_commit_sha: sourceRev,
					index_state: "indexed",
					active: 1,
					tombstone_at: null,
					indexed_at: nowIso,
				});

				this.markProjectChunksByFileDeleted(
					scopeUserId,
					scopeAgentId,
					input.project_id,
					relativePath,
					nowIso,
				);
				this.markProjectSymbolsByFileDeleted(
					scopeUserId,
					scopeAgentId,
					input.project_id,
					relativePath,
					nowIso,
				);

				const content = String(item?.content || "");
				if (content.trim()) {
					const blocks = extractSemanticBlocks({ relativePath, content });
					const chunks = buildChunkArtifacts(
						input.project_id,
						fileId,
						relativePath,
						blocks,
					);
					for (const chunk of chunks) {
						this.upsertChunkRegistry(scopeUserId, scopeAgentId, {
							chunk_id: chunk.chunk_id,
							project_id: input.project_id,
							file_id: chunk.file_id,
							relative_path: chunk.relative_path,
							chunk_kind: chunk.chunk_kind,
							symbol_id: chunk.symbol_id,
							task_id: null,
							checksum: chunk.checksum,
							qdrant_point_id: null,
							index_state: "indexed",
							active: 1,
							tombstone_at: null,
							indexed_at: nowIso,
						});
					}

					for (const block of blocks) {
						if (
							!block.symbol_name ||
							!["function", "class", "method", "tool"].includes(block.kind)
						)
							continue;
						const symbolFqn =
							block.semantic_path || `${block.kind}:${block.symbol_name}`;
						this.upsertSymbolRegistry(scopeUserId, scopeAgentId, {
							symbol_id: buildSymbolId(
								input.project_id,
								relativePath,
								symbolFqn,
							),
							project_id: input.project_id,
							relative_path: relativePath,
							module: item?.module || null,
							language: language || "text",
							symbol_name: block.symbol_name,
							symbol_fqn: symbolFqn,
							symbol_kind: block.kind,
							signature_hash: null,
							index_state: "indexed",
							active: 1,
							tombstone_at: null,
							indexed_at: nowIso,
						});
					}

					populateUniversalCodeGraphForFile(
						this.graph,
						scopeUserId,
						scopeAgentId,
						{
							projectId: input.project_id,
							relativePath,
							module: item?.module || null,
							language: language || "text",
							content,
							blocks,
						},
					);
				}
			}

			for (const relativePath of deleted) {
				this.markFileIndexStateDeleted(
					scopeUserId,
					scopeAgentId,
					input.project_id,
					relativePath,
					nowIso,
				);
				this.markProjectChunksByFileDeleted(
					scopeUserId,
					scopeAgentId,
					input.project_id,
					relativePath,
					nowIso,
				);
				this.markProjectSymbolsByFileDeleted(
					scopeUserId,
					scopeAgentId,
					input.project_id,
					relativePath,
					nowIso,
				);
			}

			const checksumSnapshotRecord = Object.fromEntries(
				currentSnapshot.entries(),
			);
			this.upsertProjectIndexWatchState(scopeUserId, scopeAgentId, {
				project_id: input.project_id,
				last_source_rev: sourceRev,
				last_checksum_snapshot: checksumSnapshotRecord,
				updated_at: nowIso,
			});

			this.db
				.prepare(
					`UPDATE projects
         SET lifecycle_status = 'active', updated_at = ?
         WHERE scope_user_id = ? AND scope_agent_id = ? AND project_id = ? AND lifecycle_status = 'deindexed'`,
				)
				.run(nowIso, scopeUserId, scopeAgentId, input.project_id);

			this.finishIndexRun(
				scopeUserId,
				scopeAgentId,
				runId,
				"indexed",
				null,
				nowIso,
			);

			this.db
				.prepare(
					`UPDATE projects
         SET lifecycle_status = 'active', updated_at = ?
         WHERE scope_user_id = ? AND scope_agent_id = ? AND project_id = ?
           AND lifecycle_status = 'deindexed'`,
				)
				.run(nowIso, scopeUserId, scopeAgentId, input.project_id);

			return {
				run_id: runId,
				project_id: input.project_id,
				trigger_type: triggerType,
				index_profile: indexProfile,
				source_rev: sourceRev,
				changed,
				unchanged,
				deleted,
				run_state: "indexed",
				watch_state: {
					last_source_rev: sourceRev,
					updated_at: nowIso,
				},
			};
		} catch (error) {
			const err = error instanceof Error ? error.message : String(error);
			this.finishIndexRun(
				scopeUserId,
				scopeAgentId,
				runId,
				"error",
				err,
				new Date().toISOString(),
			);
			throw error;
		}
	}

	upsertTaskRegistryRecord(
		scopeUserId: string,
		scopeAgentId: string,
		input: ProjectTaskRegistryUpsertInput,
	): TaskRegistryRecord {
		const now = new Date().toISOString();
		const taskId = String(input.task_id || "").trim();
		const projectId = String(input.project_id || "").trim();
		const taskTitle = String(input.task_title || "").trim();

		if (!taskId) throw new Error("task_id is required");
		if (!projectId) throw new Error("project_id is required");
		if (!taskTitle) throw new Error("task_title is required");

		const project = this.getProjectById(scopeUserId, scopeAgentId, projectId);
		if (!project) {
			throw new Error(`project_id '${projectId}' is not registered`);
		}

		const existing = this.getTaskRegistryRecordById(
			scopeUserId,
			scopeAgentId,
			taskId,
		);

		const relatedTaskIds = this.normalizeStringArray(input.related_task_ids);
		const filesTouched = this.normalizeStringArray(input.files_touched)
			.map((p) => this.normalizeRelativePath(p))
			.filter(Boolean);
		const symbolsTouched = this.normalizeStringArray(input.symbols_touched);
		const commitRefs = this.normalizeStringArray(input.commit_refs);
		const diffRefs = this.normalizeStringArray(input.diff_refs);

		if (existing) {
			const stmt = this.db.prepare(
				`UPDATE task_registry
         SET project_id = ?, task_title = ?, task_type = ?, task_status = ?, parent_task_id = ?,
             related_task_ids = ?, files_touched = ?, symbols_touched = ?, commit_refs = ?, diff_refs = ?,
             decision_notes = ?, tracker_issue_key = ?, updated_at = ?
         WHERE scope_user_id = ? AND scope_agent_id = ? AND task_id = ?`,
			);
			stmt.run(
				projectId,
				taskTitle,
				input.task_type ?? null,
				input.task_status ?? null,
				input.parent_task_id ?? null,
				JSON.stringify(relatedTaskIds),
				JSON.stringify(filesTouched),
				JSON.stringify(symbolsTouched),
				JSON.stringify(commitRefs),
				JSON.stringify(diffRefs),
				input.decision_notes ?? null,
				input.tracker_issue_key ?? null,
				now,
				scopeUserId,
				scopeAgentId,
				taskId,
			);
		} else {
			const stmt = this.db.prepare(
				`INSERT INTO task_registry (
          task_id, scope_user_id, scope_agent_id, project_id, task_title, task_type, task_status, parent_task_id,
          related_task_ids, files_touched, symbols_touched, commit_refs, diff_refs, decision_notes, tracker_issue_key, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			);
			stmt.run(
				taskId,
				scopeUserId,
				scopeAgentId,
				projectId,
				taskTitle,
				input.task_type ?? null,
				input.task_status ?? null,
				input.parent_task_id ?? null,
				JSON.stringify(relatedTaskIds),
				JSON.stringify(filesTouched),
				JSON.stringify(symbolsTouched),
				JSON.stringify(commitRefs),
				JSON.stringify(diffRefs),
				input.decision_notes ?? null,
				input.tracker_issue_key ?? null,
				now,
			);
		}

		const row = this.getTaskRegistryRecordById(
			scopeUserId,
			scopeAgentId,
			taskId,
		);
		if (!row) throw new Error("failed to persist task registry record");
		return row;
	}

	getTaskRegistryRecordById(
		scopeUserId: string,
		scopeAgentId: string,
		taskId: string,
	): TaskRegistryRecord | null {
		const normalizedTaskId = String(taskId || "").trim();
		if (!normalizedTaskId) return null;

		const stmt = this.db.prepare(
			`SELECT * FROM task_registry WHERE scope_user_id = ? AND scope_agent_id = ? AND task_id = ?`,
		);
		const row = stmt.get(scopeUserId, scopeAgentId, normalizedTaskId) as
			| {
					task_id: string;
					scope_user_id: string;
					scope_agent_id: string;
					project_id: string;
					task_title: string;
					task_type: string | null;
					task_status: string | null;
					parent_task_id: string | null;
					related_task_ids: string | null;
					files_touched: string | null;
					symbols_touched: string | null;
					commit_refs: string | null;
					diff_refs: string | null;
					decision_notes: string | null;
					tracker_issue_key: string | null;
					updated_at: string;
			  }
			| undefined;

		if (!row) return null;
		return this.rowToTaskRecord(row);
	}

	getTaskRegistryRecordByTrackerIssueKey(
		scopeUserId: string,
		scopeAgentId: string,
		projectId: string,
		trackerIssueKey: string,
	): TaskRegistryRecord | null {
		const tracker = String(trackerIssueKey || "").trim();
		if (!tracker) return null;

		const stmt = this.db.prepare(
			`SELECT * FROM task_registry
       WHERE scope_user_id = ? AND scope_agent_id = ? AND project_id = ? AND tracker_issue_key = ?
       ORDER BY updated_at DESC LIMIT 1`,
		);
		const row = stmt.get(scopeUserId, scopeAgentId, projectId, tracker) as any;
		if (!row) return null;
		return this.rowToTaskRecord(row);
	}

	getTaskLineageContext(
		scopeUserId: string,
		scopeAgentId: string,
		input: ProjectTaskLineageContextInput,
	): ProjectTaskLineageContextResult {
		const projectId = String(input.project_id || "").trim();
		if (!projectId) throw new Error("project_id is required");

		const project = this.getProjectById(scopeUserId, scopeAgentId, projectId);
		if (!project) {
			throw new Error(`project_id '${projectId}' is not registered`);
		}

		let focus: TaskRegistryRecord | null = null;

		if (input.task_id) {
			const byId = this.getTaskRegistryRecordById(
				scopeUserId,
				scopeAgentId,
				input.task_id,
			);
			if (byId && byId.project_id === projectId) focus = byId;
		}

		if (!focus && input.tracker_issue_key) {
			focus = this.getTaskRegistryRecordByTrackerIssueKey(
				scopeUserId,
				scopeAgentId,
				projectId,
				input.tracker_issue_key,
			);
		}

		if (!focus && input.task_title) {
			const stmt = this.db.prepare(
				`SELECT * FROM task_registry
         WHERE scope_user_id = ? AND scope_agent_id = ? AND project_id = ? AND lower(task_title) LIKE ?
         ORDER BY updated_at DESC LIMIT 1`,
			);
			const row = stmt.get(
				scopeUserId,
				scopeAgentId,
				projectId,
				`%${String(input.task_title).trim().toLowerCase()}%`,
			) as any;
			if (row) focus = this.rowToTaskRecord(row);
		}

		if (!focus) {
			throw new Error("task lineage focus not found for provided selector");
		}

		const includeParentChain = input.include_parent_chain !== false;
		const includeRelated = input.include_related !== false;

		const parentChain: TaskRegistryRecord[] = [];
		if (includeParentChain) {
			let cursor = focus.parent_task_id;
			const guard = new Set<string>();
			while (cursor && !guard.has(cursor)) {
				guard.add(cursor);
				const parent = this.getTaskRegistryRecordById(
					scopeUserId,
					scopeAgentId,
					cursor,
				);
				if (!parent) break;
				parentChain.push(parent);
				cursor = parent.parent_task_id;
			}
		}

		const relatedTasks: TaskRegistryRecord[] = [];
		if (includeRelated) {
			const seen = new Set<string>();
			for (const relatedId of focus.related_task_ids || []) {
				if (!relatedId || seen.has(relatedId)) continue;
				seen.add(relatedId);
				const related = this.getTaskRegistryRecordById(
					scopeUserId,
					scopeAgentId,
					relatedId,
				);
				if (related) relatedTasks.push(related);
			}
		}

		const aggregate = [focus, ...parentChain, ...relatedTasks];
		const touchedFiles = this.uniqueSorted(
			aggregate.flatMap((t) => t.files_touched || []),
		);
		const touchedSymbols = this.uniqueSorted(
			aggregate.flatMap((t) => t.symbols_touched || []),
		);
		const commitRefs = this.uniqueSorted(
			aggregate.flatMap((t) => t.commit_refs || []),
		);
		const decisionNotes = this.uniqueSorted(
			aggregate
				.map((t) => String(t.decision_notes || "").trim())
				.filter(Boolean),
		);

		return {
			focus: {
				project_id: projectId,
				task_id: focus.task_id,
				tracker_issue_key: focus.tracker_issue_key,
				task_title: focus.task_title,
			},
			parent_chain: parentChain,
			related_tasks: relatedTasks,
			touched_files: touchedFiles,
			touched_symbols: touchedSymbols,
			commit_refs: commitRefs,
			decision_notes: decisionNotes,
		};
	}

	hybridSearchProjectContext(
		scopeUserId: string,
		scopeAgentId: string,
		input: ProjectHybridSearchInput,
	): ProjectHybridSearchResult {
		const projectId = String(input.project_id || "").trim();
		const query = String(input.query || "").trim();
		if (!projectId) throw new Error("project_id is required");
		if (!query) throw new Error("query is required");

		const project = this.getProjectById(scopeUserId, scopeAgentId, projectId);
		if (!project) {
			throw new Error(`project_id '${projectId}' is not registered`);
		}

		const isSearchDisabled = [
			"deindexed",
			"detached",
			"disabled",
			"purged",
		].includes(project.lifecycle_status);
		if (isSearchDisabled) {
			const files = Number(
				(
					this.db
						.prepare(
							`SELECT COUNT(*) as cnt FROM file_index_state
         WHERE scope_user_id = ? AND scope_agent_id = ? AND project_id = ? AND tombstone_at IS NOT NULL`,
						)
						.get(scopeUserId, scopeAgentId, projectId) as
						| { cnt: number }
						| undefined
				)?.cnt || 0,
			);
			const chunks = Number(
				(
					this.db
						.prepare(
							`SELECT COUNT(*) as cnt FROM chunk_registry
         WHERE scope_user_id = ? AND scope_agent_id = ? AND project_id = ? AND tombstone_at IS NOT NULL`,
						)
						.get(scopeUserId, scopeAgentId, projectId) as
						| { cnt: number }
						| undefined
				)?.cnt || 0,
			);
			const symbols = Number(
				(
					this.db
						.prepare(
							`SELECT COUNT(*) as cnt FROM symbol_registry
         WHERE scope_user_id = ? AND scope_agent_id = ? AND project_id = ? AND tombstone_at IS NOT NULL`,
						)
						.get(scopeUserId, scopeAgentId, projectId) as
						| { cnt: number }
						| undefined
				)?.cnt || 0,
			);

			const taskContextSelector = {
				...(input.task_context?.task_id
					? { task_id: String(input.task_context.task_id).trim() }
					: {}),
				...(input.task_context?.tracker_issue_key
					? {
							tracker_issue_key: String(
								input.task_context.tracker_issue_key,
							).trim(),
						}
					: {}),
				...(input.task_context?.task_title
					? { task_title: String(input.task_context.task_title).trim() }
					: {}),
			};
			const reasonByLifecycle: Record<string, string> = {
				deindexed: "project is deindexed; retrieval is disabled until reindex",
				detached:
					"project is detached; retrieval is disabled until project is re-attached and reindexed",
				disabled:
					"project is unregistered/disabled; retrieval is disabled until re-registration",
				purged: "project is purged; retrieval is disabled",
			};

			return {
				query,
				project_id: projectId,
				project_lifecycle_status: project.lifecycle_status,
				searchable: false,
				tombstone_summary: { files, chunks, symbols },
				count: 0,
				task_lineage_context: null,
				task_context_resolution: {
					status:
						Object.keys(taskContextSelector).length > 0
							? "selector_not_resolved"
							: "not_requested",
					...(Object.keys(taskContextSelector).length > 0
						? {
								reason:
									reasonByLifecycle[project.lifecycle_status] ||
									"project lifecycle disables retrieval",
							}
						: {}),
					selector: taskContextSelector,
					recoverable: project.lifecycle_status !== "purged",
				},
				results: [],
				debug: input.debug
					? {
							query_intent: {
								looks_code_intent: false,
								looks_identifier_query: false,
								query_tokens: [],
							},
							candidate_counts: {
								file_index_state: 0,
								symbol_registry: 0,
								chunk_registry: 0,
								task_registry: 0,
							},
							top_candidates: {
								file_index_state: [],
								symbol_registry: [],
								chunk_registry: [],
								task_registry: [],
							},
						}
					: undefined,
			};
		}

		const limit = Math.min(Math.max(Number(input.limit || 10), 1), 50);
		const queryLc = query.toLowerCase();
		const queryTokens = Array.from(
			new Set(
				queryLc
					.split(/[^a-z0-9._/-]+/i)
					.map((t) => t.trim())
					.filter(Boolean),
			),
		);
		const tokenScore = (text: string): number => {
			if (!queryTokens.length) return 0;
			const hay = text.toLowerCase();
			let matched = 0;
			for (const token of queryTokens) {
				if (hay.includes(token)) matched += 1;
			}
			return matched / queryTokens.length;
		};
		const exactMatchScore = (candidate: string): number => {
			const value = String(candidate || "")
				.trim()
				.toLowerCase();
			if (!value) return 0;
			if (value === queryLc) return 1;
			if (value.endsWith(`.${queryLc}`)) return 0.92;
			if (
				value.includes(`/${queryLc}`) ||
				value.includes(`:${queryLc}`) ||
				value.includes(`#${queryLc}`)
			)
				return 0.78;
			return 0;
		};
		const codeIntentHints = [
			"function",
			"class",
			"method",
			"symbol",
			"route",
			"endpoint",
			"extractor",
			"registry",
			"chunk",
			"snippet",
			"code",
		];
		const looksCodeIntent =
			codeIntentHints.some((hint) => queryLc.includes(hint)) ||
			query.includes("/") ||
			query.includes("_");
		const looksIdentifierQuery =
			/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(query) ||
			/^[a-zA-Z_][a-zA-Z0-9_.#:-]*$/.test(query) ||
			query.includes("::") ||
			query.includes(".") ||
			query.includes("_");
		const taskContextInput = input.task_context;
		const taskContextSelector = {
			...(taskContextInput?.task_id
				? { task_id: String(taskContextInput.task_id).trim() }
				: {}),
			...(taskContextInput?.tracker_issue_key
				? {
						tracker_issue_key: String(
							taskContextInput.tracker_issue_key,
						).trim(),
					}
				: {}),
			...(taskContextInput?.task_title
				? { task_title: String(taskContextInput.task_title).trim() }
				: {}),
		};

		let lineageContext: ProjectTaskLineageContextResult | null = null;
		let taskContextResolution: ProjectHybridSearchTaskContextResolution = {
			status: "not_requested",
			selector: taskContextSelector,
			recoverable: false,
		};

		if (Object.keys(taskContextSelector).length > 0) {
			try {
				lineageContext = this.getTaskLineageContext(scopeUserId, scopeAgentId, {
					project_id: projectId,
					task_id: taskContextInput?.task_id,
					tracker_issue_key: taskContextInput?.tracker_issue_key,
					task_title: taskContextInput?.task_title,
					include_parent_chain: taskContextInput?.include_parent_chain,
					include_related: taskContextInput?.include_related,
				});
				taskContextResolution = {
					status: "resolved",
					selector: taskContextSelector,
					recoverable: false,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (
					!message.includes(
						"task lineage focus not found for provided selector",
					)
				) {
					throw error;
				}
				taskContextResolution = {
					status: "selector_not_resolved",
					reason: "task lineage focus not found for provided selector",
					selector: taskContextSelector,
					recoverable: true,
				};
			}
		}

		const lexicalPathPrefix = this.normalizeStringArray(input.path_prefix)
			.map((p) => this.normalizeRelativePath(p))
			.filter(Boolean);
		const lexicalModules = new Set(
			this.normalizeStringArray(input.module).map((s) => s.toLowerCase()),
		);
		const lexicalLanguages = new Set(
			this.normalizeStringArray(input.language).map((s) => s.toLowerCase()),
		);
		const lexicalTaskIds = new Set(this.normalizeStringArray(input.task_id));
		const lexicalIssueKeys = new Set(
			this.normalizeStringArray(input.tracker_issue_key).map((s) =>
				s.toUpperCase(),
			),
		);

		if (lineageContext) {
			lexicalTaskIds.add(lineageContext.focus.task_id);
			if (lineageContext.focus.tracker_issue_key)
				lexicalIssueKeys.add(
					lineageContext.focus.tracker_issue_key.toUpperCase(),
				);
			for (const t of [
				...lineageContext.parent_chain,
				...lineageContext.related_tasks,
			]) {
				lexicalTaskIds.add(t.task_id);
				if (t.tracker_issue_key)
					lexicalIssueKeys.add(t.tracker_issue_key.toUpperCase());
			}
		}

		const results: ProjectHybridSearchResultItem[] = [];

		const debugEnabled = input.debug === true;
		const debugBuckets = {
			file_index_state: [] as Array<Record<string, unknown>>,
			symbol_registry: [] as Array<Record<string, unknown>>,
			chunk_registry: [] as Array<Record<string, unknown>>,
			task_registry: [] as Array<Record<string, unknown>>,
		};
		const pushDebug = (
			bucket: keyof typeof debugBuckets,
			entry: Record<string, unknown>,
		) => {
			if (!debugEnabled) return;
			debugBuckets[bucket].push(entry);
		};

		const symbolRowsById = new Map<string, any>();

		const fileStmt = this.db.prepare(
			`SELECT * FROM file_index_state
       WHERE scope_user_id = ? AND scope_agent_id = ? AND project_id = ? AND active = 1`,
		);
		const fileRows = fileStmt.all(
			scopeUserId,
			scopeAgentId,
			projectId,
		) as any[];
		for (const row of fileRows) {
			const relativePath = String(row.relative_path || "");
			const moduleName = row.module ? String(row.module) : null;
			const language = row.language ? String(row.language) : null;

			if (
				lexicalPathPrefix.length > 0 &&
				!lexicalPathPrefix.some((prefix) => relativePath.startsWith(prefix))
			)
				continue;
			if (lexicalModules.size > 0 && !moduleName) continue;
			if (
				lexicalModules.size > 0 &&
				moduleName &&
				!lexicalModules.has(moduleName.toLowerCase())
			)
				continue;
			if (lexicalLanguages.size > 0 && !language) continue;
			if (
				lexicalLanguages.size > 0 &&
				language &&
				!lexicalLanguages.has(language.toLowerCase())
			)
				continue;

			const text =
				`${relativePath} ${moduleName || ""} ${language || ""}`.toLowerCase();
			let score = 0;
			if (text.includes(queryLc)) score += 0.55;
			score += tokenScore(text) * 0.25;
			if (lineageContext && lineageContext.touched_files.includes(relativePath))
				score += 0.35;
			if (looksCodeIntent) {
				if (
					relativePath.includes("/docs/") ||
					relativePath.startsWith("docs/") ||
					relativePath.includes("README")
				)
					score -= 0.18;
				if (
					relativePath.startsWith("src/") ||
					relativePath.startsWith("tests/")
				)
					score += 0.14;
			} else if (
				relativePath.includes("README") ||
				relativePath.includes("docs/")
			) {
				score += 0.05;
			}
			if (looksIdentifierQuery) {
				score -= 0.12;
			}
			if (score <= 0.08) continue;

			pushDebug("file_index_state", {
				relative_path: relativePath,
				score: Number(score.toFixed(4)),
				module: moduleName,
				language,
				text_exact: text.includes(queryLc),
				token_score: Number(tokenScore(text).toFixed(4)),
			});
			results.push({
				source: "file_index_state",
				id: String(row.file_id),
				score,
				project_id: projectId,
				relative_path: relativePath,
				module: moduleName,
				language,
				snippet: `file ${relativePath}${moduleName ? ` (module ${moduleName})` : ""}`,
			});
		}

		const symbolStmt = this.db.prepare(
			`SELECT * FROM symbol_registry
       WHERE scope_user_id = ? AND scope_agent_id = ? AND project_id = ? AND active = 1`,
		);
		const symbolRows = symbolStmt.all(
			scopeUserId,
			scopeAgentId,
			projectId,
		) as any[];
		for (const row of symbolRows) {
			const relativePath = String(row.relative_path || "");
			const moduleName = row.module ? String(row.module) : null;
			const language = row.language ? String(row.language) : null;
			const symbolName = String(row.symbol_name || "");
			const symbolKind = String(row.symbol_kind || "");
			const symbolFqn = String(row.symbol_fqn || "");
			symbolRowsById.set(String(row.symbol_id), row);

			if (
				lexicalPathPrefix.length > 0 &&
				!lexicalPathPrefix.some((prefix) => relativePath.startsWith(prefix))
			)
				continue;
			if (lexicalModules.size > 0 && !moduleName) continue;
			if (
				lexicalModules.size > 0 &&
				moduleName &&
				!lexicalModules.has(moduleName.toLowerCase())
			)
				continue;
			if (lexicalLanguages.size > 0 && !language) continue;
			if (
				lexicalLanguages.size > 0 &&
				language &&
				!lexicalLanguages.has(language.toLowerCase())
			)
				continue;

			const text =
				`${symbolName} ${symbolFqn} ${relativePath} ${moduleName || ""} ${symbolKind}`.toLowerCase();
			let score = 0;
			if (text.includes(queryLc)) score += 0.62;
			score += tokenScore(text) * 0.35;
			score += exactMatchScore(symbolName) * 1.35;
			score += exactMatchScore(symbolFqn) * 1.1;
			if (looksIdentifierQuery) {
				if (symbolName.toLowerCase() === queryLc) score += 1.8;
				else if (symbolFqn.toLowerCase() === queryLc) score += 1.5;
				else if (symbolFqn.toLowerCase().endsWith(`.${queryLc}`)) score += 1.1;
			}
			if (lineageContext && lineageContext.touched_symbols.includes(symbolName))
				score += 0.3;
			if (lineageContext && lineageContext.touched_files.includes(relativePath))
				score += 0.12;
			if (
				looksCodeIntent &&
				(relativePath.startsWith("src/") || relativePath.startsWith("tests/"))
			)
				score += 0.08;
			if (looksIdentifierQuery) score += 0.18;
			if (score <= 0.08) continue;

			pushDebug("symbol_registry", {
				relative_path: relativePath,
				symbol_name: symbolName,
				symbol_fqn: symbolFqn,
				symbol_kind: symbolKind,
				score: Number(score.toFixed(4)),
				exact_symbol: symbolName.toLowerCase() === queryLc,
				exact_fqn: symbolFqn.toLowerCase() === queryLc,
				suffix_fqn: symbolFqn.toLowerCase().endsWith(`.${queryLc}`),
				token_score: Number(tokenScore(text).toFixed(4)),
			});
			results.push({
				source: "symbol_registry",
				id: String(row.symbol_id),
				score,
				project_id: projectId,
				relative_path: relativePath,
				module: moduleName,
				language,
				symbol_name: symbolName,
				symbol_kind: symbolKind,
				snippet: `symbol ${symbolName} (${symbolKind}) in ${relativePath}`,
			});
		}

		const chunkStmt = this.db.prepare(
			`SELECT * FROM chunk_registry
       WHERE scope_user_id = ? AND scope_agent_id = ? AND project_id = ? AND active = 1`,
		);
		const chunkRows = chunkStmt.all(
			scopeUserId,
			scopeAgentId,
			projectId,
		) as any[];
		for (const row of chunkRows) {
			const relativePath = String(row.relative_path || "");
			const chunkKind = String(row.chunk_kind || "");
			const symbolId = row.symbol_id ? String(row.symbol_id) : null;
			const symbolRow = symbolId ? symbolRowsById.get(symbolId) : null;
			const symbolName = symbolRow ? String(symbolRow.symbol_name || "") : "";
			const symbolFqn = symbolRow ? String(symbolRow.symbol_fqn || "") : "";
			if (
				lexicalPathPrefix.length > 0 &&
				!lexicalPathPrefix.some((prefix) => relativePath.startsWith(prefix))
			)
				continue;
			const text =
				`${relativePath} ${chunkKind} ${symbolId || ""} ${symbolName} ${symbolFqn}`.toLowerCase();
			let score = 0;
			if (text.includes(queryLc)) score += 0.6;
			score += tokenScore(text) * 0.4;
			score += exactMatchScore(symbolName) * 0.9;
			score += exactMatchScore(symbolFqn) * 0.7;
			if (looksIdentifierQuery) {
				if (symbolName.toLowerCase() === queryLc) score += 1.0;
				else if (symbolFqn.toLowerCase() === queryLc) score += 0.85;
			}
			if (lineageContext && lineageContext.touched_files.includes(relativePath))
				score += 0.15;
			if (looksCodeIntent) {
				if (
					relativePath.includes("/docs/") ||
					relativePath.startsWith("docs/") ||
					relativePath.includes("README")
				)
					score -= 0.14;
				if (
					relativePath.startsWith("src/") ||
					relativePath.startsWith("tests/")
				)
					score += 0.1;
			}
			if (looksIdentifierQuery) score += 0.12;
			if (score <= 0.08) continue;
			pushDebug("chunk_registry", {
				relative_path: relativePath,
				chunk_kind: chunkKind,
				symbol_name: symbolName || null,
				symbol_fqn: symbolFqn || null,
				score: Number(score.toFixed(4)),
				exact_symbol: symbolName ? symbolName.toLowerCase() === queryLc : false,
				token_score: Number(tokenScore(text).toFixed(4)),
			});
			results.push({
				source: "chunk_registry",
				id: String(row.chunk_id),
				score,
				project_id: projectId,
				relative_path: relativePath,
				symbol_name: symbolName || undefined,
				snippet: symbolName
					? `chunk ${chunkKind} for symbol ${symbolName} in ${relativePath}`
					: `chunk ${chunkKind} in ${relativePath}`,
			});
		}

		const taskStmt = this.db.prepare(
			`SELECT * FROM task_registry
       WHERE scope_user_id = ? AND scope_agent_id = ? AND project_id = ?`,
		);
		const taskRows = taskStmt.all(
			scopeUserId,
			scopeAgentId,
			projectId,
		) as any[];
		for (const row of taskRows) {
			const task = this.rowToTaskRecord(row);
			const taskIssueKey = task.tracker_issue_key
				? task.tracker_issue_key.toUpperCase()
				: null;

			if (lexicalTaskIds.size > 0 && !lexicalTaskIds.has(task.task_id)) {
				if (!taskIssueKey || !lexicalIssueKeys.has(taskIssueKey)) {
					// keep if user query still lexically matches strongly
				}
			}

			const text = [
				task.task_id,
				task.task_title,
				task.task_status || "",
				task.tracker_issue_key || "",
				...(task.files_touched || []),
				...(task.symbols_touched || []),
				...(task.commit_refs || []),
				task.decision_notes || "",
			]
				.join(" ")
				.toLowerCase();

			let score = 0;
			if (text.includes(queryLc)) score += 0.58;
			score += tokenScore(text) * 0.25;
			if (lexicalTaskIds.has(task.task_id)) score += 0.28;
			if (taskIssueKey && lexicalIssueKeys.has(taskIssueKey)) score += 0.28;
			if (lineageContext) {
				if (task.task_id === lineageContext.focus.task_id) score += 0.35;
				if (lineageContext.parent_chain.some((t) => t.task_id === task.task_id))
					score += 0.2;
				if (
					lineageContext.related_tasks.some((t) => t.task_id === task.task_id)
				)
					score += 0.2;
			}
			if (score <= 0.08) continue;

			pushDebug("task_registry", {
				task_id: task.task_id,
				tracker_issue_key: task.tracker_issue_key,
				task_title: task.task_title,
				score: Number(score.toFixed(4)),
				token_score: Number(tokenScore(text).toFixed(4)),
			});
			results.push({
				source: "task_registry",
				id: task.task_id,
				score,
				project_id: projectId,
				task_id: task.task_id,
				task_title: task.task_title,
				tracker_issue_key: task.tracker_issue_key,
				snippet: `task ${task.task_id}: ${task.task_title}`,
			});
		}

		const ranked = results
			.sort((a, b) => b.score - a.score)
			.slice(0, limit)
			.map((item) => ({ ...item, score: Number(item.score.toFixed(4)) }));

		return {
			query,
			project_id: projectId,
			project_lifecycle_status: project.lifecycle_status,
			searchable: true,
			count: ranked.length,
			task_lineage_context: lineageContext,
			task_context_resolution: taskContextResolution,
			results: ranked,
			debug: debugEnabled
				? {
						query_intent: {
							looks_code_intent: looksCodeIntent,
							looks_identifier_query: looksIdentifierQuery,
							query_tokens: queryTokens,
						},
						candidate_counts: {
							file_index_state: debugBuckets.file_index_state.length,
							symbol_registry: debugBuckets.symbol_registry.length,
							chunk_registry: debugBuckets.chunk_registry.length,
							task_registry: debugBuckets.task_registry.length,
						},
						top_candidates: {
							file_index_state: debugBuckets.file_index_state
								.sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
								.slice(0, 8),
							symbol_registry: debugBuckets.symbol_registry
								.sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
								.slice(0, 8),
							chunk_registry: debugBuckets.chunk_registry
								.sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
								.slice(0, 8),
							task_registry: debugBuckets.task_registry
								.sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
								.slice(0, 8),
						},
					}
				: undefined,
		};
	}

	queryProjectChangeOverlay(
		scopeUserId: string,
		scopeAgentId: string,
		input: ProjectChangeOverlayQueryInput,
	): ProjectChangeOverlayResult {
		let lineage: ProjectTaskLineageContextResult | null = null;

		const taskIdSelector = String(input.task_id || "").trim();
		const trackerSelector = String(input.tracker_issue_key || "").trim();
		const taskTitleSelector = String(input.task_title || "").trim();
		const selector = {
			...(taskIdSelector ? { task_id: taskIdSelector } : {}),
			...(trackerSelector ? { tracker_issue_key: trackerSelector } : {}),
			...(taskTitleSelector ? { task_title: taskTitleSelector } : {}),
		};

		try {
			lineage = this.getTaskLineageContext(scopeUserId, scopeAgentId, {
				project_id: input.project_id,
				task_id: input.task_id,
				tracker_issue_key: input.tracker_issue_key,
				task_title: input.task_title,
				include_related: input.include_related,
				include_parent_chain: input.include_parent_chain,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (
				!message.includes("task lineage focus not found for provided selector")
			) {
				throw error;
			}

			const unresolvedTaskId =
				taskIdSelector ||
				`unresolved:${trackerSelector || taskTitleSelector || "selector"}`;
			const unresolvedTitle =
				taskTitleSelector || "Unresolved task lineage selector";

			return {
				status: "selector_not_resolved",
				reason: "task lineage focus not found for provided selector",
				selector,
				recoverable: true,
				project_id: input.project_id,
				focus: {
					task_id: unresolvedTaskId,
					task_title: unresolvedTitle,
					tracker_issue_key: trackerSelector || null,
				},
				changed_files: [],
				related_symbols: [],
				commit_refs: [],
			};
		}

		const rawTouchedFiles = this.uniqueSorted(
			(lineage.touched_files || [])
				.map((p) => this.normalizeRelativePath(p))
				.filter(Boolean),
		);

		const activeFileStmt = this.db.prepare(
			`SELECT relative_path
         FROM file_index_state
         WHERE scope_user_id = ? AND scope_agent_id = ? AND project_id = ? AND active = 1`,
		);
		const activeProjectFiles = new Set(
			(activeFileStmt.all(
				scopeUserId,
				scopeAgentId,
				input.project_id,
			) as Array<{ relative_path: string | null }>)
				.map((row) => String(row.relative_path || "").trim())
				.filter(Boolean),
		);

		const changedFiles =
			activeProjectFiles.size > 0
				? rawTouchedFiles.filter((relativePath) =>
						activeProjectFiles.has(relativePath),
					)
				: rawTouchedFiles;

		const relatedSymbolsMap = new Map<string, ProjectChangeOverlaySymbol>();
		const rawTouchedSymbols = this.uniqueSorted(
			(lineage.touched_symbols || [])
				.map((symbolName) => String(symbolName || "").trim())
				.filter(Boolean),
		);

		if (rawTouchedSymbols.length > 0) {
			const placeholders = rawTouchedSymbols.map(() => "?").join(",");
			const taskSymbolStmt = this.db.prepare(
				`SELECT symbol_name, symbol_kind, symbol_fqn, relative_path
         FROM symbol_registry
         WHERE scope_user_id = ? AND scope_agent_id = ? AND project_id = ? AND active = 1
           AND (symbol_name IN (${placeholders}) OR symbol_fqn IN (${placeholders}))
         ORDER BY indexed_at DESC, symbol_name ASC`,
			);
			const rows = taskSymbolStmt.all(
				scopeUserId,
				scopeAgentId,
				input.project_id,
				...rawTouchedSymbols,
				...rawTouchedSymbols,
			) as Array<{
				symbol_name: string;
				symbol_kind: string | null;
				symbol_fqn: string | null;
				relative_path: string | null;
			}>;

			for (const row of rows) {
				const symbolName = String(row.symbol_name || "").trim();
				if (!symbolName) continue;
				const relPath = row.relative_path
					? String(row.relative_path)
					: undefined;
				const symbolFqn = row.symbol_fqn ? String(row.symbol_fqn) : undefined;
				const key = `task_registry:${symbolName}:${symbolFqn || ""}:${relPath || ""}`;
				if (!relatedSymbolsMap.has(key)) {
					relatedSymbolsMap.set(key, {
						symbol_name: symbolName,
						symbol_kind: row.symbol_kind ? String(row.symbol_kind) : undefined,
						symbol_fqn: symbolFqn,
						relative_path: relPath,
						source: "task_registry",
					});
				}
			}

			for (const symbolName of rawTouchedSymbols) {
				const hasRegistryMatch = rows.some((row) => {
					const rowName = String(row.symbol_name || "").trim();
					const rowFqn = String(row.symbol_fqn || "").trim();
					return rowName === symbolName || rowFqn === symbolName;
				});
				if (hasRegistryMatch) continue;
				const key = `task_registry:${symbolName}`;
				if (!relatedSymbolsMap.has(key)) {
					relatedSymbolsMap.set(key, {
						symbol_name: symbolName,
						source: "task_registry",
					});
				}
			}
		}

		if (changedFiles.length > 0) {
			const placeholders = changedFiles.map(() => "?").join(",");
			const stmt = this.db.prepare(
				`SELECT symbol_name, symbol_kind, symbol_fqn, relative_path
         FROM symbol_registry
         WHERE scope_user_id = ? AND scope_agent_id = ? AND project_id = ? AND active = 1
           AND relative_path IN (${placeholders})
         ORDER BY indexed_at DESC, symbol_name ASC`,
			);
			const rows = stmt.all(
				scopeUserId,
				scopeAgentId,
				input.project_id,
				...changedFiles,
			) as Array<{
				symbol_name: string;
				symbol_kind: string | null;
				symbol_fqn: string | null;
				relative_path: string | null;
			}>;

			for (const row of rows) {
				const symbolName = String(row.symbol_name || "").trim();
				if (!symbolName) continue;
				const relPath = row.relative_path
					? String(row.relative_path)
					: undefined;
				const symbolFqn = row.symbol_fqn ? String(row.symbol_fqn) : undefined;
				const key = `symbol_registry:${symbolName}:${symbolFqn || ""}:${relPath || ""}`;
				if (!relatedSymbolsMap.has(key)) {
					relatedSymbolsMap.set(key, {
						symbol_name: symbolName,
						symbol_kind: row.symbol_kind ? String(row.symbol_kind) : undefined,
						symbol_fqn: symbolFqn,
						relative_path: relPath,
						source: "symbol_registry",
					});
				}
			}
		}

		return {
			status: "ok",
			selector,
			recoverable: false,
			project_id: input.project_id,
			focus: lineage.focus,
			changed_files: changedFiles,
			related_symbols: Array.from(relatedSymbolsMap.values()),
			commit_refs: this.uniqueSorted(lineage.commit_refs || []),
		};
	}

	getProjectFeaturePackProjectOnboardingIndexingSnapshot(
		scopeUserId: string,
		scopeAgentId: string,
		projectId: string,
	): ProjectFeaturePackProjectOnboardingIndexingSnapshot {
		const project = this.getProjectById(scopeUserId, scopeAgentId, projectId);
		if (!project) {
			throw new Error(`project_id '${projectId}' is not registered`);
		}

		const aliases =
			this.listProjects(scopeUserId, scopeAgentId).find(
				(row) => row.project.project_id === projectId,
			)?.aliases || [];

		const registration = this.getProjectRegistrationState(
			scopeUserId,
			scopeAgentId,
			projectId,
		);

		const trackerStmt = this.db.prepare(
			`SELECT * FROM project_tracker_mappings
       WHERE scope_user_id = ? AND scope_agent_id = ? AND project_id = ?
       ORDER BY updated_at DESC`,
		);
		const trackerMappings = (
			trackerStmt.all(scopeUserId, scopeAgentId, projectId) as Array<any>
		).map((row) => ({
			id: String(row.id),
			project_id: String(row.project_id),
			scope_user_id: String(row.scope_user_id),
			scope_agent_id: String(row.scope_agent_id),
			tracker_type: String(row.tracker_type) as "jira" | "github" | "other",
			tracker_space_key: row.tracker_space_key
				? String(row.tracker_space_key)
				: null,
			tracker_project_id: row.tracker_project_id
				? String(row.tracker_project_id)
				: null,
			default_epic_key: row.default_epic_key
				? String(row.default_epic_key)
				: null,
			board_key: row.board_key ? String(row.board_key) : null,
			active_version: row.active_version ? String(row.active_version) : null,
			external_project_url: row.external_project_url
				? String(row.external_project_url)
				: null,
			created_at: String(row.created_at),
			updated_at: String(row.updated_at),
		}));

		const activeFileStmt = this.db.prepare(
			`SELECT relative_path
       FROM file_index_state
       WHERE scope_user_id = ? AND scope_agent_id = ? AND project_id = ? AND active = 1
       ORDER BY relative_path ASC`,
		);
		const activeFilePaths = Array.from(
			new Set(
				(
					activeFileStmt.all(
						scopeUserId,
						scopeAgentId,
						projectId,
					) as Array<{ relative_path: string | null }>
				)
					.map((row) => String(row.relative_path || "").trim())
					.filter(Boolean),
			),
		);

		const fileStmt = this.db.prepare(
			`SELECT relative_path, module, language
       FROM file_index_state
       WHERE scope_user_id = ? AND scope_agent_id = ? AND project_id = ? AND active = 1
       ORDER BY indexed_at DESC, relative_path ASC
       LIMIT 12`,
		);
		const recentFiles = (
			fileStmt.all(scopeUserId, scopeAgentId, projectId) as Array<any>
		).map((row) => ({
			relative_path: String(row.relative_path),
			module: row.module ? String(row.module) : null,
			language: row.language ? String(row.language) : null,
		}));

		const symbolStmt = this.db.prepare(
			`SELECT symbol_name, symbol_kind, symbol_fqn, relative_path
       FROM symbol_registry
       WHERE scope_user_id = ? AND scope_agent_id = ? AND project_id = ? AND active = 1
       ORDER BY indexed_at DESC, symbol_name ASC
       LIMIT 16`,
		);
		const recentSymbols = (
			symbolStmt.all(scopeUserId, scopeAgentId, projectId) as Array<any>
		).map((row) => ({
			symbol_name: String(row.symbol_name),
			symbol_kind: String(row.symbol_kind),
			symbol_fqn: String(row.symbol_fqn),
			relative_path: String(row.relative_path),
		}));

		const taskStmt = this.db.prepare(
			`SELECT task_id, task_title, tracker_issue_key, task_status
       FROM task_registry
       WHERE scope_user_id = ? AND scope_agent_id = ? AND project_id = ?
       ORDER BY updated_at DESC
       LIMIT 12`,
		);
		const recentTasks = (
			taskStmt.all(scopeUserId, scopeAgentId, projectId) as Array<any>
		).map((row) => ({
			task_id: String(row.task_id),
			task_title: String(row.task_title),
			tracker_issue_key: row.tracker_issue_key
				? String(row.tracker_issue_key)
				: null,
			task_status: row.task_status ? String(row.task_status) : null,
		}));

		const runStmt = this.db.prepare(
			`SELECT run_id, trigger_type, state, started_at, finished_at
       FROM index_runs
       WHERE scope_user_id = ? AND scope_agent_id = ? AND project_id = ?
       ORDER BY started_at DESC
       LIMIT 8`,
		);
		const recentIndexRuns = (
			runStmt.all(scopeUserId, scopeAgentId, projectId) as Array<any>
		).map((row) => ({
			run_id: String(row.run_id),
			trigger_type: String(row.trigger_type),
			state: String(row.state),
			started_at: String(row.started_at),
			finished_at: row.finished_at ? String(row.finished_at) : null,
		}));

		return {
			project,
			aliases,
			registration,
			tracker_mappings: trackerMappings,
			active_file_paths: activeFilePaths,
			recent_files: recentFiles,
			recent_symbols: recentSymbols,
			recent_tasks: recentTasks,
			recent_index_runs: recentIndexRuns,
		};
	}

	runLegacyCompatibilityBackfill(
		scopeUserId: string,
		scopeAgentId: string,
		input: ProjectLegacyBackfillInput = {},
	): ProjectLegacyBackfillResult {
		const mode = input.mode || "dry_run";
		const source = input.source || "mixed";
		const now = new Date().toISOString();

		const onlyProjectIds = new Set(
			this.normalizeStringArray(input.only_project_ids),
		);
		const onlyAliases = new Set(
			this.normalizeStringArray(input.only_aliases).map((a) =>
				this.normalizeProjectAlias(a),
			),
		);

		const projects = this.listProjects(scopeUserId, scopeAgentId);
		const selected = projects.filter((row) => {
			if (
				onlyProjectIds.size > 0 &&
				!onlyProjectIds.has(row.project.project_id)
			)
				return false;
			if (onlyAliases.size > 0) {
				const aliases = row.aliases.map((a) =>
					this.normalizeProjectAlias(a.project_alias),
				);
				if (!aliases.some((a) => onlyAliases.has(a))) return false;
			}
			return true;
		});

		let updatedAliases = 0;
		let updatedMappings = 0;
		let updatedRegistrations = 0;
		let migrationStateUpserts = 0;

		const items: ProjectLegacyBackfillItem[] = [];

		for (const row of selected) {
			const project = row.project;
			const warnings: string[] = [];
			const actions: string[] = [];

			const existingAliases = new Set(
				row.aliases
					.map((a) => this.normalizeProjectAlias(a.project_alias))
					.filter(Boolean),
			);

			const inferredAliases = this.inferBackfillAliases(
				project,
				existingAliases,
				source,
			);
			const inferredMappings = this.inferBackfillTrackerMappings(
				scopeUserId,
				scopeAgentId,
				project.project_id,
				project,
				source,
			);

			if (mode === "apply") {
				for (const alias of inferredAliases) {
					if (existingAliases.has(alias)) continue;
					this.upsertProjectAlias(
						scopeUserId,
						scopeAgentId,
						project.project_id,
						alias,
						false,
						now,
						false,
					);
					existingAliases.add(alias);
					updatedAliases += 1;
					actions.push(`alias.backfilled:${alias}`);
				}

				for (const mapping of inferredMappings) {
					const existing = this.getProjectTrackerMapping(
						scopeUserId,
						scopeAgentId,
						project.project_id,
						mapping.tracker_type,
					);
					if (
						existing &&
						existing.tracker_space_key === mapping.tracker_space_key &&
						existing.default_epic_key === mapping.default_epic_key &&
						existing.tracker_project_id === mapping.tracker_project_id
					) {
						continue;
					}

					this.setProjectTrackerMapping(scopeUserId, scopeAgentId, {
						project_id: project.project_id,
						tracker_type: mapping.tracker_type,
						tracker_space_key: mapping.tracker_space_key || undefined,
						tracker_project_id: mapping.tracker_project_id || undefined,
						default_epic_key: mapping.default_epic_key || undefined,
					});
					updatedMappings += 1;
					actions.push(`tracker.backfilled:${mapping.tracker_type}`);
				}
			}

			const primaryAlias = this.pickPrimaryAlias(existingAliases, project);
			const completeness = this.computeRegistrationCompleteness(
				project,
				primaryAlias,
			);
			const missingFields = this.computeMissingRegistrationFields(
				project,
				primaryAlias,
			);
			const hasTracker =
				inferredMappings.length > 0 ||
				Boolean(
					this.getProjectTrackerMapping(
						scopeUserId,
						scopeAgentId,
						project.project_id,
						"jira",
					),
				);
			const status: "registered" | "validated" =
				hasTracker && completeness >= 90 ? "validated" : "registered";
			const validationStatus: "ok" | "warn" =
				missingFields.length === 0 ? "ok" : "warn";

			const existingRegistration = this.getProjectRegistrationState(
				scopeUserId,
				scopeAgentId,
				project.project_id,
			);
			const shouldUpdateRegistration =
				!existingRegistration ||
				input.force_registration_state === true ||
				existingRegistration.registration_status === "draft" ||
				existingRegistration.validation_status !== validationStatus;

			if (shouldUpdateRegistration) {
				if (mode === "apply") {
					this.upsertProjectRegistrationState(scopeUserId, scopeAgentId, {
						project_id: project.project_id,
						registration_status: status,
						validation_status: validationStatus,
						validation_notes: `legacy_backfill:${source}`,
						completeness_score: completeness,
						missing_required_fields: missingFields,
						last_validated_at: now,
					});
					updatedRegistrations += 1;
					actions.push("registration.backfilled");
				}
			}

			if (mode === "apply") {
				this.upsertMigrationState(scopeUserId, scopeAgentId, {
					migration_id: `legacy-backfill:${project.project_id}`,
					schema_from: "legacy",
					schema_to: "5.1",
					applied_at: now,
					status: "migrated",
					notes: JSON.stringify({
						source,
						alias_count: inferredAliases.length,
						tracker_count: inferredMappings.length,
					}),
				});
				migrationStateUpserts += 1;
			}

			if (inferredAliases.length === 0) {
				warnings.push("no additional alias inferred");
			}
			if (inferredMappings.length === 0) {
				warnings.push("no tracker mapping inferred");
			}

			items.push({
				project_id: project.project_id,
				project_name: project.project_name,
				inferred_aliases: inferredAliases,
				inferred_tracker_mappings: inferredMappings,
				actions,
				warnings,
			});
		}

		return {
			mode,
			source,
			scanned_projects: projects.length,
			candidates: selected.length,
			updated_aliases: updatedAliases,
			updated_tracker_mappings: updatedMappings,
			updated_registration_states: updatedRegistrations,
			migration_state_upserts: migrationStateUpserts,
			items,
		};
	}

	// --------------------------------------------------------------------------
	// Helpers
	// --------------------------------------------------------------------------

	private normalizeProjectAlias(alias: string | undefined): string {
		return String(alias || "")
			.trim()
			.toLowerCase()
			.replace(/\s+/g, "-")
			.replace(/[^a-z0-9._-]+/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "");
	}

	private normalizeRelativePath(pathInput: string | undefined): string {
		const normalized = String(pathInput || "")
			.trim()
			.replace(/\\/g, "/")
			.replace(/^\.\//, "")
			.replace(/\/+/g, "/");
		return normalized;
	}

	private makeScopedId(projectId: string, relativePath: string): string {
		return `${projectId}::${relativePath}`;
	}

	private parseChecksumMap(
		raw: string | null | undefined,
	): Record<string, string> {
		if (!raw) return {};
		try {
			const parsed = JSON.parse(raw);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
				return {};
			const out: Record<string, string> = {};
			for (const [key, value] of Object.entries(
				parsed as Record<string, unknown>,
			)) {
				if (typeof key === "string" && typeof value === "string") {
					out[key] = value;
				}
			}
			return out;
		} catch {
			return {};
		}
	}

	private insertIndexRun(
		scopeUserId: string,
		scopeAgentId: string,
		input: {
			run_id: string;
			project_id: string;
			index_profile: string;
			trigger_type: string;
			state: string;
			started_at: string;
			finished_at: string | null;
			error_message: string | null;
		},
	): void {
		const stmt = this.db.prepare(
			`INSERT INTO index_runs (
        run_id, scope_user_id, scope_agent_id, project_id, index_profile, trigger_type, state, started_at, finished_at, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);

		stmt.run(
			input.run_id,
			scopeUserId,
			scopeAgentId,
			input.project_id,
			input.index_profile,
			input.trigger_type,
			input.state,
			input.started_at,
			input.finished_at,
			input.error_message,
		);
	}

	private finishIndexRun(
		scopeUserId: string,
		scopeAgentId: string,
		runId: string,
		state: "indexed" | "error",
		errorMessage: string | null,
		finishedAt: string,
	): void {
		const stmt = this.db.prepare(
			`UPDATE index_runs
       SET state = ?, finished_at = ?, error_message = ?
       WHERE scope_user_id = ? AND scope_agent_id = ? AND run_id = ?`,
		);
		stmt.run(state, finishedAt, errorMessage, scopeUserId, scopeAgentId, runId);
	}

	private upsertFileIndexState(
		scopeUserId: string,
		scopeAgentId: string,
		input: {
			file_id: string;
			project_id: string;
			relative_path: string;
			module: string | null;
			language: string | null;
			checksum: string;
			last_commit_sha: string | null;
			index_state: string;
			active: number;
			tombstone_at: string | null;
			indexed_at: string | null;
		},
	): void {
		const existingStmt = this.db.prepare(
			`SELECT file_id FROM file_index_state
       WHERE scope_user_id = ? AND scope_agent_id = ? AND project_id = ? AND relative_path = ?`,
		);
		const existing = existingStmt.get(
			scopeUserId,
			scopeAgentId,
			input.project_id,
			input.relative_path,
		) as { file_id: string } | undefined;

		if (existing) {
			const updateStmt = this.db.prepare(
				`UPDATE file_index_state
         SET module = ?, language = ?, checksum = ?, last_commit_sha = ?, index_state = ?, active = ?, tombstone_at = ?, indexed_at = ?
         WHERE scope_user_id = ? AND scope_agent_id = ? AND file_id = ?`,
			);
			updateStmt.run(
				input.module,
				input.language,
				input.checksum,
				input.last_commit_sha,
				input.index_state,
				input.active,
				input.tombstone_at,
				input.indexed_at,
				scopeUserId,
				scopeAgentId,
				existing.file_id,
			);
			return;
		}

		const insertStmt = this.db.prepare(
			`INSERT INTO file_index_state (
        file_id, scope_user_id, scope_agent_id, project_id, relative_path, module, language,
        checksum, last_commit_sha, index_state, active, tombstone_at, indexed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);

		insertStmt.run(
			input.file_id,
			scopeUserId,
			scopeAgentId,
			input.project_id,
			input.relative_path,
			input.module,
			input.language,
			input.checksum,
			input.last_commit_sha,
			input.index_state,
			input.active,
			input.tombstone_at,
			input.indexed_at,
		);
	}

	private markFileIndexStateDeleted(
		scopeUserId: string,
		scopeAgentId: string,
		projectId: string,
		relativePath: string,
		tombstoneAt: string,
	): void {
		const stmt = this.db.prepare(
			`UPDATE file_index_state
       SET index_state = 'stale', active = 0, tombstone_at = ?, indexed_at = ?
       WHERE scope_user_id = ? AND scope_agent_id = ? AND project_id = ? AND relative_path = ?`,
		);
		stmt.run(
			tombstoneAt,
			tombstoneAt,
			scopeUserId,
			scopeAgentId,
			projectId,
			relativePath,
		);
	}

	private upsertChunkRegistry(
		scopeUserId: string,
		scopeAgentId: string,
		input: ProjectChunkUpsertInput,
	): void {
		const existing = this.db
			.prepare(
				`SELECT chunk_id FROM chunk_registry WHERE scope_user_id = ? AND scope_agent_id = ? AND chunk_id = ?`,
			)
			.get(scopeUserId, scopeAgentId, input.chunk_id) as
			| { chunk_id: string }
			| undefined;

		if (existing) {
			this.db
				.prepare(
					`UPDATE chunk_registry
         SET project_id = ?, file_id = ?, relative_path = ?, chunk_kind = ?, symbol_id = ?, task_id = ?, checksum = ?, qdrant_point_id = ?, index_state = ?, active = ?, tombstone_at = ?, indexed_at = ?
         WHERE scope_user_id = ? AND scope_agent_id = ? AND chunk_id = ?`,
				)
				.run(
					input.project_id,
					input.file_id,
					input.relative_path,
					input.chunk_kind,
					input.symbol_id,
					input.task_id || null,
					input.checksum,
					input.qdrant_point_id || null,
					input.index_state,
					input.active,
					input.tombstone_at,
					input.indexed_at,
					scopeUserId,
					scopeAgentId,
					input.chunk_id,
				);
			return;
		}

		this.db
			.prepare(
				`INSERT INTO chunk_registry (
        chunk_id, scope_user_id, scope_agent_id, project_id, file_id, relative_path, chunk_kind, symbol_id, task_id, checksum, qdrant_point_id, index_state, active, tombstone_at, indexed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				input.chunk_id,
				scopeUserId,
				scopeAgentId,
				input.project_id,
				input.file_id,
				input.relative_path,
				input.chunk_kind,
				input.symbol_id,
				input.task_id || null,
				input.checksum,
				input.qdrant_point_id || null,
				input.index_state,
				input.active,
				input.tombstone_at,
				input.indexed_at,
			);
	}

	private upsertSymbolRegistry(
		scopeUserId: string,
		scopeAgentId: string,
		input: ProjectSymbolUpsertInput,
	): void {
		const existing = this.db
			.prepare(
				`SELECT symbol_id FROM symbol_registry WHERE scope_user_id = ? AND scope_agent_id = ? AND symbol_id = ?`,
			)
			.get(scopeUserId, scopeAgentId, input.symbol_id) as
			| { symbol_id: string }
			| undefined;

		if (existing) {
			this.db
				.prepare(
					`UPDATE symbol_registry
         SET project_id = ?, relative_path = ?, module = ?, language = ?, symbol_name = ?, symbol_fqn = ?, symbol_kind = ?, signature_hash = ?, index_state = ?, active = ?, tombstone_at = ?, indexed_at = ?
         WHERE scope_user_id = ? AND scope_agent_id = ? AND symbol_id = ?`,
				)
				.run(
					input.project_id,
					input.relative_path,
					input.module,
					input.language,
					input.symbol_name,
					input.symbol_fqn,
					input.symbol_kind,
					input.signature_hash || null,
					input.index_state,
					input.active,
					input.tombstone_at,
					input.indexed_at,
					scopeUserId,
					scopeAgentId,
					input.symbol_id,
				);
			return;
		}

		this.db
			.prepare(
				`INSERT INTO symbol_registry (
        symbol_id, scope_user_id, scope_agent_id, project_id, relative_path, module, language, symbol_name, symbol_fqn, symbol_kind, signature_hash, index_state, active, tombstone_at, indexed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				input.symbol_id,
				scopeUserId,
				scopeAgentId,
				input.project_id,
				input.relative_path,
				input.module,
				input.language,
				input.symbol_name,
				input.symbol_fqn,
				input.symbol_kind,
				input.signature_hash || null,
				input.index_state,
				input.active,
				input.tombstone_at,
				input.indexed_at,
			);
	}

	private markProjectChunksByFileDeleted(
		scopeUserId: string,
		scopeAgentId: string,
		projectId: string,
		relativePath: string,
		tombstoneAt: string,
	): void {
		this.db
			.prepare(
				`UPDATE chunk_registry
       SET index_state = 'stale', active = 0, tombstone_at = ?, indexed_at = ?
       WHERE scope_user_id = ? AND scope_agent_id = ? AND project_id = ? AND relative_path = ?`,
			)
			.run(
				tombstoneAt,
				tombstoneAt,
				scopeUserId,
				scopeAgentId,
				projectId,
				relativePath,
			);
	}

	private markProjectSymbolsByFileDeleted(
		scopeUserId: string,
		scopeAgentId: string,
		projectId: string,
		relativePath: string,
		tombstoneAt: string,
	): void {
		this.db
			.prepare(
				`UPDATE symbol_registry
       SET index_state = 'stale', active = 0, tombstone_at = ?, indexed_at = ?
       WHERE scope_user_id = ? AND scope_agent_id = ? AND project_id = ? AND relative_path = ?`,
			)
			.run(
				tombstoneAt,
				tombstoneAt,
				scopeUserId,
				scopeAgentId,
				projectId,
				relativePath,
			);
	}

	markProjectFileDeletedForEvent(
		scopeUserId: string,
		scopeAgentId: string,
		projectId: string,
		relativePath: string,
		tombstoneAt: string,
	): void {
		this.markFileIndexStateDeleted(
			scopeUserId,
			scopeAgentId,
			projectId,
			relativePath,
			tombstoneAt,
		);
		this.markProjectChunksByFileDeleted(
			scopeUserId,
			scopeAgentId,
			projectId,
			relativePath,
			tombstoneAt,
		);
		this.markProjectSymbolsByFileDeleted(
			scopeUserId,
			scopeAgentId,
			projectId,
			relativePath,
			tombstoneAt,
		);
	}

	private upsertProjectIndexWatchState(
		scopeUserId: string,
		scopeAgentId: string,
		input: {
			project_id: string;
			last_source_rev: string | null;
			last_checksum_snapshot: Record<string, string>;
			updated_at: string;
		},
	): void {
		const existing = this.getProjectIndexWatchState(
			scopeUserId,
			scopeAgentId,
			input.project_id,
		);
		const checksumJson = JSON.stringify(input.last_checksum_snapshot || {});

		if (existing) {
			const stmt = this.db.prepare(
				`UPDATE project_index_watch_state
         SET last_source_rev = ?, last_checksum_snapshot = ?, updated_at = ?
         WHERE scope_user_id = ? AND scope_agent_id = ? AND project_id = ?`,
			);
			stmt.run(
				input.last_source_rev,
				checksumJson,
				input.updated_at,
				scopeUserId,
				scopeAgentId,
				input.project_id,
			);
			return;
		}

		const stmt = this.db.prepare(
			`INSERT INTO project_index_watch_state (
        project_id, scope_user_id, scope_agent_id, last_source_rev, last_checksum_snapshot, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
		);
		stmt.run(
			input.project_id,
			scopeUserId,
			scopeAgentId,
			input.last_source_rev,
			checksumJson,
			input.updated_at,
		);
	}

	private normalizeProjectId(projectId?: string): string {
		return String(projectId || "").trim();
	}

	private normalizeProjectName(projectName?: string): string {
		return String(projectName || "").trim();
	}

	private normalizeRepoRoot(repoRoot?: string): string | null {
		const normalized = String(repoRoot || "").trim();
		return normalized || null;
	}

	private normalizeRepoRemote(repoRemote?: string): string | null {
		const normalized = String(repoRemote || "").trim();
		return normalized || null;
	}

	private parseJsonArrayField(raw: string | null | undefined): string[] {
		if (!raw) return [];
		try {
			const parsed = JSON.parse(raw);
			return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
		} catch {
			return [];
		}
	}

	private normalizeStringArray(input?: string[] | null): string[] {
		if (!Array.isArray(input)) return [];
		return this.uniqueSorted(
			input.map((item) => String(item || "").trim()).filter(Boolean),
		);
	}

	private uniqueSorted(values: string[]): string[] {
		return Array.from(
			new Set(values.map((v) => String(v || "").trim()).filter(Boolean)),
		).sort((a, b) => a.localeCompare(b));
	}

	private inferBackfillAliases(
		project: ProjectRecord,
		existingAliases: Set<string>,
		source: "repo_root" | "repo_remote" | "task_registry" | "mixed",
	): string[] {
		const candidates = new Set<string>();

		if (source === "repo_root" || source === "mixed") {
			if (project.repo_root) {
				const parts = project.repo_root
					.replace(/\\/g, "/")
					.split("/")
					.filter(Boolean);
				const leaf = parts[parts.length - 1] || "";
				const normalized = this.normalizeProjectAlias(leaf);
				if (normalized) candidates.add(normalized);
			}
		}

		if (source === "repo_remote" || source === "mixed") {
			if (project.repo_remote_primary) {
				const remote = String(project.repo_remote_primary);
				const m =
					remote.match(/[:/]([^/]+?)\.git$/i) || remote.match(/[:/]([^/]+?)$/i);
				const repoName = m?.[1] || "";
				const normalized = this.normalizeProjectAlias(repoName);
				if (normalized) candidates.add(normalized);
			}
		}

		const filtered = Array.from(candidates).filter(
			(a) => !existingAliases.has(a),
		);
		return filtered.sort((a, b) => a.localeCompare(b));
	}

	private inferBackfillTrackerMappings(
		scopeUserId: string,
		scopeAgentId: string,
		projectId: string,
		project: ProjectRecord,
		source: "repo_root" | "repo_remote" | "task_registry" | "mixed",
	): Array<{
		tracker_type: "jira" | "github" | "other";
		tracker_space_key: string | null;
		tracker_project_id: string | null;
		default_epic_key: string | null;
		confidence: number;
		source: "repo_remote" | "task_registry";
	}> {
		const result: Array<{
			tracker_type: "jira" | "github" | "other";
			tracker_space_key: string | null;
			tracker_project_id: string | null;
			default_epic_key: string | null;
			confidence: number;
			source: "repo_remote" | "task_registry";
		}> = [];

		if (source === "repo_remote" || source === "mixed") {
			const remote = String(project.repo_remote_primary || "").trim();
			if (remote.includes("github.com")) {
				result.push({
					tracker_type: "github",
					tracker_space_key: null,
					tracker_project_id: null,
					default_epic_key: null,
					confidence: 0.7,
					source: "repo_remote",
				});
			}
		}

		if (source === "task_registry" || source === "mixed") {
			const stmt = this.db.prepare(
				`SELECT tracker_issue_key FROM task_registry
         WHERE scope_user_id = ? AND scope_agent_id = ? AND project_id = ? AND tracker_issue_key IS NOT NULL AND tracker_issue_key != ''
         ORDER BY updated_at DESC LIMIT 200`,
			);
			const rows = stmt.all(scopeUserId, scopeAgentId, projectId) as Array<{
				tracker_issue_key: string | null;
			}>;
			const keys = rows
				.map((r) => String(r.tracker_issue_key || "").trim())
				.filter(Boolean);
			const jiraLike = keys
				.map((key) => key.match(/^([A-Z][A-Z0-9_]+)-\d+$/)?.[1] || null)
				.filter((x): x is string => Boolean(x));
			if (jiraLike.length > 0) {
				const counts = new Map<string, number>();
				for (const p of jiraLike) counts.set(p, (counts.get(p) || 0) + 1);
				const top = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0];
				if (top) {
					result.push({
						tracker_type: "jira",
						tracker_space_key: top[0],
						tracker_project_id: null,
						default_epic_key: `${top[0]}-1`,
						confidence: Math.min(0.95, 0.55 + top[1] * 0.03),
						source: "task_registry",
					});
				}
			}
		}

		const dedup = new Map<string, (typeof result)[number]>();
		for (const item of result) {
			const key = `${item.tracker_type}:${item.tracker_space_key || ""}:${item.default_epic_key || ""}`;
			const prev = dedup.get(key);
			if (!prev || item.confidence > prev.confidence) dedup.set(key, item);
		}

		return Array.from(dedup.values()).sort(
			(a, b) => b.confidence - a.confidence,
		);
	}

	private pickPrimaryAlias(
		existingAliases: Set<string>,
		project: ProjectRecord,
	): string {
		const aliases = Array.from(existingAliases)
			.filter(Boolean)
			.sort((a, b) => a.localeCompare(b));
		if (aliases.length > 0) return aliases[0];

		const fromName = this.normalizeProjectAlias(project.project_name);
		if (fromName) return fromName;

		return this.normalizeProjectAlias(project.project_id) || "project";
	}

	private upsertMigrationState(
		scopeUserId: string,
		scopeAgentId: string,
		input: {
			migration_id: string;
			schema_from: string;
			schema_to: string;
			applied_at: string;
			status: string;
			notes?: string | null;
		},
	): void {
		const existingStmt = this.db.prepare(
			`SELECT migration_id FROM migration_state
       WHERE scope_user_id = ? AND scope_agent_id = ? AND migration_id = ?`,
		);
		const existing = existingStmt.get(
			scopeUserId,
			scopeAgentId,
			input.migration_id,
		) as { migration_id: string } | undefined;

		if (existing) {
			const updateStmt = this.db.prepare(
				`UPDATE migration_state
         SET schema_from = ?, schema_to = ?, applied_at = ?, status = ?, notes = ?
         WHERE scope_user_id = ? AND scope_agent_id = ? AND migration_id = ?`,
			);
			updateStmt.run(
				input.schema_from,
				input.schema_to,
				input.applied_at,
				input.status,
				input.notes || null,
				scopeUserId,
				scopeAgentId,
				input.migration_id,
			);
			return;
		}

		const insertStmt = this.db.prepare(
			`INSERT INTO migration_state (
        migration_id, scope_user_id, scope_agent_id, schema_from, schema_to, applied_at, status, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		insertStmt.run(
			input.migration_id,
			scopeUserId,
			scopeAgentId,
			input.schema_from,
			input.schema_to,
			input.applied_at,
			input.status,
			input.notes || null,
		);
	}

	public recordMigrationState(
		scopeUserId: string,
		scopeAgentId: string,
		input: {
			migration_id: string;
			schema_from: string;
			schema_to: string;
			applied_at: string;
			status: string;
			notes?: string | null;
		},
	): void {
		this.upsertMigrationState(scopeUserId, scopeAgentId, input);
	}

	public getMigrationState(
		scopeUserId: string,
		scopeAgentId: string,
		migrationId: string,
	): {
		migration_id: string;
		schema_from: string;
		schema_to: string;
		applied_at: string;
		status: string;
		notes: string | null;
	} | null {
		const stmt = this.db.prepare(
			`SELECT migration_id, schema_from, schema_to, applied_at, status, notes
       FROM migration_state
       WHERE scope_user_id = ? AND scope_agent_id = ? AND migration_id = ?`,
		);
		const row = stmt.get(scopeUserId, scopeAgentId, migrationId) as
			| {
					migration_id: string;
					schema_from: string;
					schema_to: string;
					applied_at: string;
					status: string;
					notes: string | null;
			  }
			| undefined;
		return row || null;
	}

	public getMigrationStates(
		scopeUserId: string,
		scopeAgentId: string,
	): Array<{
		migration_id: string;
		schema_from: string;
		schema_to: string;
		applied_at: string;
		status: string;
		notes: string | null;
	}> {
		const stmt = this.db.prepare(
			`SELECT migration_id, schema_from, schema_to, applied_at, status, notes
       FROM migration_state
       WHERE scope_user_id = ? AND scope_agent_id = ?
       ORDER BY applied_at DESC`,
		);
		return stmt.all(scopeUserId, scopeAgentId) as Array<{
			migration_id: string;
			schema_from: string;
			schema_to: string;
			applied_at: string;
			status: string;
			notes: string | null;
		}>;
	}

	private rowToTaskRecord(row: {
		task_id: string;
		scope_user_id: string;
		scope_agent_id: string;
		project_id: string;
		task_title: string;
		task_type: string | null;
		task_status: string | null;
		parent_task_id: string | null;
		related_task_ids: string | null;
		files_touched: string | null;
		symbols_touched: string | null;
		commit_refs: string | null;
		diff_refs: string | null;
		decision_notes: string | null;
		tracker_issue_key: string | null;
		updated_at: string;
	}): TaskRegistryRecord {
		return {
			task_id: row.task_id,
			scope_user_id: row.scope_user_id,
			scope_agent_id: row.scope_agent_id,
			project_id: row.project_id,
			task_title: row.task_title,
			task_type: row.task_type,
			task_status: row.task_status,
			parent_task_id: row.parent_task_id,
			related_task_ids: this.parseJsonArrayField(row.related_task_ids),
			files_touched: this.parseJsonArrayField(row.files_touched),
			symbols_touched: this.parseJsonArrayField(row.symbols_touched),
			commit_refs: this.parseJsonArrayField(row.commit_refs),
			diff_refs: this.parseJsonArrayField(row.diff_refs),
			decision_notes: row.decision_notes,
			tracker_issue_key: row.tracker_issue_key,
			updated_at: row.updated_at,
		};
	}

	private computeMissingRegistrationFields(
		project: ProjectRecord,
		alias: string,
	): string[] {
		const missing: string[] = [];
		if (!project.project_id) missing.push("project_id");
		if (!alias) missing.push("project_alias");
		if (!project.project_name) missing.push("project_name");
		return missing;
	}

	private computeRegistrationCompleteness(
		project: ProjectRecord,
		alias: string,
	): number {
		const requiredTotal = 3;
		const requiredPresent = [
			project.project_id,
			alias,
			project.project_name,
		].filter(Boolean).length;
		const optionalTotal = 3;
		const optionalPresent = [
			project.repo_root,
			project.repo_remote_primary,
			project.active_version,
		].filter(Boolean).length;
		return Math.round(
			(requiredPresent / requiredTotal) * 80 +
				(optionalPresent / optionalTotal) * 20,
		);
	}

	private upsertProjectAlias(
		scopeUserId: string,
		scopeAgentId: string,
		projectId: string,
		projectAlias: string,
		isPrimary: boolean,
		now: string,
		allowAliasUpdate: boolean,
	): void {
		const existingAlias = this.getProjectAlias(
			scopeUserId,
			scopeAgentId,
			projectAlias,
		);
		if (existingAlias) {
			if (existingAlias.project_id !== projectId && !allowAliasUpdate) {
				throw new Error(
					`project_alias "${projectAlias}" is already mapped to another project_id`,
				);
			}
			const stmt = this.db.prepare(
				`UPDATE project_aliases SET project_id = ?, is_primary = ?, updated_at = ? WHERE id = ?`,
			);
			stmt.run(projectId, isPrimary ? 1 : 0, now, existingAlias.id);
			return;
		}

		const insertStmt = this.db.prepare(
			`INSERT INTO project_aliases (id, project_id, scope_user_id, scope_agent_id, project_alias, is_primary, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		insertStmt.run(
			randomUUID(),
			projectId,
			scopeUserId,
			scopeAgentId,
			projectAlias,
			isPrimary ? 1 : 0,
			now,
			now,
		);
	}

	private upsertProjectRegistrationState(
		scopeUserId: string,
		scopeAgentId: string,
		input: {
			project_id: string;
			registration_status: "draft" | "registered" | "validated" | "blocked";
			validation_status: "pending" | "ok" | "warn" | "error";
			validation_notes: string | null;
			completeness_score: number;
			missing_required_fields: string[];
			last_validated_at: string | null;
		},
	): ProjectRegistrationStateRecord {
		const now = new Date().toISOString();
		const existing = this.getProjectRegistrationState(
			scopeUserId,
			scopeAgentId,
			input.project_id,
		);
		const missingJson = JSON.stringify(input.missing_required_fields || []);

		if (existing) {
			const stmt = this.db.prepare(
				`UPDATE project_registration_state
         SET registration_status = ?, validation_status = ?, validation_notes = ?, completeness_score = ?, missing_required_fields = ?, last_validated_at = ?, updated_at = ?
         WHERE scope_user_id = ? AND scope_agent_id = ? AND project_id = ?`,
			);
			stmt.run(
				input.registration_status,
				input.validation_status,
				input.validation_notes,
				input.completeness_score,
				missingJson,
				input.last_validated_at,
				now,
				scopeUserId,
				scopeAgentId,
				input.project_id,
			);
		} else {
			const stmt = this.db.prepare(
				`INSERT INTO project_registration_state (project_id, scope_user_id, scope_agent_id, registration_status, validation_status, validation_notes, completeness_score, missing_required_fields, last_validated_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			);
			stmt.run(
				input.project_id,
				scopeUserId,
				scopeAgentId,
				input.registration_status,
				input.validation_status,
				input.validation_notes,
				input.completeness_score,
				missingJson,
				input.last_validated_at,
				now,
			);
		}

		const state = this.getProjectRegistrationState(
			scopeUserId,
			scopeAgentId,
			input.project_id,
		);
		if (!state) throw new Error("failed to persist project_registration_state");
		return state;
	}

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
		// Remove explicitly expired slots
		const stmt = this.db.prepare(
			`DELETE FROM slots
       WHERE scope_user_id = ? AND scope_agent_id = ?
         AND expires_at IS NOT NULL AND expires_at < ?`,
		);
		stmt.run(scopeUserId, scopeAgentId, now);

		// Auto-expire slots based on category TTL (auto_capture source)
		const categories = ["project", "environment", "custom"];
		for (const cat of categories) {
			const ttlDays = getSlotTTL(cat);
			const cutoff = new Date(
				Date.now() - ttlDays * 24 * 60 * 60 * 1000,
			).toISOString();
			const ttlStmt = this.db.prepare(
				`DELETE FROM slots
         WHERE scope_user_id = ? AND scope_agent_id = ?
           AND category = ? AND updated_at < ?
           AND key NOT LIKE '_autocapture%'
           AND source = 'auto_capture'`,
			);
			ttlStmt.run(scopeUserId, scopeAgentId, cat, cutoff);
		}

		// Safety cleanup: volatile project status slots should expire even if source was manual/tool.
		// This prevents stale "current phase/task" slots from persisting forever.
		const projectCutoff = new Date(
			Date.now() - getSlotTTL("project") * 24 * 60 * 60 * 1000,
		).toISOString();
		const volatileProjectStmt = this.db.prepare(
			`DELETE FROM slots
       WHERE scope_user_id = ? AND scope_agent_id = ?
         AND category = 'project'
         AND updated_at < ?
         AND key IN (
           'project.current',
           'project.current_task',
           'project.current_epic',
           'project.phase',
           'project.status'
         )`,
		);
		volatileProjectStmt.run(scopeUserId, scopeAgentId, projectCutoff);
	}

	close(): void {
		this.db.close();
	}
}
