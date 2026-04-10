const fs = require('fs');
let code = fs.readFileSync('tests/test-semantic-memory-usecase.ts', 'utf8');

code = code.replace(
`	assert(existsSync(livePath), "live path should exist");`,
`	assert(existsSync(livePath), "live path should exist");
	assert(existsSync(join(wikiRoot, capture1.rawPath)), "raw path should exist");`
);

fs.writeFileSync('tests/test-semantic-memory-usecase.ts', code);
console.log('patched');
