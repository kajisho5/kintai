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

  /** 直近の1件の記録を取り消す（先に記録しておいた試行が、成功だったとき） */
  refund(key: string, now: number): void {
    const list = this.recent(key, now);
    list.pop();
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
  }

  retryAfterMin(key: string, now: number): number {
    const list = this.recent(key, now);
    return list.length ? Math.max(1, Math.ceil((list[0]! + this.windowMs - now) / 60000)) : 0;
  }
}

/**
 * 他人のアドレスに確認メールを送りつける迷惑行為への対策。登録時と、確認メールの送り先の変更時に、同じ数え方で制限する。
 * 同じアドレス宛は24時間に3回、サービス全体では1時間に300回まで。
 */
export class MailTargetGuard {
  private perAddress = new RateLimiter(3, 24 * 3600_000);
  private all = new RateLimiter(300, 60 * 60_000);

  /** 送ってよければ数えて undefined、だめなら利用者向けのメッセージ */
  reserve(email: string, now: number): string | undefined {
    const key = email.trim().toLowerCase();
    if (this.all.blocked("all", now)) return "ただいま混み合っています。しばらくしてからお試しください";
    if (this.perAddress.blocked(key, now)) return "このメールアドレス宛の送信が多すぎます。24時間ほどあけてお試しください";
    this.all.record("all", now);
    this.perAddress.record(key, now);
    return undefined;
  }
}
