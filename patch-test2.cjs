const fs = require('fs');
let code = fs.readFileSync('tests/test-semantic-memory-usecase.ts', 'utf8');

code = code.replace(
`		assert(
			existsSync(join(wikiRoot, "live", "entities", "assistant", "u1-s1.md")),
			"capture should materialize grouped live page",
		);
		assert(
			existsSync(join(wikiRoot, "briefings", "entities-assistant-u1-s1.md")),
			"capture should materialize briefing page",
		);`,
`		assert(
			existsSync(join(wikiRoot, "drafts", "entities", "assistant", "u1-s1.md")),
			"capture should materialize grouped draft page for raw",
		);`
);

code = code.replace(
`		const livePage = readFileSync(
			join(wikiRoot, "live", "entities", "assistant", "u1-s1.md"),
			"utf8",
		);
		assert(
			livePage.includes("memory_scope: agent"),
			"capture live page should include memory_scope=agent",
		);
		assert(
			livePage.includes("memory_type: episodic_trace"),
			"capture live page should include memory_type=episodic_trace",
		);
		assert(
			livePage.includes("promotion_state: raw"),
			"capture live page should include promotion_state=raw",
		);
		assert(
			livePage.includes("confidence:"),
			"capture live page should include confidence",
		);`,
`		const draftPage = readFileSync(
			join(wikiRoot, "drafts", "entities", "assistant", "u1-s1.md"),
			"utf8",
		);
		assert(
			draftPage.includes("memory_scope: agent"),
			"capture draft page should include memory_scope=agent",
		);
		assert(
			draftPage.includes("memory_type: episodic_trace"),
			"capture draft page should include memory_type=episodic_trace",
		);
		assert(
			draftPage.includes("promotion_state: raw"),
			"capture draft page should include promotion_state=raw",
		);
		assert(
			draftPage.includes("confidence:"),
			"capture draft page should include confidence",
		);`
);

fs.writeFileSync('tests/test-semantic-memory-usecase.ts', code);
console.log('patched');
