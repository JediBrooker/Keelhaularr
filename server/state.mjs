import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const configDirectory = path.resolve(process.env.CONFIG_DIR || path.join(process.cwd(), 'config'));

export function createJsonStore(filename, fallback) {
  const filePath = path.join(configDirectory, filename);
  let document = load();
  let writeQueue = Promise.resolve();

  function load() {
    try {
      const value = JSON.parse(readFileSync(filePath, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('root must be an object');
      return value;
    } catch (error) {
      if (error.code === 'ENOENT') return structuredClone(fallback);
      throw new Error(`Cannot read persisted state at ${filePath}: ${error.message}`);
    }
  }

  function read() {
    return structuredClone(document);
  }

  function update(mutator) {
    const operation = async () => {
      const next = structuredClone(document);
      mutator(next);
      const saved = next;
      const body = `${JSON.stringify(saved, null, 2)}\n`;
      await mkdir(configDirectory, { recursive: true, mode: 0o700 });
      await chmod(configDirectory, 0o700);
      const temporaryPath = path.join(configDirectory, `.${filename}-${process.pid}-${randomUUID()}.tmp`);
      try {
        await writeFile(temporaryPath, body, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        await chmod(temporaryPath, 0o600);
        await rename(temporaryPath, filePath);
        document = saved;
      } finally {
        await unlink(temporaryPath).catch(() => undefined);
      }
      return structuredClone(document);
    };
    writeQueue = writeQueue.then(operation, operation);
    return writeQueue;
  }

  return { filePath, read, update };
}
