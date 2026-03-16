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

interface RoutedPathMatch {
  path: string;
  line: number;
}

interface EventSignalMatch {
  eventKey: string;
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

function buildCodeGraphEventNodeId(projectId: string, eventKey: string): string {
  return `event:${projectId}:${sha1(eventKey)}`;
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

function normalizeRoutePath(routePath: string): string {
  const normalized = String(routePath || "").trim();
  if (!normalized) return "/";
  const cleaned = normalized.replace(/\/+/g, "/");
  if (cleaned.startsWith("/")) return cleaned;
  return `/${cleaned}`;
}

function joinRoutePath(prefix: string, childPath: string): string {
  const base = normalizeRoutePath(prefix);
  const child = String(childPath || "").trim();
  if (!child || child === "/") return base;
  const normalizedChild = child.startsWith("/") ? child : `/${child}`;
  const joined = `${base.replace(/\/$/, "")}${normalizedChild}`;
  return normalizeRoutePath(joined);
}

function extractRouteMatches(text: string): RoutedPathMatch[] {
  const out: RoutedPathMatch[] = [];
  const push = (path: string, offset: number) => {
    const normalized = normalizeRoutePath(path);
    out.push({ path: normalized, line: lineOf(text, offset) });
  };

  const httpRoutes = /\.(?:get|post|put|patch|delete|all|options|head)\s*\(\s*["'`]([^"'`]+)["'`]/gi;
  const nestController = /@Controller\s*\(\s*(?:["'`]([^"'`]*)["'`])?\s*\)/g;
  const nestRoutes = /@(?:Get|Post|Put|Patch|Delete|All|Options|Head)\s*\(\s*(?:["'`]([^"'`]*)["'`])?\s*\)/g;

  let match: RegExpExecArray | null;
  while ((match = httpRoutes.exec(text))) {
    push(match[1], match.index);
  }

  const controllerPrefixes: Array<{ offset: number; prefix: string }> = [];
  while ((match = nestController.exec(text))) {
    controllerPrefixes.push({
      offset: match.index,
      prefix: normalizeRoutePath(match[1] || "/"),
    });
  }

  while ((match = nestRoutes.exec(text))) {
    const routeOffset = match.index;
    const methodPath = String(match[1] || "").trim();
    const controllerPrefix = [...controllerPrefixes]
      .reverse()
      .find((item) => item.offset <= routeOffset)?.prefix;

    if (controllerPrefix) {
      push(joinRoutePath(controllerPrefix, methodPath), routeOffset);
      continue;
    }

    if (methodPath) {
      push(methodPath, routeOffset);
    }
  }

  const dedup = new Map<string, RoutedPathMatch>();
  for (const item of out) {
    const existing = dedup.get(item.path);
    if (!existing || item.line < existing.line) dedup.set(item.path, item);
  }

  return Array.from(dedup.values()).sort((a, b) => a.line - b.line || a.path.localeCompare(b.path));
}

function extractScheduleMatches(text: string): RoutedPathMatch[] {
  const out: RoutedPathMatch[] = [];
  const cronSchedule = /\bcron\.schedule\s*\(\s*["'`]([^"'`]+)["'`]/g;
  const scheduleJob = /\bscheduleJob\s*\(\s*["'`]([^"'`]+)["'`]/g;
  const setIntervalRegex = /\bsetInterval\s*\([^,]+,\s*(\d+)\s*\)/g;
  const setTimeoutRegex = /\bsetTimeout\s*\([^,]+,\s*(\d+)\s*\)/g;
  const nestCron = /@Cron\s*\(\s*["'`]([^"'`]+)["'`]/g;
  const nestInterval = /@Interval\s*\(\s*(\d+)\s*\)/g;
  const nestTimeout = /@Timeout\s*\(\s*(\d+)\s*\)/g;
  const bullProcess = /@Process\s*\(\s*["'`]([^"'`]+)["'`]/g;
  const agendaEvery = /\bagenda\.every\s*\(\s*["'`]([^"'`]+)["'`]/g;

  let match: RegExpExecArray | null;
  while ((match = cronSchedule.exec(text))) out.push({ path: `cron:${match[1]}`, line: lineOf(text, match.index) });
  while ((match = scheduleJob.exec(text))) out.push({ path: `scheduleJob:${match[1]}`, line: lineOf(text, match.index) });
  while ((match = setIntervalRegex.exec(text))) out.push({ path: `interval:${match[1]}ms`, line: lineOf(text, match.index) });
  while ((match = setTimeoutRegex.exec(text))) out.push({ path: `timeout:${match[1]}ms`, line: lineOf(text, match.index) });
  while ((match = nestCron.exec(text))) out.push({ path: `cron:${match[1]}`, line: lineOf(text, match.index) });
  while ((match = nestInterval.exec(text))) out.push({ path: `interval:${match[1]}ms`, line: lineOf(text, match.index) });
  while ((match = nestTimeout.exec(text))) out.push({ path: `timeout:${match[1]}ms`, line: lineOf(text, match.index) });
  while ((match = bullProcess.exec(text))) out.push({ path: `queue:${match[1]}`, line: lineOf(text, match.index) });
  while ((match = agendaEvery.exec(text))) out.push({ path: `agenda:${match[1]}`, line: lineOf(text, match.index) });

  const dedup = new Map<string, RoutedPathMatch>();
  for (const item of out) {
    const existing = dedup.get(item.path);
    if (!existing || item.line < existing.line) dedup.set(item.path, item);
  }

  return Array.from(dedup.values()).sort((a, b) => a.line - b.line || a.path.localeCompare(b.path));
}

function extractEventSignals(text: string): { emits: EventSignalMatch[]; consumes: EventSignalMatch[] } {
  const emits: EventSignalMatch[] = [];
  const consumes: EventSignalMatch[] = [];

  const emitPatterns = [
    /\.emit\s*\(\s*["'`]([^"'`]+)["'`]/g,
    /\.publish\s*\(\s*["'`]([^"'`]+)["'`]/g,
    /@Emit\s*\(\s*["'`]([^"'`]+)["'`]/g,
    /dispatchEvent\s*\(\s*["'`]([^"'`]+)["'`]/g,
  ];
  const consumePatterns = [
    /\.on\s*\(\s*["'`]([^"'`]+)["'`]/g,
    /\.once\s*\(\s*["'`]([^"'`]+)["'`]/g,
    /\.subscribe\s*\(\s*["'`]([^"'`]+)["'`]/g,
    /@On(?:Event)?\s*\(\s*["'`]([^"'`]+)["'`]/g,
    /@EventPattern\s*\(\s*["'`]([^"'`]+)["'`]/g,
  ];

  for (const pattern of emitPatterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text))) {
      emits.push({ eventKey: String(match[1]), line: lineOf(text, match.index) });
    }
  }

  for (const pattern of consumePatterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text))) {
      consumes.push({ eventKey: String(match[1]), line: lineOf(text, match.index) });
    }
  }

  const dedup = (items: EventSignalMatch[]) => {
    const map = new Map<string, EventSignalMatch>();
    for (const item of items) {
      const key = item.eventKey;
      const existing = map.get(key);
      if (!existing || item.line < existing.line) map.set(key, item);
    }
    return Array.from(map.values()).sort((a, b) => a.line - b.line || a.eventKey.localeCompare(b.eventKey));
  };

  return {
    emits: dedup(emits),
    consumes: dedup(consumes),
  };
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
    emits: 0,
    consumes: 0,
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

  const routePathToOwners = new Map<string, Array<{ nodeId: string; line: number }>>();
  for (const block of symbolBlocks) {
    const sourceNodeId = buildCodeGraphSymbolNodeId(input.projectId, relativePath, block.semantic_path);
    const routeMatches = extractRouteMatches(block.text);
    for (const routeMatch of routeMatches) {
      const owners = routePathToOwners.get(routeMatch.path) || [];
      owners.push({ nodeId: sourceNodeId, line: block.start_line + Math.max(routeMatch.line - 1, 0) });
      routePathToOwners.set(routeMatch.path, owners);
    }
  }

  const fileLevelRouteMatches = extractRouteMatches(content);
  for (const routeMatch of fileLevelRouteMatches) {
    const routeNodeId = buildCodeGraphRouteNodeId(input.projectId, routeMatch.path);
    upsertUniversalGraphNode(graph, scopeUserId, scopeAgentId, {
      node_id: routeNodeId,
      node_type: "route",
      name: routeMatch.path,
      properties: {
        project_id: input.projectId,
        route_path: routeMatch.path,
      },
    });
    nodesUpserted += 1;

    const owners = routePathToOwners.get(routeMatch.path) || [{ nodeId: fileNodeId, line: routeMatch.line }];
    for (const owner of owners) {
      emitRelation(`${owner.nodeId}|routes_to|${routeNodeId}`, () => {
        upsertUniversalGraphRelation(graph, scopeUserId, scopeAgentId, {
          source_node_id: owner.nodeId,
          target_node_id: routeNodeId,
          relation_type: "routes_to",
          provenance: {
            adapter_kind: ADAPTER_KIND,
            confidence: owner.nodeId === fileNodeId ? 0.74 : 0.86,
            evidence_path: relativePath,
            evidence_start_line: owner.line,
            evidence_end_line: owner.line,
          },
        });
      }, "routes_to");
    }
  }

  const scheduleKeyToOwners = new Map<string, Array<{ nodeId: string; line: number }>>();
  for (const block of symbolBlocks) {
    const sourceNodeId = buildCodeGraphSymbolNodeId(input.projectId, relativePath, block.semantic_path);
    const scheduleMatches = extractScheduleMatches(block.text);
    for (const scheduleMatch of scheduleMatches) {
      const owners = scheduleKeyToOwners.get(scheduleMatch.path) || [];
      owners.push({ nodeId: sourceNodeId, line: block.start_line + Math.max(scheduleMatch.line - 1, 0) });
      scheduleKeyToOwners.set(scheduleMatch.path, owners);
    }
  }

  const fileLevelScheduleMatches = extractScheduleMatches(content);
  for (const scheduleMatch of fileLevelScheduleMatches) {
    const scheduleKey = scheduleMatch.path;
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

    const owners = scheduleKeyToOwners.get(scheduleKey) || [{ nodeId: fileNodeId, line: scheduleMatch.line }];
    for (const owner of owners) {
      emitRelation(`${owner.nodeId}|scheduled_as|${jobNodeId}`, () => {
        upsertUniversalGraphRelation(graph, scopeUserId, scopeAgentId, {
          source_node_id: owner.nodeId,
          target_node_id: jobNodeId,
          relation_type: "scheduled_as",
          provenance: {
            adapter_kind: ADAPTER_KIND,
            confidence: owner.nodeId === fileNodeId ? 0.72 : 0.84,
            evidence_path: relativePath,
            evidence_start_line: owner.line,
            evidence_end_line: owner.line,
          },
        });
      }, "scheduled_as");
    }
  }

  const eventSignalToOwners = new Map<string, Array<{ nodeId: string; line: number; mode: "emits" | "consumes" }>>();
  for (const block of symbolBlocks) {
    const sourceNodeId = buildCodeGraphSymbolNodeId(input.projectId, relativePath, block.semantic_path);
    const eventSignals = extractEventSignals(block.text);
    for (const emitEvent of eventSignals.emits) {
      const owners = eventSignalToOwners.get(emitEvent.eventKey) || [];
      owners.push({
        nodeId: sourceNodeId,
        line: block.start_line + Math.max(emitEvent.line - 1, 0),
        mode: "emits",
      });
      eventSignalToOwners.set(emitEvent.eventKey, owners);
    }
    for (const consumeEvent of eventSignals.consumes) {
      const owners = eventSignalToOwners.get(consumeEvent.eventKey) || [];
      owners.push({
        nodeId: sourceNodeId,
        line: block.start_line + Math.max(consumeEvent.line - 1, 0),
        mode: "consumes",
      });
      eventSignalToOwners.set(consumeEvent.eventKey, owners);
    }
  }

  const fileLevelEventSignals = extractEventSignals(content);
  const fileLevelEvents = [
    ...fileLevelEventSignals.emits.map((item) => ({ ...item, mode: "emits" as const })),
    ...fileLevelEventSignals.consumes.map((item) => ({ ...item, mode: "consumes" as const })),
  ];

  for (const eventSignal of fileLevelEvents) {
    const eventNodeId = buildCodeGraphEventNodeId(input.projectId, eventSignal.eventKey);
    upsertUniversalGraphNode(graph, scopeUserId, scopeAgentId, {
      node_id: eventNodeId,
      node_type: "event",
      name: eventSignal.eventKey,
      properties: {
        project_id: input.projectId,
        event_key: eventSignal.eventKey,
      },
    });
    nodesUpserted += 1;

    const owners = eventSignalToOwners.get(eventSignal.eventKey)
      ?.filter((owner) => owner.mode === eventSignal.mode)
      || [{ nodeId: fileNodeId, line: eventSignal.line, mode: eventSignal.mode }];

    for (const owner of owners) {
      emitRelation(`${owner.nodeId}|${owner.mode}|${eventNodeId}`, () => {
        upsertUniversalGraphRelation(graph, scopeUserId, scopeAgentId, {
          source_node_id: owner.nodeId,
          target_node_id: eventNodeId,
          relation_type: owner.mode,
          provenance: {
            adapter_kind: ADAPTER_KIND,
            confidence: owner.nodeId === fileNodeId ? 0.7 : 0.82,
            evidence_path: relativePath,
            evidence_start_line: owner.line,
            evidence_end_line: owner.line,
          },
          properties: {
            event_key: eventSignal.eventKey,
          },
        });
      }, owner.mode);
    }
  }

  return {
    nodes_upserted: nodesUpserted,
    relations_upserted: relationsUpserted,
    relation_type_counts: relationTypeCounts,
  };
}
