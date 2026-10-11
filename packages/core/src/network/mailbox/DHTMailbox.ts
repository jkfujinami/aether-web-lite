import type { IPeerManager, PeerId, IMailbox, IMessageDispatcher } from '../../types';
import { RingPosition } from '../RingPosition';
import { IndexedDBStore } from '../../storage/IndexedDBStore';
import { Encoding } from '../../common/Encoding';
import { CryptoUtils } from '../../common/CryptoUtils';
import { WireType } from '../wire/WireTypes';
import {
  filterValidEntries,
  isValidTopicHash,
  MAILBOX_LIMITS,
} from './MailboxEntry';
import { createLogger } from '../../common/Logger';
import type { OnionCircuit } from '../onion/OnionCircuit';
import type { GossipPacket } from '../../types';
import { JsonBinary } from '../../common/JsonBinary';
import { checkEntry } from './MailboxEntry';
import { decodeHint } from '../hint/HintPacket';
import { decodeSlotBlob, encodeSlotBlob } from '../hint/SlotBlob';

const log = createLogger('net.mailbox');

// K=5（自分と最も近い5人）にデータを保存する
const K_NEAREST = 5;

/** 誰も応答しない場合の打ち切り */
const FETCH_HARD_TIMEOUT_MS = 4000;

/**
 * 最初の応答が来てから、残りを待つ猶予。
 *
 * K-nearest は同じ内容を持っているはずなので原理的には 1 件で足りるが、
 * 保管状況にズレがあると件数が変わる。ほぼ同時に返る分だけ拾って確定する。
 */
const FETCH_GRACE_MS = 300;

/**
 * K-nearest 帰属判定の許容幅。
 *
 * 各ノードが見えている隣人集合は少しずつ違うので、厳密に「自分が上位 K に
 * 入っているか」で弾くと、視界のずれだけで正当な PUT が落ちる。
 * 少し広めに取って、明らかに無関係なノードからの投げ込みだけを止める。
 */
const PUT_ACCEPT_SLACK = 3;

export class DHTMailbox implements IMailbox {
  private store: IndexedDBStore;
  private pendingRequests = new Map<
    string,
    { resolve: (val: Uint8Array[]) => void; timeout: any; topicHash: string; target: PeerId }
  >();

  private peerManager: IPeerManager;
  private slotListeners: Array<(entry: Uint8Array, topicHash: string) => void> = [];

  constructor(
    peerManager: IPeerManager,
    dispatcher: IMessageDispatcher,
    store: IndexedDBStore,
    /**
     * 作者の Slot は、Gossip と同じオニオンセルに載って出口まで運ばれ、
     * **出口が作者の代わりに** K-nearest へ PUT する。**必須**にしてある。
     */
    circuit: OnionCircuit,
  ) {
    this.peerManager = peerManager;
    this.store = store;

    dispatcher.register(WireType.DHT_PUT, (peerId, msg) => this.handlePut(peerId, msg));
    dispatcher.register(WireType.DHT_GET, (peerId, msg) => this.handleGet(peerId, msg));
    dispatcher.register(WireType.DHT_RES, (peerId, msg) => this.handleRes(peerId, msg));
    circuit.onExit('exit_fluff', (payload) => {
      if (payload.type === 'exit_fluff' && payload.slot) {
        void this.storeSlotAsExit(payload.slot.topicHash, payload.slot.hint, payload.packet);
      }
    });
  }

  /**
   * データの再レプリケーション（ReplicationManager から呼び出し）
   */
  public replicate(targetPeerId: PeerId, topicHash: string, entries: Uint8Array[]): void {
    // 1 メッセージあたりの上限を送信側でも守る (相手に弾かれて無駄になるため)
    for (let i = 0; i < entries.length; i += MAILBOX_LIMITS.MAX_ENTRIES_PER_MESSAGE) {
      this.sendDHTPut(targetPeerId, topicHash, entries.slice(i, i + MAILBOX_LIMITS.MAX_ENTRIES_PER_MESSAGE));
    }
  }

  /**
   * topicHash(Hex) -> リング上の座標 [0, 1) へマッピング
   */
  private hashToPosition(topicHashHex: string): number {
    const prefix = topicHashHex.substring(0, 8);
    const intVal = parseInt(prefix, 16) || 0;
    return intVal / 0xffffffff;
  }

  /**
   * 指定したトピック位置に近い順に K 人選出する。
   *
   * ハンドシェイク未完了のピアは除外する。座標が Bound Identity で
   * 検証されていないピアを K-nearest に入れると、そこが穴になる。
   */
  private findKNearest(topicPos: number, k: number): PeerId[] {
    const allPeers = Array.from(this.peerManager.peers.values())
      .filter(p => p.isConnected && p.isVerified)
      .map(p => ({ id: p.peerId, pos: p.position }));

    allPeers.push({ id: this.peerManager.myPeerId, pos: this.peerManager.myPosition });

    allPeers.sort((a, b) => {
      const distA = RingPosition.distance(topicPos, a.pos);
      const distB = RingPosition.distance(topicPos, b.pos);
      return distA - distB;
    });

    return allPeers.slice(0, k).map(p => p.id);
  }

