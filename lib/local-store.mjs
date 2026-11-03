import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const schemaFile = fileURLToPath(new URL('../local/schema.sql', import.meta.url));

export async function openLocalStore(dataDir = process.env.LOCAL_DATA_DIR ?? '.runtime/local') {
  const inMemory = dataDir === 'memory://';
  const root = inMemory ? dataDir : path.resolve(dataDir);
  if (!inMemory) await mkdir(root, { recursive: true });
  const db = await PGlite.create(inMemory ? dataDir : path.join(root, 'db'));
  await db.exec(await readFile(schemaFile, 'utf8'));
  let queue = Promise.resolve();
  const run = operation => {
    const result = queue.then(() => operation(db));
    queue = result.catch(() => {});
    return result;
  };
  return { db, run, close: () => db.close(), root };
}
