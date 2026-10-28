import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../../../../recipes/rstrbot/BUILD_PROMPT.md', import.meta.url));
const snapshot = fileURLToPath(new URL('../../docs/RECIPE_BUILD_PROMPT.md', import.meta.url));
let content;
try { content = await fs.readFile(source, 'utf8'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (content !== undefined) {
  await fs.writeFile(snapshot, content);
  process.stdout.write('Synced the embedded Recipkg build prompt.\n');
} else {
  await fs.access(snapshot);
  process.stdout.write('Using the bundled Recipkg build prompt snapshot.\n');
}
