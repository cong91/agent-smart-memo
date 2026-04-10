const fs = require('fs');
let code = fs.readFileSync('src/core/usecases/semantic-memory-usecase.ts', 'utf8');

// 1. WikiMemoryWriteResult
code = code.replace(
`	rawPath: string;
	livePath: string;
	briefingPath: string;`,
`	rawPath: string;
	draftPath: string;
	livePath: string;
	briefingPath: string;`
);

// 2. ensureWikiBootstrap
code = code.replace(
`	const dirs = [
		join(wikiRoot, "raw"),
		join(wikiRoot, "live", "projects"),
		join(wikiRoot, "live", "concepts"),
		join(wikiRoot, "live", "entities"),
		join(wikiRoot, "briefings"),
	];`,
`	const dirs = [
		join(wikiRoot, "raw"),
		join(wikiRoot, "drafts", "projects"),
		join(wikiRoot, "drafts", "concepts"),
		join(wikiRoot, "drafts", "entities"),
		join(wikiRoot, "live", "projects"),
		join(wikiRoot, "live", "concepts"),
		join(wikiRoot, "live", "entities"),
		join(wikiRoot, "briefings"),
	];`
);

code = code.replace(
`				"- \`raw/\`: append-only capture artifacts.",
				"- \`live/\`: canonical grouped pages used for wiki-first semantic recall.",`,
`				"- \`raw/\`: append-only capture artifacts.",
				"- \`drafts/\`: intermediary layer before promotion to live.",
				"- \`live/\`: canonical grouped pages used for wiki-first semantic recall.",`
);

// 3. resolveWikiGroupingPaths
code = code.replace(
`function resolveWikiGroupingPaths(input: WikiMemoryWriteInput): {
	liveRelPath: string;
	briefingRelPath: string;
	rawRelPath: string;
	title: string;
} {`,
`function resolveWikiGroupingPaths(input: WikiMemoryWriteInput): {
	liveRelPath: string;
	draftRelPath: string;
	briefingRelPath: string;
	rawRelPath: string;
	title: string;
} {`
);

code = code.replace(
`			liveRelPath: \`live/projects/\${userSlug}/\${sessionSlug}.md\`,
			briefingRelPath: \`briefings/project-\${userSlug}-\${sessionSlug}.md\`,
			rawRelPath: \`raw/\${dateKey}/project-\${userSlug}-\${sessionSlug}.md\`,`,
`			liveRelPath: \`live/projects/\${userSlug}/\${sessionSlug}.md\`,
			draftRelPath: \`drafts/projects/\${userSlug}/\${sessionSlug}.md\`,
			briefingRelPath: \`briefings/project-\${userSlug}-\${sessionSlug}.md\`,
			rawRelPath: \`raw/\${dateKey}/project-\${userSlug}-\${sessionSlug}.md\`,`
);

code = code.replace(
`			liveRelPath: \`live/concepts/\${agentSlug}/\${userSlug}-\${sessionSlug}.md\`,
			briefingRelPath: \`briefings/concepts-\${agentSlug}-\${userSlug}-\${sessionSlug}.md\`,
			rawRelPath: \`raw/\${dateKey}/concepts-\${agentSlug}-\${userSlug}-\${sessionSlug}.md\`,`,
`			liveRelPath: \`live/concepts/\${agentSlug}/\${userSlug}-\${sessionSlug}.md\`,
			draftRelPath: \`drafts/concepts/\${agentSlug}/\${userSlug}-\${sessionSlug}.md\`,
			briefingRelPath: \`briefings/concepts-\${agentSlug}-\${userSlug}-\${sessionSlug}.md\`,
			rawRelPath: \`raw/\${dateKey}/concepts-\${agentSlug}-\${userSlug}-\${sessionSlug}.md\`,`
);

code = code.replace(
`		liveRelPath: \`live/entities/\${agentSlug}/\${userSlug}-\${sessionSlug}.md\`,
		briefingRelPath: \`briefings/entities-\${agentSlug}-\${userSlug}-\${sessionSlug}.md\`,
		rawRelPath: \`raw/\${dateKey}/entities-\${agentSlug}-\${userSlug}-\${sessionSlug}.md\`,`,
`		liveRelPath: \`live/entities/\${agentSlug}/\${userSlug}-\${sessionSlug}.md\`,
		draftRelPath: \`drafts/entities/\${agentSlug}/\${userSlug}-\${sessionSlug}.md\`,
		briefingRelPath: \`briefings/entities-\${agentSlug}-\${userSlug}-\${sessionSlug}.md\`,
		rawRelPath: \`raw/\${dateKey}/entities-\${agentSlug}-\${userSlug}-\${sessionSlug}.md\`,`
);

