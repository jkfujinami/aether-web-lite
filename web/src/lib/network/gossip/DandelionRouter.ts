import type { IPeerManager, PeerId, GossipPacket, StemPacket } from '../../types';
import { WireType } from '../wire/WireTypes';

/**
 * 仕様: docs/spec/step5_dandelion.md §「確定パラメータ」
 *
 * ★ stemTtl (ホップカウンタ) は廃止した。
 *
 * カウンタを平文でワイヤに載せると、それ自体が「経路上の位置」を漏らす:
 *
 *   - 発信元が送出しうる値 : {2, 3, 4}  (初期 TTL の乱択範囲)
 *   - 中継者が送出しうる値 : {0, 1, 2, 3} (受信値 - 1、上限 4)
 *
 *   → `stemTtl = 4` を受け取ったら、送信者は**発信元だと確定する**。
 *     初期 TTL の乱択は「自分が何番目か」を隠す意図だったが、
 *     上限値だけは発信元にしか出せないため確定オラクルになっていた。
 *     低い値も「中継者確定」を意味し、全域で情報が漏れる。
 *
 * 各ホップで独立に確率 p で Fluff へ移行する方式に変更した。
 * 経路長は幾何分布に従い**無記憶**なので、中継者は自分が何ホップ目かを
 * 推定する材料を一切持たない。本家 Dandelion++ がカウンタではなく
 * 確率を使っているのはこの理由による。
 *
 * 停止性:
 *   平均 1/p ホップ (p=0.3 で 3.33)、50 ホップ到達確率は 0.7^50 ≈ 2e-8。
 *   加えて PoW ヘッダの timestamp が MAX_TIME_DRIFT (15分) を超えると
 *   PacketValidator が落とすため、病的な循環も必ず止まる。
 */
export const DANDELION_CONFIG = {
  /**
   * 各ホップで Fluff に移行する確率。
   *
   * 経路長 = 幾何分布 (平均 1/p ホップ)。p=0.3 で平均 3.33 ホップとなり、
   * 仕様 §4.3 が想定する「2〜4 ホップ / 追加遅延 +120ms」にほぼ一致する。
   * Rust 側 (aether-cache) の FLUFF_PROBABILITY と必ず一致させること。
   */
  FLUFF_PROBABILITY: 0.3,
  EPOCH_DURATION: 10 * 60 * 1000,
  ECHO_TIMEOUT: 5000,
  MAX_RETRIES: 2,
};

/** エコー待ちのジッタ幅 (±20%) */
export const ECHO_TIMEOUT_JITTER = 0.2;

/**
 * エコー待ち時間にジッタを掛ける。
 *
 * 素の ECHO_TIMEOUT をそのまま使うと、再送の間隔がきっかり 5000ms になる。
 * 再送するのは発信元だけなので、この周期そのものが
 * 「このノードは中継ではなく作者だ」という指紋になる。
 * 幅を持たせて、ループで戻ってきた中継パケットの再転送と
 * 時間軸で切り分けられないようにする。
 */
export function jitteredEchoTimeout(): number {
  const base = DANDELION_CONFIG.ECHO_TIMEOUT;
  const spread = base * ECHO_TIMEOUT_JITTER;
  return Math.round(base - spread + Math.random() * spread * 2);
}

type EchoCallback = () => void;

export class DandelionRouter {
  private stemTarget: PeerId | null = null;
  private stemTargetExpiry: number = 0;
  private listeners: Map<string, Array<EchoCallback>> = new Map();
  private peerManager: IPeerManager;

  constructor(peerManager: IPeerManager) {
    this.peerManager = peerManager;
  }

  /**
   * 自己発信パケットのステム送信開始
   */
  public async publish(packet: GossipPacket, useDandelion: boolean = true): Promise<boolean> {
    if (!useDandelion || this.peerManager.degree === 0) {
      return false;
    }

    // ★ 再送は「発信元しか行わない」観測可能な振る舞いである。
    //
    //   中継者は同じ packet_id を再送しない。したがって
    //   「同じ packet_id を数秒あけて二度送ってくるノード = 発信元」
    //   という指紋が成立し、攻撃者は受け取った Stem を握り潰す
    //   (ブラックホール) だけでこれを誘発できる。
    //   仕様 §5.1 の回数 (Stem 2 回 → Flood) を厳密に守り、
    //   観測サンプルをこれ以上増やさない。
    //   同じ相手に二度当てないよう、試した相手は候補から外す。
    const tried = new Set<PeerId>();

    for (let attempt = 0; attempt < DANDELION_CONFIG.MAX_RETRIES; attempt++) {
      const all = Array.from(this.peerManager.peers.keys());
      if (all.length === 0) return false;
      const fresh = all.filter(p => !tried.has(p));
      const pool = fresh.length > 0 ? fresh : all;

      const target = this.getStemTarget(pool);
      tried.add(target);

      const stem: StemPacket = {
        type: 'stem',
        zoneId: packet.zone_id,
        packet: packet
      };

      console.log(`[Dandelion] Stemming packet ${packet.packet_id.substring(0, 8)} to ${target.substring(0, 8)}`);

      this.sendToPeer(target, stem);

      // エコー待ち
      const echoed = await this.waitForEcho(packet.packet_id);
      if (echoed) {
        console.log(`[Dandelion] Echo confirmed for ${packet.packet_id.substring(0, 8)}!`);
        return true;
      }

      console.warn(`[Dandelion] Echo timeout for ${packet.packet_id.substring(0, 8)}. Retrying...`);
      this.resetTarget();
    }

    return false;
  }

