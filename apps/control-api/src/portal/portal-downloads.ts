import { constants } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const artifacts = new Map([
  ['windows-installer', { name: 'OrderRestro.msix', label: 'Windows installer' }],
  ['windows-update', { name: 'OrderRestro-update.msix', label: 'Windows update' }],
]);
export type PortalFile = { name: string; length: number; handle: FileHandle };

export function readPortalResources(env: NodeJS.ProcessEnv) {
  const directory = env.CONTROL_PORTAL_DOWNLOAD_DIR;
  const support = z.email().max(254).safeParse(env.CONTROL_PORTAL_SUPPORT_EMAIL ?? 'nventra01@gmail.com');
  if (!support.success || (directory !== undefined && (!path.isAbsolute(directory) ||
    /^[/\\]{2}/.test(directory) || directory.includes('\0') || directory !== path.resolve(directory) ||
    directory === path.parse(directory).root))) throw new Error('Invalid portal resources');
  return { directory, supportEmail: support.data,
    paymentInstructions: 'Contact support with your invoice reference for payment instructions or to check a recorded payment.' };
}

export class PortalDownloads {
  private readonly directory: string | undefined;
  constructor(directory?: string) { this.directory = directory; }

  async open(id: string): Promise<PortalFile | null> {
    const artifact = artifacts.get(id);
    if (!this.directory || !artifact) return null;
    let handle: FileHandle | undefined;
    try {
      const root = await realpath(this.directory);
      if (path.relative(root, this.directory) !== '') return null;
      const filename = path.join(root, artifact.name);
      const before = await lstat(filename, { bigint: true });
      if (!before.isFile() || path.relative(filename, await realpath(filename)) !== '') return null;
      handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      const actual = await handle.stat({ bigint: true });
      if (!actual.isFile() || actual.dev !== before.dev || actual.ino !== before.ino ||
        actual.size > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      const file = { name: artifact.name, length: Number(actual.size), handle };
      handle = undefined;
      return file;
    } catch {
      return null;
    } finally { await handle?.close(); }
  }

  async list() {
    const items = [];
    for (const [id, artifact] of artifacts) {
      const file = await this.open(id);
      if (!file) continue;
      await file.handle.close();
      items.push({ id, label: artifact.label });
    }
    return items;
  }
}
