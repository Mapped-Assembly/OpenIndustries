import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileSpaceIR } from '../src/lib/space-ir-compiler';
import { makeManifest, readManifest } from '../src/lib/workspace';

const source = fileURLToPath(new URL('../packages/space-ir/fixtures/SPACE-001.json', import.meta.url));
const output = resolve(process.argv[2] ?? 'deliverables/space-ir/SPACE-001.oi.json');
const result = await compileSpaceIR(JSON.parse(await readFile(source, 'utf8')));
const manifest = readManifest(makeManifest(result.workspace, true));
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({
  file: output, document_sha256: result.source_sha256,
  scene_instances: result.workspace.items.length, diagnostics: result.diagnostics,
}, null, 2));
