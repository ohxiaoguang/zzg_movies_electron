export class ScanCancellation {
  private cancelledValue = false;

  public cancel(): void {
    this.cancelledValue = true;
  }

  public get cancelled(): boolean {
    return this.cancelledValue;
  }

  public throwIfCancelled(): void {
    if (this.cancelledValue) throw new Error('SCAN_CANCELLED');
  }
}
