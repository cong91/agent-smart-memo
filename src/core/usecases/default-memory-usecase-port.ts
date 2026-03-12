import type {
  CoreRequestEnvelope,
  MemoryUseCaseName,
  MemoryUseCasePort,
} from "../contracts/adapter-contracts.js";
import { SlotDB } from "../../db/slot-db.js";
import type { SemanticMemoryUseCase } from "./semantic-memory-usecase.js";

interface SlotGetPayload {
  key?: string;
  category?: string;
  scope?: "private" | "team" | "public" | "all";
}

interface SlotSetPayload {
  key: string;
  value: unknown;
  category?: string;
  source?: "manual" | "auto_capture" | "tool";
  scope?: "private" | "team" | "public";
}

interface SlotListPayload {
  category?: string;
  prefix?: string;
  scope?: "private" | "team" | "public" | "all";
}

interface SlotDeletePayload {
  key: string;
  scope?: "private" | "team" | "public";
}

interface GraphEntityGetPayload {
  id?: string;
  type?: string;
  name?: string;
}

interface GraphEntitySetPayload {
  id?: string;
  name: string;
  type: string;
  properties?: Record<string, unknown>;
}

interface GraphRelAddPayload {
  source_id: string;
  target_id: string;
  relation_type: string;
  weight?: number;
  properties?: Record<string, unknown>;
}

interface GraphRelRemovePayload {
  id?: string;
  source_id?: string;
  target_id?: string;
  relation_type?: string;
}

interface GraphSearchPayload {
  entity_id: string;
  depth?: number;
  relation_type?: string;
}

interface ScopeIdentity {
  userId: string;
  agentId: string;
  scope: "private" | "team" | "public";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizePrivateIdentity(ctx: { userId: string; agentId: string }): ScopeIdentity {
  return {
    userId: ctx.userId || "default",
    agentId: ctx.agentId || "assistant",
    scope: "private",
  };
}

function scopeToIdentity(
  ctx: { userId: string; agentId: string },
  scope: "private" | "team" | "public" | undefined,
): ScopeIdentity {
  const base = normalizePrivateIdentity(ctx);

  if (scope === "team") {
    return { userId: base.userId, agentId: "__team__", scope: "team" };
  }

  if (scope === "public") {
    return { userId: "__public__", agentId: "__public__", scope: "public" };
  }

  return base;
}

function allScopeIdentities(ctx: { userId: string; agentId: string }): ScopeIdentity[] {
  const base = normalizePrivateIdentity(ctx);
  return [
    base,
    { userId: base.userId, agentId: "__team__", scope: "team" },
    { userId: "__public__", agentId: "__public__", scope: "public" },
  ];
}

export class DefaultMemoryUseCasePort implements MemoryUseCasePort {
  constructor(
    private readonly slotDb: SlotDB,
    private readonly semanticUseCase?: SemanticMemoryUseCase,
  ) {}

  async run<TReq, TRes>(
    useCase: MemoryUseCaseName,
    req: CoreRequestEnvelope<TReq>,
  ): Promise<TRes> {
    const payload = asRecord(req.payload);

    switch (useCase) {
      case "slot.get":
        return this.handleSlotGet(payload as unknown as SlotGetPayload, req) as TRes;
      case "slot.set":
        return this.handleSlotSet(payload as unknown as SlotSetPayload, req) as TRes;
      case "slot.list":
        return this.handleSlotList(payload as unknown as SlotListPayload, req) as TRes;
      case "slot.delete":
        return this.handleSlotDelete(payload as unknown as SlotDeletePayload, req) as TRes;
      case "graph.entity.get":
        return this.handleGraphEntityGet(payload as unknown as GraphEntityGetPayload, req) as TRes;
      case "graph.entity.set":
        return this.handleGraphEntitySet(payload as unknown as GraphEntitySetPayload, req) as TRes;
      case "graph.rel.add":
        return this.handleGraphRelAdd(payload as unknown as GraphRelAddPayload, req) as TRes;
      case "graph.rel.remove":
        return this.handleGraphRelRemove(payload as unknown as GraphRelRemovePayload, req) as TRes;
      case "graph.search":
        return this.handleGraphSearch(payload as unknown as GraphSearchPayload, req) as TRes;
      case "memory.capture":
        return this.handleMemoryCapture(payload, req) as TRes;
      case "memory.search":
        return this.handleMemorySearch(payload, req) as TRes;
      default:
        throw new Error(`Unsupported use-case: ${useCase}`);
    }
  }

