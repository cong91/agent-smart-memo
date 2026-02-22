/**
 * Tests for GraphDB — run with: node --experimental-sqlite test-graph.ts
 * Or via: npx tsx test-graph.ts
 */

import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { mkdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { GraphDB } from "../src/db/graph-db.js";

const TEST_DIR = join(tmpdir(), `agent-memo-graph-test-${Date.now()}`);

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`ASSERTION FAILED: ${message}\n  actual:   ${a}\n  expected: ${e}`);
  }
}

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (error) {
    console.log(`  ❌ ${name}`);
    console.log(`     ${error instanceof Error ? error.message : String(error)}`);
    failed++;
  }
}

// ============================================================================
// Setup
// ============================================================================

console.log("\n🧪 GraphDB Tests\n");

const dbDir = join(TEST_DIR, "agent-memo");
if (!existsSync(dbDir)) {
  mkdirSync(dbDir, { recursive: true });
}
const dbPath = join(dbDir, "slots.db");
const db = new DatabaseSync(dbPath);
const graphDB = new GraphDB(db);

const USER = "telegram:dm:5165741309";
const AGENT = "fullstack";

// ============================================================================
// Entity Tests
// ============================================================================

console.log("📦 Entity Tests:\n");

let person1Id: string;
let project1Id: string;
let tech1Id: string;

test("createEntity creates a person entity", () => {
  const entity = graphDB.createEntity(USER, AGENT, {
    name: "MrC",
    type: "person",
    properties: { role: "CTO", location: "HCMC" },
  });
  person1Id = entity.id;
  assert(entity.name === "MrC", "name should be MrC");
  assert(entity.type === "person", "type should be person");
  assertEqual(entity.properties.role, "CTO", "properties.role should be CTO");
  assert(entity.id.includes("-"), "id should be UUID format");
});

test("createEntity creates a project entity", () => {
  const entity = graphDB.createEntity(USER, AGENT, {
    name: "SlotMemory",
    type: "project",
    properties: { status: "active", priority: "high" },
  });
  project1Id = entity.id;
  assert(entity.name === "SlotMemory", "name should be SlotMemory");
  assert(entity.type === "project", "type should be project");
});

test("createEntity creates a technology entity", () => {
  const entity = graphDB.createEntity(USER, AGENT, {
    name: "SQLite",
    type: "technology",
    properties: { category: "database" },
  });
  tech1Id = entity.id;
  assert(entity.name === "SQLite", "name should be SQLite");
  assert(entity.type === "technology", "type should be technology");
});

test("getEntity retrieves entity by ID", () => {
  const entity = graphDB.getEntity(USER, AGENT, person1Id);
  assert(entity !== null, "should find entity");
  assert(entity!.name === "MrC", "name should be MrC");
});

test("getEntity returns null for non-existent ID", () => {
  const entity = graphDB.getEntity(USER, AGENT, "non-existent-id");
  assertEqual(entity, null, "should return null");
});

test("listEntities returns all entities", () => {
  const entities = graphDB.listEntities(USER, AGENT);
  assert(entities.length >= 3, `should have at least 3 entities, got ${entities.length}`);
});

test("listEntities filters by type", () => {
  const persons = graphDB.listEntities(USER, AGENT, { type: "person" });
  assert(persons.length >= 1, `should have at least 1 person, got ${persons.length}`);
  assert(persons.every((e) => e.type === "person"), "all should be person type");
});

test("listEntities filters by name", () => {
  const results = graphDB.listEntities(USER, AGENT, { name: "Mr" });
  assert(results.length >= 1, `should find MrC by partial name, got ${results.length}`);
});

test("updateEntity updates entity properties", () => {
  const updated = graphDB.updateEntity(USER, AGENT, person1Id, {
    properties: { role: "CEO", location: "HCMC", age: 30 },
  });
  assert(updated !== null, "should return updated entity");
  assertEqual(updated!.properties.role, "CEO", "role should be updated to CEO");
  assertEqual(updated!.properties.age, 30, "age should be 30");
});

// ============================================================================
// Relationship Tests
// ============================================================================

console.log("\n🔗 Relationship Tests:\n");

let rel1Id: string;
let rel2Id: string;

test("createRelationship creates a relationship", () => {
  const rel = graphDB.createRelationship(USER, AGENT, {
    source_entity_id: person1Id,
    target_entity_id: project1Id,
    relation_type: "manages",
    weight: 1.0,
    properties: { since: "2024-01" },
  });
  rel1Id = rel.id;
  assert(rel.source_entity_id === person1Id, "source should be person1Id");
  assert(rel.target_entity_id === project1Id, "target should be project1Id");
  assert(rel.relation_type === "manages", "relation_type should be manages");
  assert(rel.weight === 1.0, "weight should be 1.0");
});

