#!/usr/bin/env bash
set -euo pipefail

DIST_DIR="${HOME}/.openclaw/lib/node_modules/openclaw/dist"
MARKER_FILE="${DIST_DIR}/.asm44-patched"

PATCH_FILES=(
  "${DIST_DIR}/reply-CrwRmeCr.js"
  "${DIST_DIR}/reply-CYMZTXlH.js"
  "${DIST_DIR}/pi-embedded-8DITBEle.js"
  "${DIST_DIR}/pi-embedded-CM97XTkp.js"
)

if [[ -f "${MARKER_FILE}" ]]; then
  echo "[asm-44] marker exists, patch already applied: ${MARKER_FILE}"
  exit 0
fi

for f in "${PATCH_FILES[@]}"; do
  if [[ ! -f "${f}" ]]; then
    echo "[asm-44] missing target file: ${f}" >&2
    exit 1
  fi
done

python3 - <<'PY'
import re
from pathlib import Path

files = [
    Path.home() / '.openclaw/lib/node_modules/openclaw/dist/reply-CrwRmeCr.js',
    Path.home() / '.openclaw/lib/node_modules/openclaw/dist/reply-CYMZTXlH.js',
    Path.home() / '.openclaw/lib/node_modules/openclaw/dist/pi-embedded-8DITBEle.js',
    Path.home() / '.openclaw/lib/node_modules/openclaw/dist/pi-embedded-CM97XTkp.js',
]

replacement = r'''function extractToolResultText(result) {
	if (!result || typeof result !== "object") return;
	const record = result;
	const content = Array.isArray(record.content) ? record.content : null;
	if (content) {
		const texts = content.map((item) => {
			if (!item || typeof item !== "object") return;
			const entry = item;
			if (entry.type !== "text" || typeof entry.text !== "string") return;
			const trimmed = entry.text.trim();
			return trimmed ? trimmed : void 0;
		}).filter((value) => Boolean(value));
		if (texts.length > 0) return texts.join("\n");
	}
	// [ASM44_PATCH] fallback for runtimes where tool text is nested in details.toolResult
	const details = record.details;
	if (details && typeof details === "object") {
		const nested = details.toolResult;
		if (nested && typeof nested === "object") {
			if (typeof nested.text === "string") {
				const trimmed = nested.text.trim();
				if (trimmed) {
					console.debug("[ASM44] toolResult fallback via details.toolResult.text");
					return trimmed;
				}
			}
			const nestedContent = Array.isArray(nested.content) ? nested.content : null;
			if (nestedContent) {
				const nestedTexts = nestedContent.map((item) => {
					if (!item || typeof item !== "object") return;
					const entry = item;
					if (entry.type !== "text" || typeof entry.text !== "string") return;
					const trimmed = entry.text.trim();
					return trimmed ? trimmed : void 0;
				}).filter((value) => Boolean(value));
				if (nestedTexts.length > 0) {
					console.debug("[ASM44] toolResult fallback via details.toolResult.content");
					return nestedTexts.join("\n");
				}
			}
		}
	}
	return;
}
/**'''

pattern = re.compile(r'function extractToolResultText\(result\) \{[\s\S]*?\n\}\n/\*\*', re.MULTILINE)

for path in files:
    text = path.read_text(encoding='utf-8')
    if '[ASM44_PATCH]' in text:
        print(f'[asm-44] already patched: {path}')
        continue
    patched, count = pattern.subn(replacement, text, count=1)
    if count != 1:
        raise RuntimeError(f'patch failed for {path}: extractToolResultText block not found')
    path.write_text(patched, encoding='utf-8')
    print(f'[asm-44] patched: {path}')
PY

touch "${MARKER_FILE}"
echo "[asm-44] patch complete, marker created: ${MARKER_FILE}"