#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DIST_DIR="${HOME}/.openclaw/lib/node_modules/openclaw/dist"
MARKER_FILE="${DIST_DIR}/.asm44-patched"

cd "${REPO_DIR}"

echo "[rollback] restoring src/hooks/auto-recall.ts from git"
git restore src/hooks/auto-recall.ts

echo "[rollback] rebuilding agent-smart-memo"
npm run build

echo "[rollback] removing ASM-44 marker (if present)"
rm -f "${MARKER_FILE}"

echo "[rollback] done"