test("createRelationship creates another relationship", () => {
  const rel = graphDB.createRelationship(USER, AGENT, {
    source_entity_id: project1Id,
    target_entity_id: tech1Id,
    relation_type: "uses",
    weight: 0.9,
    properties: { critical: true },
  });
  rel2Id = rel.id;
  assert(rel.relation_type === "uses", "relation_type should be uses");
});

test("getRelationship retrieves relationship by ID", () => {
  const rel = graphDB.getRelationship(USER, AGENT, rel1Id);
  assert(rel !== null, "should find relationship");
  assert(rel!.relation_type === "manages", "relation_type should be manages");
});

test("getRelationships outgoing from entity", () => {
  const rels = graphDB.getRelationships(USER, AGENT, person1Id, "outgoing");
  assert(rels.length >= 1, `should have at least 1 outgoing relationship, got ${rels.length}`);
  assert(rels.every((r) => r.source_entity_id === person1Id), "all should have person1Id as source");
});

test("getRelationships incoming to entity", () => {
  const rels = graphDB.getRelationships(USER, AGENT, project1Id, "incoming");
  assert(rels.length >= 1, `should have at least 1 incoming relationship, got ${rels.length}`);
  assert(rels.every((r) => r.target_entity_id === project1Id), "all should have project1Id as target");
});

test("getRelationships both directions", () => {
  const rels = graphDB.getRelationships(USER, AGENT, project1Id, "both");
  assert(rels.length >= 2, `should have at least 2 relationships (in+out), got ${rels.length}`);
});

// ============================================================================
// Graph Traversal Tests
// ============================================================================

console.log("\n🕸️ Graph Traversal Tests:\n");

test("traverseGraph from start entity", () => {
  const graph = graphDB.traverseGraph(USER, AGENT, person1Id, 2);
  assert(graph.entities.length >= 2, `should find at least 2 entities, got ${graph.entities.length}`);
  assert(graph.relationships.length >= 1, `should find at least 1 relationship, got ${graph.relationships.length}`);
});

// ============================================================================
// Delete Tests
// ============================================================================

console.log("\n🗑️ Delete Tests:\n");

test("deleteRelationship removes relationship", () => {
  const deleted = graphDB.deleteRelationship(USER, AGENT, rel2Id);
  assert(deleted, "should return true");
  const rel = graphDB.getRelationship(USER, AGENT, rel2Id);
  assertEqual(rel, null, "should be null after delete");
});

test("deleteEntity cascade deletes relationships", () => {
  // Create a new entity and relationship
  const tempEntity = graphDB.createEntity(USER, AGENT, { name: "Temp", type: "concept" });
  const tempRel = graphDB.createRelationship(USER, AGENT, {
    source_entity_id: person1Id,
    target_entity_id: tempEntity.id,
    relation_type: "knows",
  });
  
  const deleted = graphDB.deleteEntity(USER, AGENT, tempEntity.id);
  assert(deleted, "should return true");
  
  const entity = graphDB.getEntity(USER, AGENT, tempEntity.id);
  assertEqual(entity, null, "entity should be null after delete");
  
  const rel = graphDB.getRelationship(USER, AGENT, tempRel.id);
  assertEqual(rel, null, "relationship should be cascade deleted");
});

// ============================================================================
// Scope Isolation Tests
// ============================================================================

console.log("\n🔒 Scope Isolation Tests:\n");

test("entities are isolated by user", () => {
  const USER2 = "telegram:dm:9999999";
  const entity = graphDB.createEntity(USER2, AGENT, { name: "OtherUser", type: "person" });
  
  const fromUser1 = graphDB.getEntity(USER, AGENT, entity.id);
  const fromUser2 = graphDB.getEntity(USER2, AGENT, entity.id);
  
  assertEqual(fromUser1, null, "user1 should not see user2's entity");
  assert(fromUser2 !== null, "user2 should see their own entity");
});

test("entities are isolated by agent", () => {
  const AGENT2 = "creator";
  const entity = graphDB.createEntity(USER, AGENT2, { name: "CreatorEntity", type: "project" });
  
  const fromAgent1 = graphDB.getEntity(USER, AGENT, entity.id);
  const fromAgent2 = graphDB.getEntity(USER, AGENT2, entity.id);
  
  assertEqual(fromAgent1, null, "agent1 should not see agent2's entity");
  assert(fromAgent2 !== null, "agent2 should see their own entity");
});

// ============================================================================
// Summary
// ============================================================================

db.close();

// Cleanup test dir
try {
  rmSync(TEST_DIR, { recursive: true, force: true });
} catch {}

console.log(`\n📊 Results: ${passed} passed, ${failed} failed out of ${passed + failed} tests\n`);

if (failed > 0) {
  process.exit(1);
} else {
  console.log("🎉 All GraphDB tests passed!\n");
}
