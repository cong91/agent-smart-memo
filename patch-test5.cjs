const fs = require('fs');
let code = fs.readFileSync('tests/test-semantic-memory-usecase.ts', 'utf8');

code = code.replace(
`		const projectLivePage = readFileSync(
			join(wikiRoot, "live", "projects", "u1", "s1.md"),
			"utf8",
		);`,
`		const projectLivePage = readFileSync(
			join(wikiRoot, "drafts", "projects", "u1", "s1.md"),
			"utf8",
		);`
);

fs.writeFileSync('tests/test-semantic-memory-usecase.ts', code);
console.log('patched');