  /**
   * 自分がこの topicHash の保管担当かどうか。
   *
   * これが無いと、リング上のどこにいる誰からでも任意のトピックに
   * 書き込めてしまう (無差別ディスク枯渇 DoS)。
   */
  private isResponsibleFor(topicHashHex: string): boolean {
    const topicPos = this.hashToPosition(topicHashHex);
    const nearest = this.findKNearest(topicPos, K_NEAREST + PUT_ACCEPT_SLACK);
    return nearest.includes(this.peerManager.myPeerId);
  }

  /**
   * 出口として、作者の代わりに Slot を K-nearest へ保管する。
   *
   * ★ 作者自身は PUT を出さない (C3)。
   *
   *   旧実装は同じ投稿を Gossip ではオニオンに載せつつ、Slot (JSON 化した
   *   GossipPacket = packet_id 入り) を平文の DHT_PUT_STEM で作者のエポック
   *   Stem 先へ直接送っていた。Stem 先は「その投稿が網に現れる前に、
   *   この隣人から届いた」ことを観測でき、オニオンが丸ごと迂回されていた。
   *   隣人が居ないときに作者が直接 K-nearest へ置く経路も残っていた。
   *
   *   現在は Slot の素 (topicHash と索引) を exit_fluff セルに同梱し、
   *   本体は出口がパケットから組み立てる (本体 JSON はセルに収まらないため)。
   *   保管者が見る IP は出口のもので、出口は作者を知らない。
   */
  public async storeSlotAsExit(topicHashHex: string, hintBytes: Uint8Array, packet: GossipPacket): Promise<void> {
    if (!isValidTopicHash(topicHashHex)) return;
    const hint = decodeHint(hintBytes);
    if (!hint) return;

    let entry: Uint8Array;
    try {
      entry = encodeSlotBlob(hint, new TextEncoder().encode(JsonBinary.stringify(packet)));
    } catch {
      return;
    }
    // 自分の保管と同じ検証 (CHK・PoW・索引の PoW・サイズ) を通ったものだけ配る
    if (!checkEntry(entry).ok) {
      log.debug(() => `exit slot rejected ${topicHashHex.substring(0, 8)}`);
      return;
    }
    log.debug(() => `exit storing slot ${topicHashHex.substring(0, 8)} on behalf of author`);
    await this.putToKNearest(topicHashHex, entry);
  }

  /** 実際に K-nearest へ配る (出口が作者の代わりに行う) */
  private async putToKNearest(topicHashHex: string, data: Uint8Array): Promise<void> {
    const topicPos = this.hashToPosition(topicHashHex);
    const nearest = this.findKNearest(topicPos, K_NEAREST);

    log.debug(() => `putting ${topicHashHex.substring(0, 8)} to K=${nearest.length}`);

    // 送信を先に行う。ディスク書き込みでネットワーク送出を待たせない。
    for (const targetId of nearest) {
      if (targetId !== this.peerManager.myPeerId) {
        this.sendDHTPut(targetId, topicHashHex, [data]);
      }
    }
    if (nearest.includes(this.peerManager.myPeerId)) {
      await this.store.put(topicHashHex, [data]);
    }
  }