// 4. writeWikiMemoryCapture
let writeFuncBefore = `	const existingLiveRaw = existsSync(liveAbsPath)
		? readFileSync(liveAbsPath, "utf8")
		: "";
	const existingLive = parseWikiFrontmatter(existingLiveRaw);
	const liveUpsert = upsertWikiMemoryEntry(
		existingLive.body,
		id,
		buildWikiMemoryEntry(input, id, timestampIso),
	);

	const liveFrontmatter: WikiFrontmatter = {
		title: paths.title,
		namespace: input.namespace,
		sessionId: input.sessionId,
		userId: input.userId,
		source_agent: input.sourceAgent,
		timestamp: existingLive.frontmatter.timestamp || timestampIso,
		updatedAt: updatedAtIso,
	};
	writeMarkdownFile(
		liveAbsPath,
		liveFrontmatter,
		\`# \${paths.title}\\n\\n\${liveUpsert.body}\`,
	);

	const refreshedEntries = parseWikiMemoryEntries(
		parseWikiFrontmatter(readFileSync(liveAbsPath, "utf8")).body,
	).sort(compareEntriesDeterministically);
	const briefingBody = [
		\`# \${paths.title} Briefing\`,
		"",
		...refreshedEntries
			.slice(0, 5)
			.map(
				(entry) =>
					\`- \${entry.timestamp || timestampIso} — \${entry.text.replace(/\\s+/g, " ").slice(0, 280)}\`,
			),
	].join("\\n");
	writeMarkdownFile(
		briefingAbsPath,
		{
			title: \`\${paths.title} Briefing\`,
			namespace: input.namespace,
			sessionId: input.sessionId,
			userId: input.userId,
			source_agent: input.sourceAgent,
			timestamp: timestampIso,
			updatedAt: updatedAtIso,
		},
		briefingBody,
	);

	const rawFrontmatter: WikiFrontmatter = {`;

let writeFuncAfter = `	const draftAbsPath = join(wikiRoot, paths.draftRelPath);

	const isLive = ["distilled", "promoted"].includes(input.promotionState || "raw");
	const isDraft = ["raw", "draft"].includes(input.promotionState || "raw");

	let actionUpsert = { updated: false, body: "" };

	if (isLive) {
		const existingLiveRaw = existsSync(liveAbsPath)
			? readFileSync(liveAbsPath, "utf8")
			: "";
		const existingLive = parseWikiFrontmatter(existingLiveRaw);
		actionUpsert = upsertWikiMemoryEntry(
			existingLive.body,
			id,
			buildWikiMemoryEntry(input, id, timestampIso),
		);

		const liveFrontmatter: WikiFrontmatter = {
			title: paths.title,
			namespace: input.namespace,
			sessionId: input.sessionId,
			userId: input.userId,
			source_agent: input.sourceAgent,
			timestamp: existingLive.frontmatter.timestamp || timestampIso,
			updatedAt: updatedAtIso,
		};
		writeMarkdownFile(
			liveAbsPath,
			liveFrontmatter,
			\`# \${paths.title}\\n\\n\${actionUpsert.body}\`,
		);

		const refreshedEntries = parseWikiMemoryEntries(
			parseWikiFrontmatter(readFileSync(liveAbsPath, "utf8")).body,
		).sort(compareEntriesDeterministically);
		const briefingBody = [
			\`# \${paths.title} Briefing\`,
			"",
			...refreshedEntries
				.slice(0, 5)
				.map(
					(entry) =>
						\`- \${entry.timestamp || timestampIso} — \${entry.text.replace(/\\s+/g, " ").slice(0, 280)}\`,
				),
		].join("\\n");
		writeMarkdownFile(
			briefingAbsPath,
			{
				title: \`\${paths.title} Briefing\`,
				namespace: input.namespace,
				sessionId: input.sessionId,
				userId: input.userId,
				source_agent: input.sourceAgent,
				timestamp: timestampIso,
				updatedAt: updatedAtIso,
			},
			briefingBody,
		);
	} else if (isDraft) {
		const existingDraftRaw = existsSync(draftAbsPath)
			? readFileSync(draftAbsPath, "utf8")
			: "";
		const existingDraft = parseWikiFrontmatter(existingDraftRaw);
		actionUpsert = upsertWikiMemoryEntry(
			existingDraft.body,
			id,
			buildWikiMemoryEntry(input, id, timestampIso),
		);

		const draftFrontmatter: WikiFrontmatter = {
			title: \`\${paths.title} Draft\`,
			namespace: input.namespace,
			sessionId: input.sessionId,
			userId: input.userId,
			source_agent: input.sourceAgent,
			timestamp: existingDraft.frontmatter.timestamp || timestampIso,
			updatedAt: updatedAtIso,
		};
		writeMarkdownFile(
			draftAbsPath,
			draftFrontmatter,
			\`# \${paths.title} Draft\\n\\n\${actionUpsert.body}\`,
		);
	}

	const rawFrontmatter: WikiFrontmatter = {`;

