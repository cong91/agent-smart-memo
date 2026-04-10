#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const REPO_DIR = '/Users/mrcagents/Work/projects/agent-smart-memo'
const RUNNER = '/Users/mrcagents/.openclaw/workspace/scripts/opencode-coding-runner.mjs'
const DEFAULT_SESSION = 'ses_2f891d808ffeYi94e0h5pGTsGy'
const ARTIFACT_DIR = path.join(REPO_DIR, 'artifacts/asm-122')

function parseArgs(argv) {
  const args = {
    session: DEFAULT_SESSION,
    startAt: 0,
    maxSteps: 10,
    stopOnFailure: true,
    dryRun: false,
  }

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    const next = argv[i + 1]
    switch (token) {
      case '--session':
        args.session = next || args.session
        i++
        break
      case '--start-at':
        args.startAt = Number(next || '0')
        i++
        break
      case '--max-steps':
        args.maxSteps = Number(next || '10')
        i++
        break
      case '--no-stop-on-failure':
        args.stopOnFailure = false
        break
      case '--dry-run':
        args.dryRun = true
        break
      default:
        break
    }
  }

  return args
}

const SLICE_DEFS = [
  {
    id: 'asm-119-121-bootstrap',
    title: 'ASM-122 slice1 ASM-119+121 bootstrap',
    message:
      'Không re-plan. Dùng patch-plan đã có trong session này. Tiếp tục/kiểm tra Slice 1 = ASM-119 + ASM-121 bootstrap và chỉ làm việc còn dang dở nếu có. Mục tiêu: thống nhất contract v2 nền (namespace/scope/type/promotion/confidence/source_type), hoàn thiện test bootstrap cho round-trip, alias parity, backward compatibility, rồi chạy build/test liên quan. Trả summary file đã sửa, test/build đã chạy, blocker còn lại, và readiness để chuyển sang ASM-118.',
  },
  {
    id: 'asm-118',
    title: 'ASM-122 slice2 ASM-118 session scope semantics',
    message:
      'Không re-plan. Dùng patch-plan đã có trong session này. Bây giờ code ASM-118: bỏ hard-filter session mặc định, chuyển sang strict mode hoặc soft boost đúng contract đã chốt. Bám các file/hàm đã map trước đó. Chạy test/build liên quan và trả summary file sửa, test/build, blocker, readiness để sang ASM-120.',
  },
  {
    id: 'asm-120',
    title: 'ASM-122 slice3 ASM-120 retrieval policy parity',
    message:
      'Không re-plan. Dùng patch-plan đã có trong session này. Bây giờ code ASM-120: unify auto-recall và tool search theo retrieval policy chung, tránh drift giữa tool path và hook/usecase path. Chạy test/build liên quan và trả summary file sửa, test/build, blocker, readiness để expand ASM-121.',
  },
  {
    id: 'asm-121-expand',
    title: 'ASM-122 slice4 ASM-121 parity expand',
    message:
      'Không re-plan. Dùng patch-plan đã có trong session này. Mở rộng ASM-121 cho parity sâu hơn: strict/non-strict session mode, shared retrieval, precedence-related checks nếu đã có nền. Chạy test/build liên quan và trả summary file sửa, test/build, blocker, readiness để sang ASM-115.',
  },
  {
    id: 'asm-115',
    title: 'ASM-122 slice5 ASM-115 migration-first safety',
    message:
      'Không re-plan. Dùng patch-plan đã có trong session này. Bây giờ làm ASM-115: migration-first payload/schema v2 + backfill/verify/rollback groundwork. Ưu tiên script/plan/checks migration-safe, không drift sang packaging/platformization. Chạy test/build/validation phù hợp và trả summary file sửa, verify evidence, blocker, readiness để sang ASM-117.',
  },
  {
    id: 'asm-117',
    title: 'ASM-122 slice6 ASM-117 precedence policy',
    message:
      'Không re-plan. Dùng patch-plan đã có trong session này. Bây giờ làm ASM-117: precedence rules giữa SlotDB, semantic memory và graph/context. Chốt current truth = SlotDB, semantic = evidence/history/lesson, graph = routing/ranking support. Chạy test/build liên quan và trả summary file sửa, verify evidence, blocker, readiness để sang ASM-116.',
  },
  {
    id: 'asm-116',
    title: 'ASM-122 slice7 ASM-116 promotion pipeline',
    message:
      'Không re-plan. Dùng patch-plan đã có trong session này. Bây giờ làm ASM-116: promotion pipeline raw -> distilled -> promoted dựa trên nền contract/retrieval/precedence đã có. Ưu tiên implementation sạch, tránh phình auto-capture vô tổ chức. Chạy test/build liên quan và trả summary file sửa, verify evidence, blocker, và đánh giá epic-level readiness.',
  },
]