  /**
   * 新規参加時などに、過去のデータをネットワーク上の担当者から取得する (GET)
   */
  public async fetch(topicHashHex: string): Promise<Uint8Array[]> {
    if (!isValidTopicHash(topicHashHex)) return [];

    const topicPos = this.hashToPosition(topicHashHex);
    const nearest = this.findKNearest(topicPos, K_NEAREST).filter(id => id !== this.peerManager.myPeerId);

    log.debug(`Fetching logs for ${topicHashHex.substring(0, 8)}. Targets: ${nearest.length}`);

    const localEntries = (await this.store.get(topicHashHex).catch(() => [])) || [];
    const uniquePackets = new Map<string, Uint8Array>();
    localEntries.forEach(p => uniquePackets.set(Encoding.toHex(p), p));

    if (nearest.length === 0) {
      return Array.from(uniquePackets.values());
    }

    return new Promise((resolve) => {
      let responsesReceived = 0;
      let settled = false;
      const expectedResponses = nearest.length;
      const requestIds: string[] = [];
      const startedAt = Date.now();

      const finalize = (reason: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(hardTimer);
        clearTimeout(graceTimer);
        for (const rid of requestIds) this.pendingRequests.delete(rid);
        const result = Array.from(uniquePackets.values());
        log.debug(
          () =>
            `fetch done ${topicHashHex.substring(0, 8)} items=${result.length} ` +
            `responses=${responsesReceived}/${expectedResponses} ${Date.now() - startedAt}ms (${reason})`,
        );
        resolve(result);
      };

      // ★ 全 K 人の応答を待たない。
      //
      //   旧実装は `responsesReceived >= expectedResponses` で K=5 全員を待って
      //   おり、1 台でも遅い/落ちていると 4 秒のハードタイムアウトまで
      //   引きずられていた。K-nearest は同じ内容を持っているはずなので、
      //   最初の応答が来たら短い猶予だけ置いて確定させる。
      //   猶予を置くのは、ほぼ同時に返ってくる他の応答を取りこぼさないため
      //   (保管状況にズレがあると件数が変わる)。
      let graceTimer: any = null;
      const hardTimer = setTimeout(() => finalize('timeout'), FETCH_HARD_TIMEOUT_MS);

      nearest.forEach(targetId => {
        const reqId = `fetch_${CryptoUtils.generateId()}`;
        requestIds.push(reqId);

        this.pendingRequests.set(reqId, {
          topicHash: topicHashHex,
          target: targetId,
          resolve: (packets: Uint8Array[]) => {
            responsesReceived++;
            packets.forEach(p => uniquePackets.set(Encoding.toHex(p), p));

            if (responsesReceived >= expectedResponses) {
              finalize('all responded');
              return;
            }
            if (graceTimer === null) {
              graceTimer = setTimeout(() => finalize('grace elapsed'), FETCH_GRACE_MS);
            }
          },
          timeout: null,
        });

        this.sendDHTGet(targetId, topicHashHex, reqId);
      });
    });
  }

  /**
   * Slot を保管したときの通知。
   *
   * ★ 保管した Slot には索引 (hint_blob) が同梱されている。
   *   鍵を持っているなら**その場で開ける**ので、Gossip で同じ Hint が
   *   流れてくるのを待つ必要がない。
   *
   *   これが無いと「本体は複製で届いて保管されているのに、
   *   索引が別経路で来るまで画面に出ない」という状態になる
   *   (再放流待ちだと最大 20 分)。実網ログで発覚した。
   */
  public onSlotStored(cb: (entry: Uint8Array, topicHash: string) => void): void {
    this.slotListeners.push(cb);
  }

  /**
   * 自分が保管している Slot の鍵一覧。
   *
   * Hint の再放流 (§18.3-A) が「自分が持っているものの索引を撒き直す」
   * ために使う。中身は読まない。
   */
  public async storedKeys(): Promise<string[]> {
    return this.store.getAllTopicHashes().catch(() => []);
  }

  /** 指定した Slot に保管しているバイト列 */
  public async stored(topicHashHex: string): Promise<Uint8Array[]> {
    if (!isValidTopicHash(topicHashHex)) return [];
    return (await this.store.get(topicHashHex).catch(() => [])) ?? [];
  }

  /** ── Dispatcher Handlers ── */

  /**
   * ★ PUT の検証 (旧実装はここが完全に素通しだった)
   *
   * 旧:
   *   private handlePut(_peerId, msg) {
   *     this.store.put(msg.topicHash, msg.entries)   // 無検証
   *   }
   *
   * これにより誰でも
   *   - 任意のスレッドの「過去ログ」を捏造して差し込める
   *   - 無関係なトピックに無制限に書いて IndexedDB を枯渇させられる
   * 状態だった。
   *
   * 現在は 4 段で縛る:
   *   1. topicHash の形式
   *   2. 帰属 — 自分が K-nearest 圏内でなければ受け取らない
   *   3. エントリ単位の PoW + CHK 検証 (鍵は不要)
   *   4. 件数・サイズの上限
   */
  private async handlePut(peerId: PeerId, msg: any): Promise<void> {
    const topicHash = msg?.topicHash;
    if (!isValidTopicHash(topicHash)) {
      log.warn(`PUT rejected from ${peerId.substring(0, 8)}: malformed topicHash`);
      return;
    }

    if (!this.isResponsibleFor(topicHash)) {
      log.warn(
        `[DHTMailbox] PUT rejected for ${topicHash.substring(0, 8)}: not in K-nearest set (attribution check)`,
      );
      return;
    }

    const { accepted, rejected } = filterValidEntries(msg.entries);

    if (rejected.size > 0) {
      const summary = Array.from(rejected.entries()).map(([r, n]) => `${r}x${n}`).join(', ');
      // topicHash まで出す。旧経路 (板/スレの固定座標) から来ているのか
      // 新経路 (ランダム Slot) なのかが、これだけで切り分けられる。
      log.warn(`PUT from ${peerId.substring(0, 8)} topic=${topicHash.substring(0, 8)}: dropped invalid entries (${summary})`);
    }
    if (accepted.length === 0) return;

    try {
      const existing = (await this.store.get(topicHash)) ?? [];
      if (existing.length >= MAILBOX_LIMITS.MAX_ENTRIES_PER_TOPIC) {
        log.warn(`PUT rejected for ${topicHash.substring(0, 8)}: topic is full`);
        return;
      }

      if (existing.length === 0) {
        const topicCount = (await this.store.getAllTopicHashes()).length;
        if (topicCount >= MAILBOX_LIMITS.MAX_TOPICS) {
          log.warn(`PUT rejected: topic capacity reached (${topicCount})`);
          return;
        }
      }

      const room = MAILBOX_LIMITS.MAX_ENTRIES_PER_TOPIC - existing.length;
      const toStore = accepted.slice(0, room);
      await this.store.put(topicHash, toStore);
      // 保管した Slot は、鍵を持っていればその場で開ける
      for (const entry of toStore) {
        for (const cb of this.slotListeners) cb(entry, topicHash);
      }
      log.debug(
        () =>
          `stored ${toStore.length} entries for ${topicHash.substring(0, 8)} ` +
          `from ${peerId.substring(0, 8)} (slot=${toStore.length > 0 && decodeSlotBlob(toStore[0]) !== null})`,
      );
    } catch (e) {
      log.error(`PUT storage error:`, e);
    }
  }