code = code.replace(writeFuncBefore, writeFuncAfter);

code = code.replace(
`	refreshWikiIndex(
		wikiRoot,
		paths.title,
		paths.liveRelPath,
		paths.briefingRelPath,
	);
	appendWikiLog(
		wikiRoot,
		\`- \${timestampIso} | \${liveUpsert.updated ? "updated" : "created"} | \${input.namespace} | \${id} | \${paths.liveRelPath}\`,
	);

	return {
		id,
		created: !liveUpsert.updated,
		updated: liveUpsert.updated,
		namespace: input.namespace,
		wikiRoot,
		rawPath: paths.rawRelPath,
		livePath: paths.liveRelPath,
		briefingPath: paths.briefingRelPath,
	};`,
`	if (isLive) {
		refreshWikiIndex(
			wikiRoot,
			paths.title,
			paths.liveRelPath,
			paths.briefingRelPath,
		);
	}

	const targetRelPath = isLive ? paths.liveRelPath : paths.draftRelPath;
	appendWikiLog(
		wikiRoot,
		\`- \${timestampIso} | \${actionUpsert.updated ? "updated" : "created"} | \${input.namespace} | \${id} | \${targetRelPath}\`,
	);

	return {
		id,
		created: !actionUpsert.updated,
		updated: actionUpsert.updated,
		namespace: input.namespace,
		wikiRoot,
		rawPath: paths.rawRelPath,
		draftPath: paths.draftRelPath,
		livePath: paths.liveRelPath,
		briefingPath: paths.briefingRelPath,
	};`
);

// 5. loadWikiDocuments folders
code = code.replace(
`	for (const folder of ["briefings", "live"]) {`,
`	for (const folder of ["briefings", "live", "drafts"]) {`
);

// 6. inferNamespaceFromWikiPath
code = code.replace(
`	if (normalized.startsWith("briefings/")) {
		return "shared.project_context";
	}
	if (normalized.startsWith("live/projects/")) {
		return "shared.project_context";
	}
	if (normalized.startsWith("live/concepts/")) {
		return \`agent.\${sourceAgent}.lessons\` as MemoryNamespace;
	}
	if (normalized.startsWith("live/entities/")) {
		return \`agent.\${sourceAgent}.working_memory\` as MemoryNamespace;
	}`,
`	if (normalized.startsWith("briefings/")) {
		return "shared.project_context";
	}
	if (normalized.startsWith("live/projects/") || normalized.startsWith("drafts/projects/")) {
		return "shared.project_context";
	}
	if (normalized.startsWith("live/concepts/") || normalized.startsWith("drafts/concepts/")) {
		return \`agent.\${sourceAgent}.lessons\` as MemoryNamespace;
	}
	if (normalized.startsWith("live/entities/") || normalized.startsWith("drafts/entities/")) {
		return \`agent.\${sourceAgent}.working_memory\` as MemoryNamespace;
	}`
);

fs.writeFileSync('src/core/usecases/semantic-memory-usecase.ts', code);
console.log('patched');
