const fs = require('fs');
const file = 'src/hooks/auto-capture.ts';
let code = fs.readFileSync(file, 'utf8');

// 1. Tool execution replace
const toolStart = `// Process slot removals first (manual tool parity with hook behavior)`;
const toolEnd = `details: { extracted, slotsStored, slotsRemoved },\n\t\t\t\t};\n`;
const toolReplaceRegex = new RegExp(toolStart.replace(/[.*+?^$\{}()|[\]\\]/g, '\\$&') + '[\\s\\S]*?' + toolEnd.replace(/[.*+?^$\{}()|[\]\\]/g, '\\$&'));

code = code.replace(toolReplaceRegex, `				const applyResult = distillApply.execute(extracted, {
					userId,
					agentId,
					sessionKey,
					minConfidence: cfg.minConfidence!,
				});

				return {
					content: [
						{
							type: "text",
							text: \`✅ Extraction complete!\\nMethod: \${params.use_llm !== false ? "LLM" : "Pattern"}\\nSlots stored: \${applyResult.slotsStored}\\nSlots removed: \${applyResult.slotsRemoved}\\n\\nExtracted:\\n\${JSON.stringify(extracted, null, 2)}\`,
						},
					],
					details: { extracted, slotsStored: applyResult.slotsStored, slotsRemoved: applyResult.slotsRemoved },
				};\n`);

// 2. Hook loop guard
const guardRegex = /			\/\/ 5-agent capture eligibility/;
code = code.replace(guardRegex, `			const eventMeta = (typedEvent?.metadata as Record<string, unknown>) || {};
			if (eventMeta.autoCaptureSkip === true || eventMeta.internalLifecycle === "distill_apply") {
				console.log("[AutoCapture] Skipping: event explicitly marked with non-capturable loop guard (autoCaptureSkip / distill_apply)");
				return;
			}

			// 5-agent capture eligibility`);

// 3. Hook apply replace
const hookStart = `// Process slot REMOVALS first (invalidation)`;
const hookEndStr = `// Auto-summarize project living state after every N actions OR task transition`;
const hookEnd = `			` + hookEndStr;
const hookReplaceRegex = new RegExp(`			` + hookStart.replace(/[.*+?^$\{}()|[\]\\]/g, '\\$&') + '[\\s\\S]*?(?=' + hookEndStr.replace(/[.*+?^$\{}()|[\]\\]/g, '\\$&') + ')');

code = code.replace(hookReplaceRegex, `			// Apply deterministic extraction results safely
			const applyResult = distillApply.execute(extracted, {
				userId,
				agentId,
				sessionKey,
				targetNamespace,
				minConfidence: cfg.minConfidence!,
			});

			const slotsRemoved = applyResult.slotsRemoved;
			const slotsStored = applyResult.slotsStored;
			const memoriesStored = applyResult.memoriesStored;

			// Save hash to SlotDB for next comparison
			db.set(userId, agentId, {
				key: hashKey,
				value: contentHash,
				category: "custom",
				source: "auto_capture",
				confidence: 1.0,
			});

			`);

fs.writeFileSync(file, code, 'utf8');