  /**
   * 中継処理
   * @param senderId パケットを送ってきた隣人のID
   */
  public handleStemPacket(senderId: PeerId, stem: StemPacket): { action: 'forward' | 'fluff', target?: PeerId, packet: GossipPacket | StemPacket } {
    const neighbors = Array.from(this.peerManager.peers.keys())
        .filter(pid => pid !== senderId); // 送り主を候補から外す (§5.2)

    // Fluff 判定。
    //
    // ★ ホップカウンタは見ない (廃止済み)。各ホップで独立に確率を引くだけ。
    //   幾何分布は無記憶なので、この判定からは「経路上の位置」が漏れない。
    //   転送先がいない場合もここで Fluff に落とす。
    if (Math.random() < DANDELION_CONFIG.FLUFF_PROBABILITY || neighbors.length === 0) {
      return {
        action: 'fluff',
        packet: { ...stem.packet, hop_count: 0 }
      };
    }

    // Stem 続行: 次の 1 人へそのまま転送する。
    // パケットは一切書き換えない —— 書き換える値があると、それが
    // 経路上の位置を示す手がかりになる。
    const nextTarget = this.getStemTarget(neighbors, senderId);
    return {
      action: 'forward',
      target: nextTarget,
      packet: stem
    };
  }

  /**
   * エコーを通知
   */
  public notifyEcho(packetId: string) {
    const key = `echo:${packetId}`;
    const callbacks = this.listeners.get(key);
    if (callbacks) {
      callbacks.forEach(cb => cb());
      this.listeners.delete(key);
    }
  }

  /**
   * Stem 先をエポック (10分) 固定で決める。
   *
   * ★ エポックの固定こそが匿名性の土台である (仕様 §3.1)。
   *   自分の書き込みも他人の中継も同じ宛先へ送られるからこそ、
   *   隣人から見て「作者パケット」と「中継パケット」が区別できない。
   *
   * ★ 攻撃: エポック破壊 (Epoch Churn)
   *   旧実装は「エポック対象が今回の候補に居ない/送り主本人」の場合に
   *   その場で再抽選し、**永続状態と 10 分タイマーごと上書き**していた。
   *   攻撃者は自分が対象になっている隣人へ Stem を送りつけるだけで
   *   相手のエポックを破壊でき、それを繰り返せば
   *   「自分が Stem 先に選ばれる」まで再抽選を強制できる。
   *   一度選ばれれば相手の自己発信パケットが直接自分に届く
   *   (first-spy) ため、特定率が設計値 (§4.1 の 3.3%) を大きく超える。
   *
   *   対策: 「今回だけ使えない」と「エポックが満了/対象が離脱した」を
   *   区別する。前者はこのパケット限りの代替で凌ぎ、エポックは温存する。
   */
  private getStemTarget(neighbors: PeerId[], excludeId?: PeerId): PeerId {
    const now = Date.now();

    // エポックが生きている条件は「期限内」かつ「対象がまだ接続中」。
    // 候補集合 (neighbors) は呼び出しごとに送り主を除いた一時的なものなので、
    // ここでエポックの生死を判定してはいけない。
    const target = this.stemTarget;
    const epochLive =
      target !== null &&
      now < this.stemTargetExpiry &&
      this.peerManager.peers.has(target);

    if (epochLive) {
      // 通常経路: エポック対象をそのまま使う
      if (target !== excludeId && neighbors.includes(target!)) {
        return target!;
      }
      // 今回だけ使えない (送り主本人など)。エポックは壊さず、
      // このパケット限りの代替を選ぶ。
      if (neighbors.length > 0) {
        return neighbors[Math.floor(Math.random() * neighbors.length)];
      }
    }

    // エポック満了、または対象が離脱した → 新しいエポックを開始
    this.stemTarget = neighbors[Math.floor(Math.random() * neighbors.length)];
    this.stemTargetExpiry = now + DANDELION_CONFIG.EPOCH_DURATION;
    return this.stemTarget;
  }

  private resetTarget() {
    this.stemTarget = null;
  }

  private async waitForEcho(packetId: string): Promise<boolean> {
    const key = `echo:${packetId}`;
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.listeners.delete(key);
        resolve(false);
      }, jitteredEchoTimeout());

      const callback = () => {
        clearTimeout(timeout);
        resolve(true);
      };

      if (!this.listeners.has(key)) {
        this.listeners.set(key, []);
      }
      this.listeners.get(key)!.push(callback);
    });
  }

  private sendToPeer(targetId: PeerId, stem: StemPacket) {
    this.peerManager.sendMessage(targetId, WireType.STEM, stem);
  }
}
