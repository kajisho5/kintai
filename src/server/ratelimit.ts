/** 一定時間内の回数を数える簡易リミッタ（メモリ保持。再起動で消える／複数台では共有されない） */
export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(private readonly max: number, private readonly windowMs: number) {}

  private recent(key: string, now: number): number[] {
    const list = (this.hits.get(key) ?? []).filter((t) => t > now - this.windowMs);
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
    return list;
  }

  /** 上限に達しているか（記録はしない） */
  blocked(key: string, now: number): boolean {
    return this.recent(key, now).length >= this.max;
  }

  record(key: string, now: number): void {
    const list = this.recent(key, now);
    list.push(now);
    this.hits.set(key, list);
    if (this.hits.size > 10_000) {
      for (const k of this.hits.keys()) this.recent(k, now);
    }
  }

  retryAfterMin(key: string, now: number): number {
    const list = this.recent(key, now);
    return list.length ? Math.max(1, Math.ceil((list[0]! + this.windowMs - now) / 60000)) : 0;
  }
}
