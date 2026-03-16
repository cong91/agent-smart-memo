import { createHash } from "node:crypto";
import { dirname, extname, join, normalize } from "node:path";
import type { GraphDB } from "../../db/graph-db.js";
import type { SemanticBlock } from "../ingest/contracts.js";
import { extractSemanticBlocks } from "../ingest/semantic-block-extractor.js";
import {
  upsertUniversalGraphNode,
  upsertUniversalGraphRelation,
} from "./code-graph-model.js";

const ADAPTER_KIND = "indexer.code_graph.populate";

export interface PopulateCodeGraphFileInput {
  projectId: string;
  relativePath: string;
  module?: string | null;
  language?: string | null;
  content: string;
  blocks?: SemanticBlock[];
}

export interface PopulateCodeGraphFileResult {
  nodes_upserted: number;
  relations_upserted: number;
  relation_type_counts: Record<string, number>;
}

interface ParsedImportStatement {
  specifier: string;
  importedNames: string[];
  line: number;
}

export function buildCodeGraphFileNodeId(projectId: string, relativePath: string): string {
  return `file:${projectId}:${normalizePath(relativePath)}`;
}

export function buildCodeGraphModuleNodeId(projectId: string, moduleName: string): string {
  return `module:${projectId}:${String(moduleName || "").trim()}`;
}

export function buildCodeGraphSymbolNodeId(projectId: string, relativePath: string, semanticPath: string): string {
  return `symbol:${projectId}:${normalizePath(relativePath)}:${semanticPath}`;
}

function buildCodeGraphDependencyNodeId(specifier: string): string {
  return `module_dep:${String(specifier || "").trim()}`;
}

function buildCodeGraphDependencySymbolNodeId(specifier: string, symbolName: string): string {
  return `symbol_dep:${String(specifier || "").trim()}:${String(symbolName || "").trim()}`;
}

function buildCodeGraphRouteNodeId(projectId: string, routePath: string): string {
  return `route:${projectId}:${routePath}`;
}

function buildCodeGraphJobNodeId(projectId: string, jobKey: string): string {
  return `job:${projectId}:${sha1(jobKey)}`;
}

function sha1(raw: string): string {
  return createHash("sha1").update(raw).digest("hex");
}

