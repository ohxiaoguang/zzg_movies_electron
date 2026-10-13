/** Serializes filesystem/index changes across desktop and web entry points. */
export class LibraryOperationCoordinator {
  private active: 'scan' | 'transfer' | 'media' | null = null;
  private stopping = false;
  private scanWriting = false;
  private scanWriteToken = 0;
  private databaseActions = 0;
  private databaseIdleWaiters: Array<() => void> = [];
  private scanWriteWaiters: Array<() => void> = [];

  public waitForScanWrite(): Promise<void> {
    return this.scanWriting ? new Promise((resolve) => this.scanWriteWaiters.push(resolve)) : Promise.resolve();
  }

  public async runDatabaseAction<T>(action: () => Promise<T> | T): Promise<T> {
    while (this.scanWriting) await this.waitForScanWrite();
    this.databaseActions++;
    try { return await action(); }
    finally {
      this.databaseActions--;
      if (!this.databaseActions) for (const resolve of this.databaseIdleWaiters.splice(0)) resolve();
    }
  }

  public async beginScanWrite(): Promise<() => void> {
    const token = ++this.scanWriteToken;
    this.scanWriting = true;
    if (this.databaseActions) await new Promise<void>((resolve) => this.databaseIdleWaiters.push(resolve));
    return () => {
      if (token !== this.scanWriteToken) return;
      this.scanWriting = false;
      for (const resolve of this.scanWriteWaiters.splice(0)) resolve();
    };
  }
  private waiters: Array<() => void> = [];

  public acquire(kind: 'scan' | 'transfer' | 'media'): () => void {
    if (this.stopping) throw new Error('APPLICATION_SHUTTING_DOWN');
    if (this.active === 'media') throw new Error('FILM_MEDIA_BUSY');
    if (this.active === 'transfer') throw new Error('SOURCE_TRANSFER_ALREADY_RUNNING');
    if (this.active === 'scan') throw new Error(kind === 'scan' ? 'SCAN_ALREADY_RUNNING' : 'SOURCE_TRANSFER_SCAN_RUNNING');
    this.active = kind;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = null;
      for (const resolve of this.waiters.splice(0)) resolve();
    };
  }

  public stopAndWait(): Promise<void> {
    this.stopping = true;
    return this.active ? new Promise((resolve) => this.waiters.push(resolve)) : Promise.resolve();
  }
}