function runSlice({ session, slice, artifactPath, dryRun }) {
  const cmd = [
    'node',
    RUNNER,
    '--dir',
    REPO_DIR,
    '--task-id',
    'ASM-122',
    '--session',
    session,
    '--title',
    slice.title,
    '--message',
    slice.message,
    '--out',
    artifactPath,
  ]

  if (dryRun) {
    return { dryRun: true, command: cmd }
  }

  const result = spawnSync(cmd[0], cmd.slice(1), {
    cwd: REPO_DIR,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  return {
    dryRun: false,
    command: cmd,
    exitCode: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  }
}

function readArtifact(artifactPath) {
  if (!fs.existsSync(artifactPath)) return null
  return JSON.parse(fs.readFileSync(artifactPath, 'utf8'))
}

function printSummary(index, slice, artifact, runResult) {
  console.log(`\n=== STEP ${index + 1}: ${slice.id} ===`)
  if (runResult.dryRun) {
    console.log('[dry-run]', runResult.command.join(' '))
    return
  }
  console.log('command:', runResult.command.join(' '))
  console.log('exitCode:', runResult.exitCode)
  if (artifact) {
    console.log('artifact:', artifact.evidence?.output_file || 'n/a')
    console.log('result:', artifact.result?.status || 'unknown')
    console.log('session_id:', artifact.opencode?.session_id || 'unknown')
    if (artifact.result?.error) console.log('error:', artifact.result.error)
    if (artifact.result?.stdout_preview) {
      console.log('stdout_preview:', String(artifact.result.stdout_preview).slice(0, 500))
    }
  } else {
    console.log('artifact: missing')
    if (runResult.stderr) console.log('stderr:', runResult.stderr.slice(0, 800))
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true })

  const selected = SLICE_DEFS.slice(args.startAt, args.startAt + args.maxSteps)
  const runState = {
    session: args.session,
    started_at: new Date().toISOString(),
    selected_steps: selected.map((s) => s.id),
    completed_steps: [],
    failed_steps: [],
  }

  for (let i = 0; i < selected.length; i++) {
    const slice = selected[i]
    const artifactPath = path.join(ARTIFACT_DIR, `${slice.id}.json`)
    const runResult = runSlice({ session: args.session, slice, artifactPath, dryRun: args.dryRun })
    const artifact = args.dryRun ? null : readArtifact(artifactPath)
    printSummary(args.startAt + i, slice, artifact, runResult)

    if (args.dryRun) continue

    if (runResult.exitCode === 0 && artifact?.result?.status === 'success') {
      runState.completed_steps.push({
        step: slice.id,
        artifact: artifactPath,
        session_id: artifact?.opencode?.session_id || null,
      })
      continue
    }

    runState.failed_steps.push({
      step: slice.id,
      exitCode: runResult.exitCode,
      artifactStatus: artifact?.result?.status || 'missing',
      artifactError: artifact?.result?.error || null,
      stderrPreview: runResult.stderr ? runResult.stderr.slice(0, 500) : null,
    })

    if (args.stopOnFailure) break
  }

  runState.finished_at = new Date().toISOString()
  const statePath = path.join(ARTIFACT_DIR, 'opencode-asm122-loop-state.json')
  fs.writeFileSync(statePath, JSON.stringify(runState, null, 2))
  console.log(`\nLoop state written to ${statePath}`)
}

main()
