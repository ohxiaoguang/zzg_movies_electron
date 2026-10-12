import fs from 'node:fs';
import type { AppLogEntryDto, AppLogsDto } from '../../shared/contracts';

const MAX_BYTES = 512 * 1024;
const MAX_ENTRIES = 1000;

export async function readRecentAppLogs(filePath: string): Promise<AppLogsDto> {
  let file: fs.promises.FileHandle;
  try { file = await fs.promises.open(filePath, 'r'); }
  catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return { entries: [], truncated: false };
    throw new Error('APP_LOG_READ_FAILED', { cause: error });
  }
  try {
    const { size } = await file.stat();
    const start = Math.max(0, size - MAX_BYTES);
    const buffer = Buffer.alloc(Math.min(size, MAX_BYTES));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    const lines = text.split(/\r?\n/).filter((line) => line.trim());
    const entries = lines.slice(-MAX_ENTRIES).reverse().map((line): AppLogEntryDto => {
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === 'object' && typeof parsed.message === 'string') return {
          at: typeof parsed.at === 'string' ? parsed.at : '',
          level: typeof parsed.level === 'string' ? parsed.level : 'unknown',
          message: parsed.message,
          details: parsed.details === undefined ? '' : JSON.stringify(parsed.details),
        };
      } catch { /* Retain incomplete or older log lines for diagnosis. */ }
      return { at: '', level: 'unknown', message: line, details: '' };
    });
    return { entries, truncated: start > 0 || lines.length > MAX_ENTRIES };
  } finally { await file.close(); }
}
