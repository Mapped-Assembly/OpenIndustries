import { oiEnv } from '../server/oi-environment.mjs';
/** Trusted local file bridge; MCP arguments never accept arbitrary filesystem paths. */
import { readFile, writeFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { LocalSceneBackend } from '../server/local-scene-backend.ts';
import { LOCAL_ASSET_MAX_BYTES } from '../server/local-asset-limits.ts';
import { parseCloudBundle } from '../src/lib/cloud-storage.ts';
import { loadEnv } from './session.mjs';

loadEnv(process.cwd());
const [command, input, output, revisionText] = process.argv.slice(2);
if (!input || !['import-asset', 'export'].includes(command) || (command === 'export' && !output))
  throw new Error('Usage: node --import tsx cli/local-scenes.ts import-asset asset.json | export SCENE_UUID scene.json [REVISION]');
const revision = revisionText === undefined ? undefined : Number(revisionText);
if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) throw new Error('Revision must be a positive integer.');
const backend = new LocalSceneBackend(resolve(oiEnv('SCENE_DATA_DIR') || '.astra/scenes'));
try {
  if (command === 'import-asset') {
    if ((await stat(input)).size > LOCAL_ASSET_MAX_BYTES) throw new Error('Asset bundle exceeds 128 MiB.');
    const text = await readFile(input, 'utf8');
    if (Buffer.byteLength(text) > LOCAL_ASSET_MAX_BYTES) throw new Error('Asset bundle exceeds 128 MiB.');
    const asset = parseCloudBundle(text).asset;
    console.log(JSON.stringify({ kind: 'local', version_id: await backend.persistAsset(asset) }));
  } else {
    const text = JSON.stringify(await backend.exportScene(input, revision));
    if (Buffer.byteLength(text) > LOCAL_ASSET_MAX_BYTES) throw new Error('Portable scene exceeds 128 MiB.');
    await writeFile(output, text, { flag: 'wx', mode: 0o600 });
    console.log(`Exported ${input} to ${output}`);
  }
} finally { backend.close(); }
