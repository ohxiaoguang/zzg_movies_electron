import { Worker } from 'node:worker_threads';
import type { MediaSourceDto, SettingsDto } from '../../shared/contracts';
import { FilmFileOwnershipConflictError } from '../database/repositories/FilmRepository';
import type { LibraryOperationCoordinator } from '../services/LibraryOperationCoordinator';
import type { AppLogger } from '../system/AppLogger';
import type { ScanCancellation } from './ScanCancellation';
import type { SourceScannerProgress, SourceScanResult } from './SourceScanner';
import type { ScanSourceMerger } from './ScanSourceMerger';

export type ScanMergeResult = ReturnType<ScanSourceMerger['merge']>;
export interface ScanWorkerResult extends SourceScanResult { merge?: ScanMergeResult; }
export interface ScanWorkerInput { databasePath: string; source: MediaSourceDto; settings: SettingsDto; relativeDirectory: string | null; cancellation: SharedArrayBuffer; }
export type ScanWorkerMessage =
  | { kind: 'progress'; progress: SourceScannerProgress }
  | { kind: 'merge-ready'; scan: SourceScanResult }
  | { kind: 'result'; result: ScanWorkerResult }
  | { kind: 'error'; message: string; details?: FilmFileOwnershipConflictError['details']; cause?: string }
  | { kind: 'warn'; message: string; details?: Record<string, unknown> };

export class ScanWorkerClient {
  public constructor(private readonly workerPath: string, private readonly databasePath: string, private readonly operations: LibraryOperationCoordinator, private readonly logger: AppLogger) {}

  public run(source: MediaSourceDto, settings: SettingsDto, relativeDirectory: string | null, cancellation: ScanCancellation,
    onProgress: (value: SourceScannerProgress) => void, onMergeReady: (scan: SourceScanResult) => void): Promise<ScanWorkerResult> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(this.workerPath, { workerData: { databasePath: this.databasePath, source, settings, relativeDirectory, cancellation: cancellation.sharedFlag() } satisfies ScanWorkerInput });
      let releaseWrite: (() => void) | undefined;
      let settled = false;
      const finish = (error?: Error, result?: ScanWorkerResult) => {
        if (settled) return;
        settled = true;
        releaseWrite?.();
        if (error) reject(error); else resolve(result!);
      };
      worker.on('message', async (message: ScanWorkerMessage) => {
        try {
          if (message.kind === 'progress') onProgress(message.progress);
          else if (message.kind === 'warn') this.logger.warn(message.message, message.details);
          else if (message.kind === 'merge-ready') {
            onMergeReady(message.scan);
            releaseWrite = await this.operations.beginScanWrite();
            if (settled) { releaseWrite(); return; }
            worker.postMessage('merge');
          } else if (message.kind === 'result') finish(undefined, message.result);
          else if (message.kind === 'error') finish(message.details
            ? new FilmFileOwnershipConflictError(message.details, new Error(message.cause ?? message.message))
            : new Error(message.message));
        } catch (error) {
          cancellation.cancel();
          void worker.terminate().then(() => finish(error instanceof Error ? error : new Error('SCAN_WORKER_FAILED')));
        }
      });
      worker.once('error', (error: Error) => { void worker.terminate().then(() => finish(error)); });
      worker.once('exit', (code) => { if (!settled) finish(new Error(`SCAN_WORKER_EXIT_${code}`)); });
    });
  }
}
