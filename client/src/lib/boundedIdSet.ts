export class BoundedIdSet {
  private map = new Map<string, true>();

  constructor(private capacity: number) {}

  has(id: string): boolean {
    return this.map.has(id);
  }

  add(id: string): void {
    if (this.map.has(id)) {
      // Refresh LRU order.
      this.map.delete(id);
      this.map.set(id, true);
      return;
    }

    this.map.set(id, true);
    if (this.map.size <= this.capacity) return;

    const oldest = this.map.keys().next().value as string | undefined;
    if (oldest !== undefined) this.map.delete(oldest);
  }
}

