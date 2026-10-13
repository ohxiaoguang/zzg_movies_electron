import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseManager } from '../database/DatabaseManager';
import { FilmRepository, FilmFileOwnershipConflictError } from '../database/repositories/FilmRepository';
import { ScanCancellation } from './ScanCancellation';
import { SourceScanner } from './SourceScanner';
import { ScanSourceMerger } from './ScanSourceMerger';
import type { ScanWorkerInput, ScanWorkerMessage } from './ScanWorkerClient';

const input = workerData as ScanWorkerInput;
const cancellation = new ScanCancellation(new Int32Array(input.cancellation));
const send = (message: ScanWorkerMessage) => parentPort!.postMessage(message);
let database: DatabaseManager | undefined;
let lastProgressAt = 0;
let lastPhase = '';
void (async () => {
  const scanner = new SourceScanner(input.source, { settings: input.settings, relativeDirectory: input.relativeDirectory ?? undefined,
    cancellation, onProgress: (progress) => {
      if (Date.now() - lastProgressAt >= 100 || progress.phase !== lastPhase || (progress.discovered > 0 && progress.processed === progress.discovered)) {
        lastProgressAt = Date.now(); lastPhase = progress.phase; send({ kind: 'progress', progress });
      }
    } });
  const scan = await scanner.scan();
  if (scan.complete && !scan.offline && !scan.cancelled && !cancellation.cancelled) {
    const permission = new Promise<void>((resolve) => parentPort!.once('message', () => resolve()));
    send({ kind: 'merge-ready', scan: { ...scan, candidates: [] } });
    await permission;
    cancellation.throwIfCancelled();
    database = new DatabaseManager(input.databasePath);
    const merger = new ScanSourceMerger(database, new FilmRepository(database.db), {
      warn: (message, details) => send({ kind: 'warn', message, details }),
    });
    const merge = merger.merge(input.source, scan.candidates, input.relativeDirectory, cancellation);
    database.close();
    send({ kind: 'result', result: { ...scan, candidates: [], issues: [], merge } });
  } else send({ kind: 'result', result: { ...scan, candidates: [] } });
})().catch((error: unknown) => {
  database?.close();
  send({ kind: 'error', message: error instanceof Error ? error.message : 'SCAN_WORKER_FAILED',
    ...(error instanceof FilmFileOwnershipConflictError ? { details: error.details, cause: error.cause instanceof Error ? error.cause.message : undefined } : {}) });
}).finally(() => { database?.close(); parentPort!.close(); });
