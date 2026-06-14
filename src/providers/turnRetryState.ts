export class TurnRetryState {
  hasRetried429 = false;
  hasRetriedAuth = false;
  hasActivatedFallback = false;
  hasCompressedAndRetried = false;

  tryMarkRetried429(): boolean {
    if (this.hasRetried429) return false;
    this.hasRetried429 = true;
    return true;
  }

  tryMarkRetriedAuth(): boolean {
    if (this.hasRetriedAuth) return false;
    this.hasRetriedAuth = true;
    return true;
  }

  tryMarkActivatedFallback(): boolean {
    if (this.hasActivatedFallback) return false;
    this.hasActivatedFallback = true;
    return true;
  }

  tryMarkCompressedAndRetried(): boolean {
    if (this.hasCompressedAndRetried) return false;
    this.hasCompressedAndRetried = true;
    return true;
  }
}
