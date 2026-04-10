const fs = require('fs');
let code = fs.readFileSync('tests/test-semantic-memory-usecase.ts', 'utf8');

code = code.replace(
`		const { writeWikiMemoryCapture } = require("../src/core/usecases/semantic-memory-usecase.js");`,
``
);

code = code.replace(
`import { SemanticMemoryUseCase } from "../src/core/usecases/semantic-memory-usecase.js";`,
`import { SemanticMemoryUseCase, writeWikiMemoryCapture } from "../src/core/usecases/semantic-memory-usecase.js";`
);

fs.writeFileSync('tests/test-semantic-memory-usecase.ts', code);
console.log('patched');
