/** Caps in-flight provider calls so one policy burst cannot exhaust the
 * company's outbound connection pool or dodge the daily budget check by racing. */
export class Semaphore {
  private available: number;
  private readonly queue: Array<() => void> = [];

  constructor(maxConcurrency: number) {
    if (maxConcurrency < 1) throw new Error("maxConcurrency must be >= 1");
    this.available = maxConcurrency;
  }

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available -= 1;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.available -= 1;
    return () => this.release();
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private release(): void {
    this.available += 1;
    const next = this.queue.shift();
    if (next) next();
  }
}
