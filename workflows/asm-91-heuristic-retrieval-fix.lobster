name: asm-91-heuristic-retrieval-fix
description: "[ASM-91] Forensic + fix workflow for code-aware retrieval heuristic and tool-surface symbol persistence"
args:
  repoPath:
    default: "/Users/mrcagents/Work/projects/agent-smart-memo/.worktrees/asm-96-code-aware-rag-20260316"
  projectId:
    default: "4206a374-5070-470e-8f83-4d96a906acc8"
  reportArtifact:
    default: "docs/reports/asm-91-heuristic-retrieval-fix-status.json"

steps:
  - id: context
    command: |
      cd ${repoPath} && python3 - <<'PY'
      import json, subprocess
      def sh(cmd):
          return subprocess.check_output(cmd, shell=True, text=True).strip()
      print(json.dumps({
        "branch": sh("git branch --show-current"),
        "head": sh("git rev-parse --short HEAD"),
        "repoPath": sh("pwd")
      }))
      PY

  - id: inspect-current-symbol-coverage
    command: |
      python3 - <<'PY'
      import sqlite3, json
      db='/Users/mrcagents/.openclaw/agent-memo/slots.db'
      project_id='${projectId}'
      conn=sqlite3.connect(db)
      conn.row_factory=sqlite3.Row
      cur=conn.cursor()
      out={}
      for label, needle in [
          ("project_hybrid_search", "%project_hybrid_search%"),
          ("project_task_lineage_context", "%project_task_lineage_context%")
      ]:
          cur.execute("SELECT relative_path,symbol_name,symbol_fqn,symbol_kind,indexed_at FROM symbol_registry WHERE project_id=? AND scope_user_id=? AND scope_agent_id=? AND active=1 AND (lower(symbol_name) LIKE lower(?) OR lower(symbol_fqn) LIKE lower(?)) ORDER BY relative_path,symbol_name", (project_id,'default','main',needle,needle))
          out[label]=[dict(r) for r in cur.fetchall()]
      conn.close()
      print(json.dumps(out))
      PY

  - id: extractor-direct-dump
    command: |
      cd ${repoPath} && node - <<'NODE'
      import { readFileSync } from 'node:fs';
      import { extractSemanticBlocks } from './dist-openclaw/core/ingest/semantic-block-extractor.js';
      import { buildFileId } from './dist-openclaw/core/ingest/ids.js';
      import { buildChunkArtifacts } from './dist-openclaw/core/ingest/ingest-pipeline.js';
      const projectId = '${projectId}';
      const relativePath = 'src/tools/project-tools.ts';
      const content = readFileSync(relativePath, 'utf8');
      const blocks = extractSemanticBlocks({ relativePath, content });
      const fileId = buildFileId(projectId, relativePath);
      const chunks = buildChunkArtifacts(projectId, fileId, relativePath, blocks);
      const names = ['project_hybrid_search','project_task_lineage_context'];
      const result = {
        targetBlocks: blocks.filter(b => names.includes(String(b.symbol_name || ''))),
        targetChunks: chunks.filter(c => names.some(n => String(c.semantic_path || '').includes(n)))
      };
      console.log(JSON.stringify(result));
      NODE

  - id: build-openclaw
    command: |
      cd ${repoPath} && npm run build:openclaw

  - id: sync-plugin-runtime
    command: |
      cd ${repoPath} && python3 - <<'PY'
      import os, shutil, json
      repo=os.getcwd()
      ext='/Users/mrcagents/.openclaw/extensions/agent-smart-memo'
      src=os.path.join(repo,'dist-openclaw')
      dst=os.path.join(ext,'dist')
      if os.path.exists(dst):
          shutil.rmtree(dst)
      os.makedirs(ext, exist_ok=True)
      shutil.copytree(src, dst)
      for f in ['openclaw.plugin.json','package.json','README.md','CONFIG.example.json','LICENSE']:
          shutil.copy2(os.path.join(repo,f), os.path.join(ext,f))
      print(json.dumps({"extension": ext, "synced": True}))
      PY

  - id: restart-gateway
    command: |
      openclaw gateway restart

  - id: trigger-reindex
    command: |
      cd ${repoPath} && node - <<'NODE'
      const { SlotDB } = await import('./dist-openclaw/db/slot-db.js');
      const { DefaultMemoryUseCasePort } = await import('./dist-openclaw/core/usecases/default-memory-usecase-port.js');
      const db = new SlotDB('/Users/mrcagents/.openclaw/agent-memo');
      const usecase = new DefaultMemoryUseCasePort(db);
      const result = await usecase.run('project.trigger_index', {
        context: { userId: 'default', agentId: 'main' },
        meta: { source: 'lobster' },
        payload: {
          project_ref: { project_id: '${projectId}' },
          mode: 'repair',
          reason: 'asm91_heuristic_retrieval_fix',
          source_rev: 'lobster-asm91',
          paths: [
            { relative_path: 'src/core/ingest/contracts.ts', checksum: 'lobster-c1', module: 'src/core/ingest', language: 'ts' },
            { relative_path: 'src/core/ingest/ingest-pipeline.ts', checksum: 'lobster-c2', module: 'src/core/ingest', language: 'ts' },
            { relative_path: 'src/core/ingest/semantic-block-extractor.ts', checksum: 'lobster-c3', module: 'src/core/ingest', language: 'ts' },
            { relative_path: 'src/tools/project-tools.ts', checksum: 'lobster-c4', module: 'src/tools', language: 'ts' }
          ]
        }
      });
      console.log(JSON.stringify(result));
      NODE

  - id: verify-post-reindex
    command: |
      python3 - <<'PY'
      import sqlite3, json, time
      db='/Users/mrcagents/.openclaw/agent-memo/slots.db'
      project_id='${projectId}'
      out=[]
      for i in range(10):
          conn=sqlite3.connect(db)
          conn.row_factory=sqlite3.Row
          cur=conn.cursor()
          cur.execute("SELECT run_id,trigger_type,state,started_at,finished_at,error_message FROM index_runs WHERE project_id=? AND scope_user_id=? AND scope_agent_id=? ORDER BY started_at DESC LIMIT 3", (project_id,'default','main'))
          runs=[dict(r) for r in cur.fetchall()]
          cur.execute("SELECT relative_path,symbol_name,symbol_fqn,symbol_kind,indexed_at FROM symbol_registry WHERE project_id=? AND scope_user_id=? AND scope_agent_id=? AND active=1 AND (lower(symbol_name) LIKE lower(?) OR lower(symbol_fqn) LIKE lower(?)) ORDER BY relative_path,symbol_name", (project_id,'default','main','%project_hybrid_search%','%project_hybrid_search%'))
          hybrid=[dict(r) for r in cur.fetchall()]
          cur.execute("SELECT relative_path,symbol_name,symbol_fqn,symbol_kind,indexed_at FROM symbol_registry WHERE project_id=? AND scope_user_id=? AND scope_agent_id=? AND active=1 AND (lower(symbol_name) LIKE lower(?) OR lower(symbol_fqn) LIKE lower(?)) ORDER BY relative_path,symbol_name", (project_id,'default','main','%project_task_lineage_context%','%project_task_lineage_context%'))
          lineage=[dict(r) for r in cur.fetchall()]
          conn.close()
          snap={"iter":i,"runs":runs,"project_hybrid_search":hybrid,"project_task_lineage_context":lineage}
          out.append(snap)
          if hybrid or lineage:
              break
          time.sleep(1)
      print(json.dumps(out))
      PY

  - id: retrieval-probes
    command: |
      cd ${repoPath} && node - <<'NODE'
      const { SlotDB } = await import('./dist-openclaw/db/slot-db.js');
      const { DefaultMemoryUseCasePort } = await import('./dist-openclaw/core/usecases/default-memory-usecase-port.js');
      const db = new SlotDB('/Users/mrcagents/.openclaw/agent-memo');
      const usecase = new DefaultMemoryUseCasePort(db);
      const project_id='${projectId}';
      const out={};
      for (const q of ['project_hybrid_search','project_task_lineage_context']) {
        out[q] = await usecase.run('project.hybrid_search', {
          context: { userId: 'default', agentId: 'main' },
          meta: { source: 'lobster' },
          payload: { project_id, query: q, limit: 8, task_id: 'ASM-91' }
        });
      }
      console.log(JSON.stringify(out));
      NODE

  - id: consolidate
    command: |
      cd ${repoPath} && python3 - <<'PY'
      import json, os
      payload = {
        "workflow": "asm-91-heuristic-retrieval-fix",
        "context": json.loads('''$context.stdout'''),
        "symbolCoverageBefore": json.loads('''$inspect-current-symbol-coverage.stdout'''),
        "extractorDump": json.loads('''$extractor-direct-dump.stdout'''),
        "syncPlugin": json.loads('''$sync-plugin-runtime.stdout'''),
        "reindexTrigger": json.loads('''$trigger-reindex.stdout'''),
        "postReindexVerification": json.loads('''$verify-post-reindex.stdout'''),
        "retrievalProbes": json.loads('''$retrieval-probes.stdout''')
      }
      path='${reportArtifact}'
      os.makedirs(os.path.dirname(path), exist_ok=True)
      with open(path,'w',encoding='utf-8') as f:
        json.dump(payload,f,ensure_ascii=False,indent=2)
      print(json.dumps({"reportArtifact": path, "status": "captured"}))
      PY