  private async handleGet(peerId: PeerId, msg: any): Promise<void> {
    const topicHash = msg?.topicHash;
    const reqId = msg?.reqId;
    if (!isValidTopicHash(topicHash) || typeof reqId !== 'string' || reqId.length > 64) return;

    try {
      const entries = (await this.store.get(topicHash)) ?? [];
      this.sendDHTRes(peerId, topicHash, reqId, entries.slice(0, MAILBOX_LIMITS.MAX_ENTRIES_PER_MESSAGE));
    } catch (e) {
      log.error(`GET storage error:`, e);
    }
  }

  /**
   * ★ RES の検証 (旧実装はここも素通しだった)
   *
   * 旧実装は届いた entries をそのまま resolve し、さらに store.put で
   * ローカルにも焼き付けていた。K=5 のうち 1 台が悪意を持てば、偽の過去ログが
   * 正史として定着した。
   *
   * 現在は
   *   1. 自分が出した reqId への応答か
   *   2. その reqId を投げた *相手* からの応答か (別ノードの割り込み応答を弾く)
   *   3. 各エントリが CHK + PoW を満たすか
   * を確認してから受け入れる。
   */
  private async handleRes(peerId: PeerId, msg: any): Promise<void> {
    const reqId = msg?.reqId;
    if (typeof reqId !== 'string') return;

    const req = this.pendingRequests.get(reqId);
    if (!req) return;

    // 自分が問い合わせた相手以外からの応答は受け取らない
    if (req.target !== peerId) {
      log.warn(`RES from unexpected peer ${peerId.substring(0, 8)} (expected ${req.target.substring(0, 8)})`);
      return;
    }
    if (msg?.topicHash !== req.topicHash) {
      log.warn(`RES topicHash mismatch for reqId ${reqId}`);
      return;
    }

    this.pendingRequests.delete(reqId);

    const { accepted, rejected } = filterValidEntries(msg.entries);
    if (rejected.size > 0) {
      const summary = Array.from(rejected.entries()).map(([r, n]) => `${r}x${n}`).join(', ');
      log.warn(`RES from ${peerId.substring(0, 8)}: dropped invalid entries (${summary})`);
    }

    log.debug(`DHT response accepted: ${accepted.length} verified items`);
    req.resolve(accepted);

    if (accepted.length > 0 && this.isResponsibleFor(req.topicHash)) {
      // 検証済みのものだけをローカルにも保管する
      this.store.put(req.topicHash, accepted).catch(e => log.error(e));
      for (const entry of accepted) {
        for (const cb of this.slotListeners) cb(entry, req.topicHash);
      }
    }
  }

  private sendDHTPut(targetPeerId: PeerId, topicHash: string, entries: Uint8Array[]) {
    this.peerManager.sendMessage(targetPeerId, WireType.DHT_PUT, { topicHash, entries });
  }

  private sendDHTGet(targetPeerId: PeerId, topicHash: string, reqId: string) {
    this.peerManager.sendMessage(targetPeerId, WireType.DHT_GET, { topicHash, reqId });
  }

  private sendDHTRes(targetPeerId: PeerId, topicHash: string, reqId: string, entries: Uint8Array[]) {
    this.peerManager.sendMessage(targetPeerId, WireType.DHT_RES, { topicHash, reqId, entries });
  }
}
