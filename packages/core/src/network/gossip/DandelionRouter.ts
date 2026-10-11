import type { IPeerManager, PeerId } from '../../types';
import type { OnionHop } from '../../crypto/OnionRouter';

/**
 * DandelionRouter — 発信経路の「状態」だけを持つ。
 *
 * ★ 平文 Stem による発信は撤去した (C2 / C3 / C4)。
 *
 *   旧実装は Gossip 本体をオニオンで送る一方、同じ投稿の Slot (DHT_PUT_STEM) と
 *   索引 (HINT_STEM) を平文 Stem で並行に送っており、隣人 1 人がオニオンを
 *   丸ごと迂回して発信元を推定できた。Stem の失敗時には平文 flood へ
 *   落ちる経路も残っていた。
 *
 *   現在、作者が網へ出すものはすべて {@link ../onion/OnionCircuit} が
 *   cover traffic に混ぜた固定長セルとして運ぶ。このクラスに残っているのは
 *     - Guard の固定 (Guard Pinning)
 *     - エコー (自分の発信が網に現れたか) の待ち合わせ
 *   だけである。
 */
export const DANDELION_CONFIG = {
  /**
   * Guard を固定する期間。
   *
   * ★ 旧実装は 15 分で交代させていた。隣人 16 人のうち 1 人が攻撃者なら、
   *   数時間以内に必ず Guard の座が回ってくる。Guard は「誰が作者か」を
   *   最も知りやすい位置なので、交代は少ないほどよい。
   *   切断されるまで同じ Guard を使い続ける (Tor の Entry Guard と同じ考え方)。
   */
  GUARD_PIN_DURATION: Number.POSITIVE_INFINITY,
};

type EchoCallback = () => void;

export class DandelionRouter {
  private pinnedGuardId: PeerId | null = null;
  private pinnedGuardExpiry: number = 0;
  private listeners: Map<string, Array<EchoCallback>> = new Map();
  private guardListeners: Array<(guard: PeerId | null) => void> = [];

  constructor(private peerManager: IPeerManager) {}

  /**
   * エコーを通知 (自分の発信したものが網に現れた)
   */
  public notifyEcho(id: string): void {
    const key = `echo:${id}`;
    const callbacks = this.listeners.get(key);
    if (callbacks) {
      this.listeners.delete(key);
      callbacks.forEach(cb => cb());
    }
  }

  /**
   * エコーを待つ。届けば true、timeoutMs を過ぎれば false。
   */
  public awaitEcho(id: string, timeoutMs: number): Promise<boolean> {
    const key = `echo:${id}`;
    return new Promise((resolve) => {
      const callback = () => {
        clearTimeout(timeout);
        resolve(true);
      };
      const timeout = setTimeout(() => {
        // 自分のコールバックだけを外す。キーごと消すと、同じ id を待つ
        // 他の待機者のエコーまで取りこぼす。
        const remaining = (this.listeners.get(key) ?? []).filter(cb => cb !== callback);
        if (remaining.length > 0) this.listeners.set(key, remaining);
        else this.listeners.delete(key);
        resolve(false);
      }, timeoutMs);

      const list = this.listeners.get(key) ?? [];
      list.push(callback);
      this.listeners.set(key, list);
    });
  }

  /**
   * Guard Sticky Pinning:
   * 直結隣人から第1ホップ (Guard) を選定し、切断されるまで固定する。
   *
   * ★ 送信の失敗では Guard を交代させない。
   *   旧実装は配送失敗のたびに resetPinnedGuard() で Guard を引き直していたため、
   *   下流でセルを捨てるだけで作者に Guard を何度でも選び直させられた
   *   (= 攻撃者が Guard の座を取るまで抽選を回させる)。
   */
  public getPinnedGuard(candidates: OnionHop[]): OnionHop | null {
    const now = Date.now();
    const isLive =
      this.pinnedGuardId !== null &&
      now < this.pinnedGuardExpiry &&
      this.peerManager.peers.has(this.pinnedGuardId) &&
      candidates.some(c => c.peerId === this.pinnedGuardId);

    if (isLive) {
      return candidates.find(c => c.peerId === this.pinnedGuardId)!;
    }

    if (candidates.length === 0) {
      if (this.pinnedGuardId !== null && !this.peerManager.peers.has(this.pinnedGuardId)) {
        this.setGuard(null, 0);
      }
      return null;
    }
    const selected = candidates[secureRandomIndex(candidates.length)];
    this.setGuard(selected.peerId, now + DANDELION_CONFIG.GUARD_PIN_DURATION);
    return selected;
  }

  public getPinnedGuardId(): PeerId | null {
    return this.pinnedGuardId;
  }

  /** 明示的な Guard の破棄 (Guard 本人の不正が確定した場合など)。配送失敗では呼ばない */
  public resetPinnedGuard(): void {
    this.setGuard(null, 0);
  }

  /** Guard が変わったときの通知 (Guard の隣人表を作り直すため) */
  public onGuardChange(cb: (guard: PeerId | null) => void): void {
    this.guardListeners.push(cb);
  }

  private setGuard(id: PeerId | null, expiry: number): void {
    const changed = id !== this.pinnedGuardId;
    this.pinnedGuardId = id;
    this.pinnedGuardExpiry = expiry;
    if (changed) this.guardListeners.forEach(cb => cb(id));
  }
}

/** 偏りの無い暗号論的乱数インデックス */
export function secureRandomIndex(n: number): number {
  if (n <= 1) return 0;
  const limit = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % n;
  }
}
