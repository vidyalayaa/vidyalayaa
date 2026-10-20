import ts from 'typescript';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
let failures = 0,
  count = 0;
async function scan(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.pio', 'build', 'secrets'].includes(entry.name)) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await scan(file);
      continue;
    }
    if (!/\.(ts|tsx|mjs|cpp|h)$/.test(file)) continue;
    const source = await readFile(file, 'utf8');
    count++;
    const flag = (message) => {
      console.error(`${file}: ${message}`);
      failures++;
    };
    if (/@ts-ignore/.test(source)) flag('Use a typed boundary instead of suppressing TypeScript.');
    if (/\.(cpp|h)$/.test(file)) {
      const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, '');
      if (/\bsetInsecure\s*\(/.test(code)) flag('Device TLS verification must stay enabled.');
      continue;
    }
    const tree = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    function walk(node) {
      if (
        (ts.isCallExpression(node) || ts.isNewExpression(node)) &&
        ts.isIdentifier(node.expression) &&
        ['eval', 'Function'].includes(node.expression.text)
      )
        flag('Dynamic code execution is prohibited.');
      if (ts.isJsxAttribute(node) && node.name.getText(tree) === 'dangerouslySetInnerHTML')
        flag('Render structured content through a safe component.');
      ts.forEachChild(node, walk);
    }
    walk(tree);
  }
}
for (const dir of [
  'apps/api/src',
  'apps/web/src',
  'apps/worker/src',
  'packages/contracts/src',
  'firmware/src',
  'firmware/include',
  'firmware-production/core',
  'firmware-production/main',
])
  await scan(dir);
if (failures) process.exitCode = 1;
else
  console.log(
    `Lint passed: ${count} source files; dynamic execution, unsafe HTML, TLS and suppression rules.`,
  );