function normalizePath(input: string): string {
  return normalize(String(input || "").replace(/\\/g, "/")).replace(/^\.\//, "").replace(/\\/g, "/");
}

function parseImportedNames(clause: string): string[] {
  const names = new Set<string>();
  const cleaned = String(clause || "").trim();
  if (!cleaned) return [];

  const namespaceMatch = cleaned.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
  if (namespaceMatch?.[1]) names.add(namespaceMatch[1]);

  const namedGroup = cleaned.match(/\{([\s\S]*?)\}/);
  if (namedGroup?.[1]) {
    for (const tokenRaw of namedGroup[1].split(",")) {
      const token = tokenRaw.trim();
      if (!token) continue;
      const alias = token.match(/\bas\s+([A-Za-z_$][\w$]*)$/i);
      if (alias?.[1]) {
        names.add(alias[1]);
      } else {
        const bare = token.match(/^([A-Za-z_$][\w$]*)$/);
        if (bare?.[1]) names.add(bare[1]);
      }
    }
  }

  const withoutBraces = cleaned.replace(/\{[\s\S]*?\}/g, "").trim();
  if (withoutBraces) {
    for (const tokenRaw of withoutBraces.split(",")) {
      const token = tokenRaw.trim();
      if (!token || token.startsWith("*")) continue;
      const defaultMatch = token.match(/^([A-Za-z_$][\w$]*)$/);
      if (defaultMatch?.[1]) names.add(defaultMatch[1]);
    }
  }

  return Array.from(names);
}

function parseImportStatements(content: string): ParsedImportStatement[] {
  const out: ParsedImportStatement[] = [];

  const importFrom = /^\s*import\s+([\s\S]*?)\s+from\s*["'`]([^"'`]+)["'`]/gm;
  const importOnly = /^\s*import\s*["'`]([^"'`]+)["'`]/gm;
  const requireExpr = /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*["'`]([^"'`]+)["'`]\s*\)/gm;

  let match: RegExpExecArray | null;
  while ((match = importFrom.exec(content))) {
    out.push({
      specifier: match[2],
      importedNames: parseImportedNames(match[1]),
      line: lineOf(content, match.index),
    });
  }

  while ((match = importOnly.exec(content))) {
    out.push({
      specifier: match[1],
      importedNames: [],
      line: lineOf(content, match.index),
    });
  }

  while ((match = requireExpr.exec(content))) {
    out.push({
      specifier: match[2],
      importedNames: [match[1]],
      line: lineOf(content, match.index),
    });
  }

  const dedup = new Map<string, ParsedImportStatement>();
  for (const item of out) {
    const key = `${item.specifier}@@${item.line}`;
    const existing = dedup.get(key);
    if (!existing) {
      dedup.set(key, item);
      continue;
    }

    const names = new Set([...existing.importedNames, ...item.importedNames]);
    dedup.set(key, { ...existing, importedNames: Array.from(names) });
  }

  return Array.from(dedup.values()).sort((a, b) => a.line - b.line);
}

function resolveRelativeImportPath(sourceRelativePath: string, specifier: string): string {
  const baseDir = dirname(sourceRelativePath);
  const candidate = normalizePath(join(baseDir, specifier));
  if (extname(candidate)) return candidate;
  return `${candidate}.ts`;
}

function extractCallTargets(blockText: string): string[] {
  const callRegex = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  const banned = new Set([
    "if",
    "for",
    "while",
    "switch",
    "catch",
    "return",
    "new",
    "function",
    "class",
    "setTimeout",
    "setInterval",
    "Promise",
    "console",
    "require",
  ]);
  const out = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = callRegex.exec(blockText))) {
    const name = match[1];
    if (!banned.has(name)) out.add(name);
  }
  return Array.from(out);
}

function extractRoutePaths(text: string): string[] {
  const out = new Set<string>();
  const httpRoutes = /\.(?:get|post|put|patch|delete|all|options|head)\s*\(\s*["'`]([^"'`]+)["'`]/gi;
  const nestRoutes = /@(?:Get|Post|Put|Patch|Delete|All|Options|Head)\s*\(\s*["'`]([^"'`]+)["'`]/g;

  let match: RegExpExecArray | null;
  while ((match = httpRoutes.exec(text))) {
    if (match[1]?.startsWith("/")) out.add(match[1]);
  }
  while ((match = nestRoutes.exec(text))) {
    if (match[1]?.startsWith("/")) out.add(match[1]);
  }

  return Array.from(out);
}

function extractScheduleKeys(text: string): string[] {
  const out = new Set<string>();
  const cronSchedule = /\bcron\.schedule\s*\(\s*["'`]([^"'`]+)["'`]/g;
  const scheduleJob = /\bscheduleJob\s*\(\s*["'`]([^"'`]+)["'`]/g;
  const setIntervalRegex = /\bsetInterval\s*\([^,]+,\s*(\d+)\s*\)/g;

  let match: RegExpExecArray | null;
  while ((match = cronSchedule.exec(text))) out.add(`cron:${match[1]}`);
  while ((match = scheduleJob.exec(text))) out.add(`scheduleJob:${match[1]}`);
  while ((match = setIntervalRegex.exec(text))) out.add(`interval:${match[1]}ms`);

  return Array.from(out);
}

function lineOf(content: string, offset: number): number {
  return content.slice(0, offset).split("\n").length;
}

export function populateUniversalCodeGraphForFile(
  graph: GraphDB,
  scopeUserId: string,
  scopeAgentId: string,
  input: PopulateCodeGraphFileInput,
): PopulateCodeGraphFileResult {
  const relativePath = normalizePath(input.relativePath);
  const language = String(input.language || "").trim() || extname(relativePath).replace(/^\./, "") || "text";
  const moduleName = String(input.module || "").trim() || null;
  const content = String(input.content || "");
  const blocks = Array.isArray(input.blocks) && input.blocks.length > 0
    ? input.blocks
    : extractSemanticBlocks({ relativePath, content });

  const relationTypeCounts: Record<string, number> = {
    defines: 0,
    imports: 0,
    calls: 0,
    routes_to: 0,
    scheduled_as: 0,
    depends_on: 0,
  };

  let nodesUpserted = 0;
  let relationsUpserted = 0;
  const relationLocalKey = new Set<string>();

  const emitRelation = (key: string, emit: () => void, relationType: keyof typeof relationTypeCounts) => {
    if (relationLocalKey.has(key)) return;
    emit();
    relationLocalKey.add(key);
    relationsUpserted += 1;
    relationTypeCounts[relationType] += 1;
  };

  graph.deleteCodeAwareRelationshipsByEvidencePath(scopeUserId, scopeAgentId, relativePath);

  const fileNodeId = buildCodeGraphFileNodeId(input.projectId, relativePath);
  upsertUniversalGraphNode(graph, scopeUserId, scopeAgentId, {
    node_id: fileNodeId,
    node_type: "file",
    name: relativePath,
    properties: {
      project_id: input.projectId,
      relative_path: relativePath,
      module: moduleName,
      language,
    },
  });
  nodesUpserted += 1;

  if (moduleName) {
    const moduleNodeId = buildCodeGraphModuleNodeId(input.projectId, moduleName);
    upsertUniversalGraphNode(graph, scopeUserId, scopeAgentId, {
      node_id: moduleNodeId,
      node_type: "module",
      name: moduleName,
      properties: {
        project_id: input.projectId,
        module: moduleName,
      },
    });
    nodesUpserted += 1;

    emitRelation(`${moduleNodeId}|defines|${fileNodeId}`, () => {
      upsertUniversalGraphRelation(graph, scopeUserId, scopeAgentId, {
        source_node_id: moduleNodeId,
        target_node_id: fileNodeId,
        relation_type: "defines",
        provenance: {
          adapter_kind: ADAPTER_KIND,
          confidence: 0.97,
          evidence_path: relativePath,
        },
        properties: {
          source_kind: "index_module",
        },
      });
    }, "defines");
  }

  const symbolBlocks = blocks.filter((block) => ["function", "class", "method", "tool"].includes(block.kind));
  const symbolNodeIdsByName = new Map<string, string[]>();

  for (const block of symbolBlocks) {
    const symbolName = String(block.symbol_name || "").trim();
    if (!symbolName) continue;

    const symbolNodeId = buildCodeGraphSymbolNodeId(input.projectId, relativePath, block.semantic_path);
    upsertUniversalGraphNode(graph, scopeUserId, scopeAgentId, {
      node_id: symbolNodeId,
      node_type: "symbol",
      name: symbolName,
      properties: {
        project_id: input.projectId,
        relative_path: relativePath,
        semantic_path: block.semantic_path,
        symbol_kind: block.kind,
        start_line: block.start_line,
        end_line: block.end_line,
      },
    });
    nodesUpserted += 1;

    const prev = symbolNodeIdsByName.get(symbolName) || [];
    prev.push(symbolNodeId);
    symbolNodeIdsByName.set(symbolName, prev);

    emitRelation(`${fileNodeId}|defines|${symbolNodeId}`, () => {
      upsertUniversalGraphRelation(graph, scopeUserId, scopeAgentId, {
        source_node_id: fileNodeId,
        target_node_id: symbolNodeId,
        relation_type: "defines",
        provenance: {
          adapter_kind: ADAPTER_KIND,
          confidence: 0.99,
          evidence_path: relativePath,
          evidence_start_line: block.start_line,
          evidence_end_line: block.end_line,
        },
        properties: {
          symbol_kind: block.kind,
        },
      });
    }, "defines");
  }

  const importedSymbolTargets = new Map<string, string[]>();
  const importStatements = parseImportStatements(content);

  for (const importStmt of importStatements) {
    const specifier = importStmt.specifier;
    if (specifier.startsWith(".")) {
      const targetPath = resolveRelativeImportPath(relativePath, specifier);
      const importedFileNodeId = buildCodeGraphFileNodeId(input.projectId, targetPath);
      upsertUniversalGraphNode(graph, scopeUserId, scopeAgentId, {
        node_id: importedFileNodeId,
        node_type: "file",
        name: targetPath,
        properties: {
          project_id: input.projectId,
          relative_path: targetPath,
          inferred: true,
        },
      });
      nodesUpserted += 1;

      for (const relationType of ["imports", "depends_on"] as const) {
        emitRelation(`${fileNodeId}|${relationType}|${importedFileNodeId}`, () => {
          upsertUniversalGraphRelation(graph, scopeUserId, scopeAgentId, {
            source_node_id: fileNodeId,
            target_node_id: importedFileNodeId,
            relation_type: relationType,
            provenance: {
              adapter_kind: ADAPTER_KIND,
              confidence: relationType === "imports" ? 0.95 : 0.88,
              evidence_path: relativePath,
              evidence_start_line: importStmt.line,
              evidence_end_line: importStmt.line,
            },
            properties: {
              specifier,
              target_kind: "file",
            },
          });
        }, relationType);
      }

      for (const importedName of importStmt.importedNames) {
        const importedSymbolNodeId = buildCodeGraphSymbolNodeId(
          input.projectId,
          targetPath,
          `imported:${importedName}`,
        );
        upsertUniversalGraphNode(graph, scopeUserId, scopeAgentId, {
          node_id: importedSymbolNodeId,
          node_type: "symbol",
          name: importedName,
          properties: {
            project_id: input.projectId,
            relative_path: targetPath,
            semantic_path: `imported:${importedName}`,
            inferred: true,
            imported_by: relativePath,
          },
        });
        nodesUpserted += 1;

        emitRelation(`${importedFileNodeId}|defines|${importedSymbolNodeId}`, () => {
          upsertUniversalGraphRelation(graph, scopeUserId, scopeAgentId, {
            source_node_id: importedFileNodeId,
            target_node_id: importedSymbolNodeId,
            relation_type: "defines",
            provenance: {
              adapter_kind: ADAPTER_KIND,
              confidence: 0.58,
              evidence_path: relativePath,
              evidence_start_line: importStmt.line,
              evidence_end_line: importStmt.line,
            },
            properties: {
              source_kind: "import_binding_inferred",
              specifier,
            },
          });
        }, "defines");

        const prevTargets = importedSymbolTargets.get(importedName) || [];
        prevTargets.push(importedSymbolNodeId);
        importedSymbolTargets.set(importedName, prevTargets);
      }
      continue;
    }

    const dependencyNodeId = buildCodeGraphDependencyNodeId(specifier);
    upsertUniversalGraphNode(graph, scopeUserId, scopeAgentId, {
      node_id: dependencyNodeId,
      node_type: "module",
      name: specifier,
      properties: {
        dependency: true,
      },
    });
    nodesUpserted += 1;

    for (const relationType of ["imports", "depends_on"] as const) {
      emitRelation(`${fileNodeId}|${relationType}|${dependencyNodeId}`, () => {
        upsertUniversalGraphRelation(graph, scopeUserId, scopeAgentId, {
          source_node_id: fileNodeId,
          target_node_id: dependencyNodeId,
          relation_type: relationType,
          provenance: {
            adapter_kind: ADAPTER_KIND,
            confidence: relationType === "imports" ? 0.93 : 0.9,
            evidence_path: relativePath,
            evidence_start_line: importStmt.line,
            evidence_end_line: importStmt.line,
          },
          properties: {
            specifier,
            target_kind: "module",
          },
        });
      }, relationType);
    }

    for (const importedName of importStmt.importedNames) {
      const importedDepSymbolNodeId = buildCodeGraphDependencySymbolNodeId(specifier, importedName);
      upsertUniversalGraphNode(graph, scopeUserId, scopeAgentId, {
        node_id: importedDepSymbolNodeId,
        node_type: "symbol",
        name: importedName,
        properties: {
          semantic_path: `module_import:${specifier}:${importedName}`,
          inferred: true,
          dependency_specifier: specifier,
          imported_by: relativePath,
        },
      });
      nodesUpserted += 1;

      emitRelation(`${dependencyNodeId}|defines|${importedDepSymbolNodeId}`, () => {
        upsertUniversalGraphRelation(graph, scopeUserId, scopeAgentId, {
          source_node_id: dependencyNodeId,
          target_node_id: importedDepSymbolNodeId,
          relation_type: "defines",
          provenance: {
            adapter_kind: ADAPTER_KIND,
            confidence: 0.5,
            evidence_path: relativePath,
            evidence_start_line: importStmt.line,
            evidence_end_line: importStmt.line,
          },
          properties: {
            source_kind: "dependency_binding_inferred",
            specifier,
          },
        });
      }, "defines");

      const prevTargets = importedSymbolTargets.get(importedName) || [];
      prevTargets.push(importedDepSymbolNodeId);
      importedSymbolTargets.set(importedName, prevTargets);
    }
  }

  for (const block of symbolBlocks) {
    const sourceName = String(block.symbol_name || "").trim();
    if (!sourceName) continue;
    const sourceNodeIds = symbolNodeIdsByName.get(sourceName) || [];
    if (sourceNodeIds.length === 0) continue;
    const sourceNodeId = sourceNodeIds[0];

    for (const targetName of extractCallTargets(block.text)) {
      const localTargetNodeIds = symbolNodeIdsByName.get(targetName);
      if (localTargetNodeIds && localTargetNodeIds.length > 0) {
        for (const targetNodeId of localTargetNodeIds) {
          if (targetNodeId === sourceNodeId) continue;
          emitRelation(`${sourceNodeId}|calls|${targetNodeId}`, () => {
            upsertUniversalGraphRelation(graph, scopeUserId, scopeAgentId, {
              source_node_id: sourceNodeId,
              target_node_id: targetNodeId,
              relation_type: "calls",
              provenance: {
                adapter_kind: ADAPTER_KIND,
                confidence: 0.82,
                evidence_path: relativePath,
                evidence_start_line: block.start_line,
                evidence_end_line: block.end_line,
              },
              properties: {
                caller_symbol: sourceName,
                callee_symbol: targetName,
              },
            });
          }, "calls");
        }
        continue;
      }

      const importedTargets = importedSymbolTargets.get(targetName) || [];
      for (const targetNodeId of importedTargets) {
        emitRelation(`${sourceNodeId}|calls|${targetNodeId}`, () => {
          upsertUniversalGraphRelation(graph, scopeUserId, scopeAgentId, {
            source_node_id: sourceNodeId,
            target_node_id: targetNodeId,
            relation_type: "calls",
            provenance: {
              adapter_kind: ADAPTER_KIND,
              confidence: 0.76,
              evidence_path: relativePath,
              evidence_start_line: block.start_line,
              evidence_end_line: block.end_line,
            },
            properties: {
              caller_symbol: sourceName,
              callee_symbol: targetName,
              target_kind: "imported_binding",
            },
          });
        }, "calls");
      }
    }
  }

  const routePathToSymbolOwners = new Map<string, string[]>();
  for (const block of symbolBlocks) {
    const sourceNodeId = buildCodeGraphSymbolNodeId(input.projectId, relativePath, block.semantic_path);
    const routePaths = extractRoutePaths(block.text);
    for (const routePath of routePaths) {
      const owners = routePathToSymbolOwners.get(routePath) || [];
      owners.push(sourceNodeId);
      routePathToSymbolOwners.set(routePath, owners);
    }
  }

  const fileLevelRoutes = extractRoutePaths(content);
  for (const routePath of fileLevelRoutes) {
    const routeNodeId = buildCodeGraphRouteNodeId(input.projectId, routePath);
    upsertUniversalGraphNode(graph, scopeUserId, scopeAgentId, {
      node_id: routeNodeId,
      node_type: "route",
      name: routePath,
      properties: {
        project_id: input.projectId,
        route_path: routePath,
      },
    });
    nodesUpserted += 1;

    const owners = routePathToSymbolOwners.get(routePath) || [fileNodeId];
    for (const ownerNodeId of owners) {
      emitRelation(`${ownerNodeId}|routes_to|${routeNodeId}`, () => {
        upsertUniversalGraphRelation(graph, scopeUserId, scopeAgentId, {
          source_node_id: ownerNodeId,
          target_node_id: routeNodeId,
          relation_type: "routes_to",
          provenance: {
            adapter_kind: ADAPTER_KIND,
            confidence: ownerNodeId === fileNodeId ? 0.74 : 0.86,
            evidence_path: relativePath,
          },
        });
      }, "routes_to");
    }
  }

  const scheduleKeyToOwners = new Map<string, string[]>();
  for (const block of symbolBlocks) {
    const sourceNodeId = buildCodeGraphSymbolNodeId(input.projectId, relativePath, block.semantic_path);
    const scheduleKeys = extractScheduleKeys(block.text);
    for (const scheduleKey of scheduleKeys) {
      const owners = scheduleKeyToOwners.get(scheduleKey) || [];
      owners.push(sourceNodeId);
      scheduleKeyToOwners.set(scheduleKey, owners);
    }
  }

  const fileLevelScheduleKeys = extractScheduleKeys(content);
  for (const scheduleKey of fileLevelScheduleKeys) {
    const jobNodeId = buildCodeGraphJobNodeId(input.projectId, `${relativePath}:${scheduleKey}`);
    upsertUniversalGraphNode(graph, scopeUserId, scopeAgentId, {
      node_id: jobNodeId,
      node_type: "job",
      name: scheduleKey,
      properties: {
        project_id: input.projectId,
        schedule_key: scheduleKey,
      },
    });
    nodesUpserted += 1;

    const owners = scheduleKeyToOwners.get(scheduleKey) || [fileNodeId];
    for (const ownerNodeId of owners) {
      emitRelation(`${ownerNodeId}|scheduled_as|${jobNodeId}`, () => {
        upsertUniversalGraphRelation(graph, scopeUserId, scopeAgentId, {
          source_node_id: ownerNodeId,
          target_node_id: jobNodeId,
          relation_type: "scheduled_as",
          provenance: {
            adapter_kind: ADAPTER_KIND,
            confidence: ownerNodeId === fileNodeId ? 0.72 : 0.84,
            evidence_path: relativePath,
          },
        });
      }, "scheduled_as");
    }
  }

  return {
    nodes_upserted: nodesUpserted,
    relations_upserted: relationsUpserted,
    relation_type_counts: relationTypeCounts,
  };
}
