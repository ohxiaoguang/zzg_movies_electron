import crypto from 'node:crypto';
import fs from 'node:fs';

const BLOCK_SIZE = 64 * 1024;

export async function calculateQuickFingerprint(filePath: string, fileSize: number): Promise<string> {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const firstSize = Math.min(BLOCK_SIZE, fileSize);
    const first = Buffer.alloc(firstSize);
    if (firstSize > 0) await handle.read(first, 0, firstSize, 0);

    const lastSize = Math.min(BLOCK_SIZE, fileSize);
    const last = Buffer.alloc(lastSize);
    if (lastSize > 0) await handle.read(last, 0, lastSize, Math.max(0, fileSize - lastSize));

    const firstHash = crypto.createHash('sha256').update(first).digest('hex');
    const lastHash = crypto.createHash('sha256').update(last).digest('hex');
    return `${fileSize}:${firstHash}:${lastHash}`;
  } finally {
    await handle.close();
  }
}
