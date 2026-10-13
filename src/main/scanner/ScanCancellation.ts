export class ScanCancellation {
  public constructor(private readonly flag = new Int32Array(new SharedArrayBuffer(4))) {}
  public sharedFlag(): SharedArrayBuffer { return this.flag.buffer as SharedArrayBuffer; }
  public cancel(): void { Atomics.store(this.flag, 0, 1); }
  public get cancelled(): boolean { return Atomics.load(this.flag, 0) === 1; }
  public throwIfCancelled(): void { if (this.cancelled) throw new Error('SCAN_CANCELLED'); }
}