  private handleSlotGet(payload: SlotGetPayload, req: CoreRequestEnvelope<unknown>) {
    if (payload.scope === "all") {
      const rows = allScopeIdentities(req.context).flatMap((identity) => {
        const result = this.slotDb.get(identity.userId, identity.agentId, {
          key: payload.key,
          category: payload.category,
        });

        if (!result) return [];
        const list = Array.isArray(result) ? result : [result];
        return list.map((slot) => ({
          key: slot.key,
          value: slot.value,
          category: slot.category,
          version: slot.version,
          scope: identity.scope,
        }));
      });

      if (payload.key) {
        return rows.length > 0 ? rows[0] : null;
      }

      return rows;
    }

    const identity = scopeToIdentity(req.context, payload.scope);
    const result = this.slotDb.get(identity.userId, identity.agentId, {
      key: payload.key,
      category: payload.category,
    });

    if (!result) return null;

    if (Array.isArray(result)) {
      return result.map((slot) => ({
        key: slot.key,
        value: slot.value,
        category: slot.category,
        version: slot.version,
        scope: identity.scope,
      }));
    }

    return {
      key: result.key,
      value: result.value,
      category: result.category,
      version: result.version,
      scope: identity.scope,
    };
  }

  private handleSlotSet(payload: SlotSetPayload, req: CoreRequestEnvelope<unknown>) {
    if (!payload.key || typeof payload.key !== "string") {
      throw new Error("slot.set requires payload.key");
    }

    const identity = scopeToIdentity(req.context, payload.scope);
    const slot = this.slotDb.set(identity.userId, identity.agentId, {
      key: payload.key,
      value: payload.value,
      category: payload.category,
      source: payload.source || "tool",
    });

    return {
      key: slot.key,
      value: slot.value,
      category: slot.category,
      version: slot.version,
      scope: identity.scope,
    };
  }

  private handleSlotList(payload: SlotListPayload, req: CoreRequestEnvelope<unknown>) {
    if (payload.scope === "all" || !payload.scope) {
      return allScopeIdentities(req.context).flatMap((identity) =>
        this.slotDb.list(identity.userId, identity.agentId, {
          category: payload.category,
          prefix: payload.prefix,
        }).map((slot) => ({
          key: slot.key,
          value: slot.value,
          category: slot.category,
          version: slot.version,
          scope: identity.scope,
        })),
      );
    }

    const identity = scopeToIdentity(req.context, payload.scope);
    return this.slotDb.list(identity.userId, identity.agentId, {
      category: payload.category,
      prefix: payload.prefix,
    }).map((slot) => ({
      key: slot.key,
      value: slot.value,
      category: slot.category,
      version: slot.version,
      scope: identity.scope,
    }));
  }

  private handleSlotDelete(payload: SlotDeletePayload, req: CoreRequestEnvelope<unknown>) {
    if (!payload.key || typeof payload.key !== "string") {
      throw new Error("slot.delete requires payload.key");
    }

    const identity = scopeToIdentity(req.context, payload.scope);
    return {
      key: payload.key,
      deleted: this.slotDb.delete(identity.userId, identity.agentId, payload.key),
      scope: identity.scope,
    };
  }

  private handleGraphEntityGet(payload: GraphEntityGetPayload, req: CoreRequestEnvelope<unknown>) {
    const identity = normalizePrivateIdentity(req.context);

    if (payload.id) {
      return this.slotDb.graph.getEntity(identity.userId, identity.agentId, payload.id);
    }

    return this.slotDb.graph.listEntities(identity.userId, identity.agentId, {
      type: payload.type,
      name: payload.name,
    });
  }

