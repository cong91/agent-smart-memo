const fs = require('fs');
let code = fs.readFileSync('src/hooks/auto-capture.ts', 'utf8');

code = code.replace(
`	writeWikiMemoryCapture({
		text: normalizedText,
		namespace,
		sourceAgent: toCoreAgent(sourceAgent),
		sourceType,
		memoryScope: resolveMemoryScopeFromNamespace(namespace),
		memoryType: lifecycle.memoryType,
		confidence: lifecycle.confidence,
		sessionId: (payloadExtras as any)?.session_id,
		userId: (payloadExtras as any)?.userId,
		metadata: {
			schema_version: MEMORY_FOUNDATION_SCHEMA_VERSION,
			promotion_state: lifecycle.promotionState,
			...((payloadExtras as any)?.metadata || {}),
		},
	});`,
`	writeWikiMemoryCapture({
		text: normalizedText,
		namespace,
		sourceAgent: toCoreAgent(sourceAgent),
		sourceType,
		memoryScope: resolveMemoryScopeFromNamespace(namespace),
		memoryType: lifecycle.memoryType,
		promotionState: lifecycle.promotionState,
		confidence: lifecycle.confidence,
		sessionId: (payloadExtras as any)?.session_id,
		userId: (payloadExtras as any)?.userId,
		metadata: {
			schema_version: MEMORY_FOUNDATION_SCHEMA_VERSION,
			promotion_state: lifecycle.promotionState,
			...((payloadExtras as any)?.metadata || {}),
		},
	});`
);

fs.writeFileSync('src/hooks/auto-capture.ts', code);
console.log('patched');
