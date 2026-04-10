import fs from 'fs';
const file = 'src/hooks/auto-capture.ts';
let code = fs.readFileSync(file, 'utf8');

const importStatement = `import { DistillApplyUseCase } from "../core/usecases/distill-apply-usecase.js";\n`;
if (!code.includes('DistillApplyUseCase')) {
    code = code.replace(/import \{ writeWikiMemoryCapture.*?;\n/s, match => match + importStatement);
}

const usecaseInstantiation = `	const distillApply = new DistillApplyUseCase(db);\n`;
if (!code.includes('const distillApply')) {
    code = code.replace(/let actionCounter = 0;/, match => usecaseInstantiation + match);
}

fs.writeFileSync(file, code, 'utf8');