  private handleGraphEntitySet(payload: GraphEntitySetPayload, req: CoreRequestEnvelope<unknown>) {
    const identity = normalizePrivateIdentity(req.context);

    if (!payload.name || !payload.type) {
      throw new Error("graph.entity.set requires payload.name and payload.type");
    }

    if (payload.id) {
      const updated = this.slotDb.graph.updateEntity(identity.userId, identity.agentId, payload.id, {
        name: payload.name,
        type: payload.type,
        properties: payload.properties,
      });
      if (!updated) {
        throw new Error(`Entity with ID '${payload.id}' not found`);
      }
      return updated;
    }

    return this.slotDb.graph.createEntity(identity.userId, identity.agentId, {
      name: payload.name,
      type: payload.type,
      properties: payload.properties,
    });
  }

  private handleGraphRelAdd(payload: GraphRelAddPayload, req: CoreRequestEnvelope<unknown>) {
    const identity = normalizePrivateIdentity(req.context);

    if (!payload.source_id || !payload.target_id || !payload.relation_type) {
      throw new Error("graph.rel.add requires source_id, target_id, relation_type");
    }

    const source = this.slotDb.graph.getEntity(identity.userId, identity.agentId, payload.source_id);
    if (!source) throw new Error(`Source entity '${payload.source_id}' not found`);

    const target = this.slotDb.graph.getEntity(identity.userId, identity.agentId, payload.target_id);
    if (!target) throw new Error(`Target entity '${payload.target_id}' not found`);

    return this.slotDb.graph.createRelationship(identity.userId, identity.agentId, {
      source_entity_id: payload.source_id,
      target_entity_id: payload.target_id,
      relation_type: payload.relation_type,
      weight: payload.weight,
      properties: payload.properties,
    });
  }

  private handleGraphRelRemove(payload: GraphRelRemovePayload, req: CoreRequestEnvelope<unknown>) {
    const identity = normalizePrivateIdentity(req.context);

    if (payload.id) {
      return { deleted: this.slotDb.graph.deleteRelationship(identity.userId, identity.agentId, payload.id) };
    }

    if (!payload.source_id || !payload.target_id || !payload.relation_type) {
      throw new Error("graph.rel.remove requires id OR source_id + target_id + relation_type");
    }

    const rels = this.slotDb.graph.getRelationships(identity.userId, identity.agentId, payload.source_id, "outgoing");
    const rel = rels.find(
      (item) => item.target_entity_id === payload.target_id && item.relation_type === payload.relation_type,
    );

    if (!rel) {
      return { deleted: false };
    }

    return { deleted: this.slotDb.graph.deleteRelationship(identity.userId, identity.agentId, rel.id) };
  }

  private async handleMemoryCapture(payload: Record<string, unknown>, req: CoreRequestEnvelope<unknown>) {
    if (!this.semanticUseCase) {
      throw new Error("memory.capture is not available: semantic runtime dependencies are not wired");
    }
    return this.semanticUseCase.capture(payload as any, req.context);
  }

  private async handleMemorySearch(payload: Record<string, unknown>, req: CoreRequestEnvelope<unknown>) {
    if (!this.semanticUseCase) {
      throw new Error("memory.search is not available: semantic runtime dependencies are not wired");
    }
    return this.semanticUseCase.search(payload as any, req.context);
  }

  private handleGraphSearch(payload: GraphSearchPayload, req: CoreRequestEnvelope<unknown>) {
    const identity = normalizePrivateIdentity(req.context);

    if (!payload.entity_id) {
      throw new Error("graph.search requires entity_id");
    }

    const depth = Math.min(Math.max(payload.depth || 2, 1), 3);
    const traversed = this.slotDb.graph.traverseGraph(identity.userId, identity.agentId, payload.entity_id, depth);

    if (!payload.relation_type) {
      return traversed;
    }

    return {
      entities: traversed.entities,
      relationships: traversed.relationships.filter((rel) => rel.relation_type === payload.relation_type),
    };
  }
}
