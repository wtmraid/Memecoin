/** Bounded set for de-duplicating signatures / message ids. Oldest entries evicted first. */
export class SeenSet {
  private set = new Set<string>();
  constructor(private max = 50_000) {}

  /** Returns true if `key` was new (and records it). */
  add(key: string): boolean {
    if (this.set.has(key)) return false;
    this.set.add(key);
    if (this.set.size > this.max) {
      const first = this.set.values().next().value as string;
      this.set.delete(first);
    }
    return true;
  }

  has(key: string) {
    return this.set.has(key);
  }
  get size() {
    return this.set.size;
  }
}
