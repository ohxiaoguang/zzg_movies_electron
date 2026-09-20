/** Serializes filesystem/index changes across desktop and web entry points. */
export class LibraryOperationCoordinator {
  private active: 'scan' | 'transfer' | null = null;
  private stopping = false;
  private waiters: Array<() => void> = [];

  public acquire(kind: 'scan' | 'transfer'): () => void {
    if (this.stopping) throw new Error('APPLICATION_SHUTTING_DOWN');
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
