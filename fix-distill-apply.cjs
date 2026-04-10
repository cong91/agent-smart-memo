const fs = require('fs');
let code = fs.readFileSync('src/core/usecases/distill-apply-usecase.ts', 'utf8');

code = code.replace(
`					writeWikiMemoryCapture({
						text,
						namespace: memoryNamespace,
						sourceAgent: coreAgent,
						sourceType: "auto_capture",
						memoryScope: resolveMemoryScopeFromNamespace(memoryNamespace),
						memoryType: lifecycle.memoryType,
						confidence: lifecycle.confidence,
						sessionId: sessionKey,
						userId,
						metadata: {
							schema_version: MEMORY_FOUNDATION_SCHEMA_VERSION,
							promotion_state: lifecycle.promotionState,`,
`					writeWikiMemoryCapture({
						text,
						namespace: memoryNamespace,
						sourceAgent: coreAgent,
						sourceType: "auto_capture",
						memoryScope: resolveMemoryScopeFromNamespace(memoryNamespace),
						memoryType: lifecycle.memoryType,
						promotionState: lifecycle.promotionState,
						confidence: lifecycle.confidence,
						sessionId: sessionKey,
						userId,
						metadata: {
							schema_version: MEMORY_FOUNDATION_SCHEMA_VERSION,
							promotion_state: lifecycle.promotionState,`
);

fs.writeFileSync('src/core/usecases/distill-apply-usecase.ts', code);
console.log('patched');
