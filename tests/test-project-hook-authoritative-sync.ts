import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message}\nactual=${a}\nexpected=${e}`);
}

async function main() {
  const ROOT = mkdtempSync(join(tmpdir(), "agent-memo-hook-authoritative-"));
  const REPO = join(ROOT, "repo");
  const HOOKS = join(REPO, ".git", "hooks");
  mkdirSync(HOOKS, { recursive: true });
  writeFileSync(join(HOOKS, "post-commit"), "#!/bin/sh\necho existing-post-commit\n", "utf8");
  writeFileSync(join(HOOKS, "post-merge"), "#!/bin/sh\necho existing-post-merge\n", "utf8");

  const { SlotDB } = await import("../dist/db/slot-db.js");
  const { DefaultMemoryUseCasePort } = await import("../dist/core/usecases/default-memory-usecase-port.js");
  const db = new SlotDB(join(ROOT, "slotdb"));
  const usecase = new DefaultMemoryUseCasePort(db as any);

  try {
    await usecase.run<any, any>("project.register", {
      context: { userId: "u", agentId: "a" },
      payload: {
        project_id: "p1",
        project_alias: "repo",
        project_name: "repo",
        repo_root: REPO,
      },
      meta: { source: "test", toolName: "project.register" },
    });

    {
      const result = await usecase.run<any, any>("project.install_hooks", {
        context: { userId: "u", agentId: "a" },
        payload: { project_id: "p1" },
        meta: { source: "test", toolName: "project.install_hooks" },
      });

      const postCommit = readFileSync(join(HOOKS, "post-commit"), "utf8");
      const postMerge = readFileSync(join(HOOKS, "post-merge"), "utf8");
      const postRewrite = readFileSync(join(HOOKS, "post-rewrite"), "utf8");
      const listener = readFileSync(join(HOOKS, "asm-project-event.sh"), "utf8");

      assert(result.installed === true, "hooks should install");
      assert(postCommit.includes("existing-post-commit"), "post-commit existing content must remain");
      assert(postMerge.includes("existing-post-merge"), "post-merge existing content must remain");
      assert(postCommit.includes("ASM_AUTO_INDEX_HOOK"), "post-commit should attach listener");
      assert(postMerge.includes("ASM_AUTO_INDEX_HOOK"), "post-merge should attach listener");
      assert(postRewrite.includes("ASM_AUTO_INDEX_HOOK"), "post-rewrite should attach listener");
      assert(listener.includes('EVENT_TYPE="$1"'), "listener should read event type");
      assert(listener.includes('TRUSTED_SYNC="0"'), "listener should initialize trusted sync gate");
      assert(listener.includes('git ls-files'), "listener should gather full snapshot for trusted sync");
      assert(listener.includes('--trusted-sync "$TRUSTED_SYNC"'), "listener should forward trusted sync flag");
      assert(listener.includes('--full-snapshot "$FULL_SNAPSHOT"'), "listener should forward full snapshot flag");
      console.log("✅ project.install_hooks appends listeners and preserves existing hook content");
    }

    {
      const initial = await usecase.run<any, any>("project.index_event", {
        context: { userId: "u", agentId: "a" },
        payload: {
          project_id: "p1",
          repo_root: REPO,
          event_type: "post_commit",
          source_rev: "abc123",
          changed_files: ["src/a.ts"],
          deleted_files: [],
        },
        meta: { source: "test", toolName: "project.index_event" },
      });

      const authoritative = await usecase.run<any, any>("project.index_event", {
        context: { userId: "u", agentId: "a" },
        payload: {
          project_id: "p1",
          repo_root: REPO,
          event_type: "post_merge",
          source_rev: "def456",
          trusted_sync: true,
          full_snapshot: true,
          changed_files: ["src/a.ts", "src/b.ts"],
          deleted_files: [],
        },
        meta: { source: "test", toolName: "project.index_event" },
      });

      assertEqual(initial.trusted_sync, false, "commit path should be non-trusted");
      assertEqual(initial.reindex.trigger_type, "incremental", "commit path should remain incremental");
      assertEqual(authoritative.trusted_sync, true, "trusted sync flag should roundtrip");
      assertEqual(authoritative.full_snapshot, true, "trusted sync should force full snapshot");
      assertEqual(authoritative.reindex.trigger_type, "repair", "trusted sync should use authoritative trigger type");
      assertEqual(authoritative.reindex.index_profile, "authoritative", "trusted sync should use authoritative profile");
      console.log("✅ project.index_event uses authoritative reindex when trusted sync is true");
    }

    {
      let mismatchError = "";
      try {
        await usecase.run<any, any>("project.index_event", {
          context: { userId: "u", agentId: "a" },
          payload: {
            project_id: "p1",
            repo_root: join(ROOT, "wrong-repo"),
            event_type: "post_merge",
            source_rev: "zzz999",
            trusted_sync: true,
            full_snapshot: true,
            changed_files: ["src/c.ts"],
            deleted_files: [],
          },
          meta: { source: "test", toolName: "project.index_event" },
        });
      } catch (error) {
        mismatchError = error instanceof Error ? error.message : String(error);
      }
      assert(mismatchError.includes("repo_root mismatch"), "repo_root mismatch must reject index event");
      console.log("✅ project.index_event rejects mismatched repo_root");
    }

    console.log("\n🎉 project hook authoritative sync tests passed");
  } finally {
    try { db.close(); } catch {}
    try { rmSync(ROOT, { recursive: true, force: true }); } catch {}
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
