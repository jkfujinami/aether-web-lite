/**
 * Ring-Mesh 上でのゴシップ配信（Broadcast Veil）と Mailbox（DHT）のテスト
 *
 * StrictRingMesh の上にゴシップとDHTを載せて、
 * メッセージ到達率・遅延・帯域を測定する。
 */

// ═══ Ring-Mesh 実装（run_strict_ring.ts から移植 + 拡張） ═══

interface NodeData {
  id: number;
  position: number;
  neighbors: Set<number>;
  // ゴシップ
  seenPackets: Set<string>;
  // Mailbox (DHT)
  mailbox: Map<string, Uint8Array[]>;  // topicHash → 暗号化データ配列
  // 購読中のトピック（自分が復号できるもの）
  subscribedTopics: Set<string>;
}

interface GossipPacket {
  id: string;
  payload: string;        // 暗号化済みデータ(シミュレーションではプレーンテキスト)
  hopCount: number;
  maxHops: number;
  originTime: number;     // 送信時刻(シミュレーション時間)
  topicHash: string;      // どのトピック宛か（暗号化の外側には見えない設定だが、テスト用）
}

class RingMeshWithGossip {
  private nodes: Map<number, NodeData> = new Map();
  private nextId = 0;
  private localLinks: number;
  private longRangeLinks: number;
  private maxDegree: number;
  // シミュレーション時間
  simTime = 0;
  // メトリクス
  metrics = {
    gossipSent: 0,
    gossipReceived: 0,
    deliveries: new Map<string, { nodeId: number; time: number; hops: number }[]>(),
    dhtPuts: 0,
    dhtGets: 0,
    dhtHits: 0,
    dhtMisses: 0,
  };

  constructor(localLinks: number, longRangeLinks: number, maxDegree: number) {
    this.localLinks = localLinks;
    this.longRangeLinks = longRangeLinks;
    this.maxDegree = maxDegree;
  }

  get nodeCount(): number { return this.nodes.size; }
  get nodeIds(): number[] { return Array.from(this.nodes.keys()); }

  private ringDist(a: number, b: number): number {
    const d = Math.abs(a - b); return Math.min(d, 1 - d);
  }
  private deg(id: number): number { return this.nodes.get(id)?.neighbors.size ?? 0; }
  private sorted(): NodeData[] {
    return Array.from(this.nodes.values()).sort((a, b) => a.position - b.position);
  }

  /** ローカルリンクのIDセットを返す（リング上の左右 halfLocal 人ずつ） */
  private getLocalNeighborIds(id: number): Set<number> {
    const s = this.sorted();
    const myIdx = s.findIndex(n => n.id === id);
    const n = s.length;
    const halfLocal = Math.ceil(this.localLinks / 2);
    const localIds = new Set<number>();
    for (let i = 1; i <= halfLocal && i < n; i++) {
      localIds.add(s[(myIdx - i + n) % n].id);
      localIds.add(s[(myIdx + i) % n].id);
    }
    return localIds;
  }

  /** 通常の接続（MAX超過なら拒否） */
  private connect(a: number, b: number): boolean {
    if (this.deg(a) >= this.maxDegree || this.deg(b) >= this.maxDegree) return false;
    if (a === b) return false;
    const na = this.nodes.get(a), nb = this.nodes.get(b);
    if (!na || !nb) return false;
    if (na.neighbors.has(b)) return true; // 既に接続済み
    na.neighbors.add(b);
    nb.neighbors.add(a);
    return true;
  }

  /** ローカルリンク優先接続: 相手がMAX超過でもロングレンジを1本切って枠を空ける */
  private connectLocal(a: number, b: number): boolean {
    if (a === b) return false;
    const na = this.nodes.get(a), nb = this.nodes.get(b);
    if (!na || !nb) return false;
    if (na.neighbors.has(b)) return true;

    // 自分側の枠確保
    if (this.deg(a) >= this.maxDegree) {
      if (!this.evictLongRange(a)) return false;
    }
    // 相手側の枠確保
    if (this.deg(b) >= this.maxDegree) {
      if (!this.evictLongRange(b)) return false;
    }

    na.neighbors.add(b);
    nb.neighbors.add(a);
    return true;
  }

  /** ロングレンジリンクを1本切って枠を空ける */
  private evictLongRange(id: number): boolean {
    const node = this.nodes.get(id);
    if (!node) return false;
    const localIds = this.getLocalNeighborIds(id);
    // ローカルでない接続 = ロングレンジ
    const longRange = Array.from(node.neighbors).filter(nid => !localIds.has(nid));
    if (longRange.length === 0) return false;
    // ランダムに1本切る
    const victim = longRange[Math.floor(Math.random() * longRange.length)];
    node.neighbors.delete(victim);
    this.nodes.get(victim)?.neighbors.delete(id);
    return true;
  }

  addNode(subscribedTopics: string[] = []): number {
    const id = this.nextId++;
    this.nodes.set(id, {
      id, position: Math.random(), neighbors: new Set(),
      seenPackets: new Set(),
      mailbox: new Map(),
      subscribedTopics: new Set(subscribedTopics),
    });
    if (this.nodes.size <= 1) return id;

    // ローカルリンク（優先接続）
    const localIds = this.getLocalNeighborIds(id);
    for (const lid of localIds) {
      this.connectLocal(id, lid);
    }

    // ロングレンジリンク（通常接続）
    const node = this.nodes.get(id)!;
    const remaining = this.maxDegree - this.deg(id);
    if (remaining > 0) {
      const candidates = Array.from(this.nodes.values()).filter(nd =>
        nd.id !== id && !node.neighbors.has(nd.id) &&
        this.deg(nd.id) < this.maxDegree &&
        this.ringDist(node.position, nd.position) >= 0.2
      );
      this.shuffleArr(candidates);
      for (let i = 0; i < Math.min(remaining, this.longRangeLinks, candidates.length); i++) {
        this.connect(id, candidates[i].id);
      }
    }
    return id;
  }

  removeNode(id: number): void {
    const node = this.nodes.get(id);
    if (!node) return;
    const s = this.sorted();
    const myIdx = s.findIndex(n => n.id === id);
    const n = s.length;
    const halfLocal = Math.ceil(this.localLinks / 2);
    const repair: number[] = [];
    for (let i = 1; i <= halfLocal + 1 && i < n; i++) {
      const l = s[(myIdx - i + n) % n]; const r = s[(myIdx + i) % n];
      if (l.id !== id) repair.push(l.id);
      if (r.id !== id) repair.push(r.id);
    }
    for (const nid of node.neighbors) this.nodes.get(nid)?.neighbors.delete(id);
    this.nodes.delete(id);
    // ローカルリンク優先修復
    for (const nid of repair) {
      if (!this.nodes.has(nid)) continue;
      const localIds = this.getLocalNeighborIds(nid);
      for (const lid of localIds) {
        this.connectLocal(nid, lid);
      }
    }
  }

  repairAll(): void {
    for (const id of this.nodeIds) {
      // ローカルリンク優先修復
      const localIds = this.getLocalNeighborIds(id);
      for (const lid of localIds) {
        this.connectLocal(id, lid);
      }
      // ロングレンジ補充
      const remaining = this.maxDegree - this.deg(id);
      if (remaining > 0) {
        const node = this.nodes.get(id)!;
        const cands = Array.from(this.nodes.values()).filter(nd =>
          nd.id !== id && !node.neighbors.has(nd.id) &&
          this.deg(nd.id) < this.maxDegree &&
          this.ringDist(node.position, nd.position) >= 0.2
        );
        this.shuffleArr(cands);
        for (let i = 0; i < Math.min(remaining, cands.length); i++) this.connect(id, cands[i].id);
      }
    }
  }

  // ═══ ゴシップ (Broadcast Veil) ═══

  /**
   * Broadcast Veil: BFS（幅優先）で全方向に同時伝播
   * 各ノードは自分の鍵で復号を試みる
   */
  broadcastGossip(authorId: number, topicHash: string, content: string): void {
    const packetId = `pkt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    this.metrics.deliveries.set(packetId, []);
    const author = this.nodes.get(authorId);
    if (!author) return;

    // BFSキュー: { nodeId, hopCount }
    const queue: { nodeId: number; hops: number }[] = [{ nodeId: authorId, hops: 0 }];
    author.seenPackets.add(packetId);
    const maxHops = 30;

    while (queue.length > 0) {
      const { nodeId, hops } = queue.shift()!;
      const node = this.nodes.get(nodeId);
      if (!node) continue;
      if (hops >= maxHops) continue;

      for (const neighborId of node.neighbors) {
        const neighbor = this.nodes.get(neighborId);
        if (!neighbor) continue;
        if (neighbor.seenPackets.has(packetId)) continue;  // 重複排除

        neighbor.seenPackets.add(packetId);
        this.metrics.gossipSent++;
        this.metrics.gossipReceived++;

        // 復号判定
        if (neighbor.subscribedTopics.has(topicHash)) {
          this.metrics.deliveries.get(packetId)?.push({
            nodeId: neighborId,
            time: this.simTime + (hops + 1) * 40,
            hops: hops + 1,
          });
        }

        queue.push({ nodeId: neighborId, hops: hops + 1 });
      }
    }
  }

  // ═══ Mailbox (DHT) ═══

  /**
   * topicHash に最も近い円環位置のK人をMailbox担当とする
   */
  findMailboxNodes(topicHash: string, k: number = 5): number[] {
    // topicHashを円環位置に変換（簡易ハッシュ）
    let hash = 0;
    for (let i = 0; i < topicHash.length; i++) {
      hash = ((hash << 5) - hash + topicHash.charCodeAt(i)) | 0;
    }
    const targetPos = Math.abs(hash % 10000) / 10000;

    // 全ノードを円環距離でソート
    const sorted = Array.from(this.nodes.values())
      .map(n => ({ id: n.id, dist: this.ringDist(n.position, targetPos) }))
      .sort((a, b) => a.dist - b.dist);

    return sorted.slice(0, k).map(n => n.id);
  }

  /** Mailbox に暗号化データを保管 */
  dhtPut(topicHash: string, data: string, k: number = 5): { stored: number; nodes: number[] } {
    const mailboxNodes = this.findMailboxNodes(topicHash, k);
    let stored = 0;
    for (const nid of mailboxNodes) {
      const node = this.nodes.get(nid);
      if (!node) continue;
      if (!node.mailbox.has(topicHash)) node.mailbox.set(topicHash, []);
      node.mailbox.get(topicHash)!.push(new TextEncoder().encode(data));
      stored++;
      this.metrics.dhtPuts++;
    }
    return { stored, nodes: mailboxNodes };
  }

  /** Mailbox からデータを取得 */
  dhtGet(topicHash: string, k: number = 5): { found: boolean; copies: number; data: string[] } {
    const mailboxNodes = this.findMailboxNodes(topicHash, k);
    const results: string[] = [];
    this.metrics.dhtGets++;

    for (const nid of mailboxNodes) {
      const node = this.nodes.get(nid);
      if (!node) continue;
      const entries = node.mailbox.get(topicHash);
      if (entries && entries.length > 0) {
        for (const e of entries) results.push(new TextDecoder().decode(e));
      }
    }

    if (results.length > 0) {
      this.metrics.dhtHits++;
    } else {
      this.metrics.dhtMisses++;
    }
    return { found: results.length > 0, copies: results.length, data: results };
  }

  /** 全ノードのseenPacketsをクリア */
  clearSeen(): void {
    for (const [, node] of this.nodes) node.seenPackets.clear();
  }

  // connectivity check
  isFullyConnected(): boolean {
    const ids = this.nodeIds;
    if (ids.length === 0) return true;
    const visited = new Set<number>();
    const q = [ids[0]]; visited.add(ids[0]);
    while (q.length > 0) {
      const c = q.shift()!;
      for (const n of this.nodes.get(c)?.neighbors ?? []) {
        if (!visited.has(n)) { visited.add(n); q.push(n); }
      }
    }
    return visited.size === ids.length;
  }

  // ── Utility ──
  private shuffleArr<T>(a: T[]): void {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
  }
}

// ═══ テスト実行 ═══

function shuffle<T>(a: T[]): void {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
}

function sep(t: string): void {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  ${t}`);
  console.log('═'.repeat(70));
}

console.log('🌐 Ring-Mesh ゴシップ + Mailbox 統合テスト');
console.log(`   実行日時: ${new Date().toISOString()}\n`);

// ═══ テスト1: ゴシップ配信率 ═══

sep('テスト1: ゴシップ配信率 (Broadcast Veil)');

const TOPIC_VIP = 'topic:vip';
const TOPIC_ANIME = 'topic:anime';

for (const nodeCount of [100, 500, 1000]) {
  const sim = new RingMeshWithGossip(4, 4, 8);

  // ノード追加（30%がVIP購読、20%がアニメ購読、10%が両方）
  for (let i = 0; i < nodeCount; i++) {
    const topics: string[] = [];
    const r = Math.random();
    if (r < 0.10) { topics.push(TOPIC_VIP, TOPIC_ANIME); }
    else if (r < 0.30) { topics.push(TOPIC_VIP); }
    else if (r < 0.50) { topics.push(TOPIC_ANIME); }
    sim.addNode(topics);
  }
  for (let r = 0; r < 3; r++) sim.repairAll();

  // VIP板に投稿
  const authorId = sim.nodeIds[Math.floor(Math.random() * sim.nodeCount)];
  sim.broadcastGossip(authorId, TOPIC_VIP, 'キタ━━━(゜∀゜)━━━!!');

  const deliveries = sim.metrics.deliveries.values().next().value as any[];
  const vipSubscribers = sim.nodeIds.filter(id => {
    // authorは除外
    return id !== authorId;
  });

  // VIP購読者数を数える
  let vipCount = 0;
  for (const id of sim.nodeIds) {
    if (id === authorId) continue;
    // subscribedTopicsにアクセスできないので deliveries から判定
  }

  const totalDelivered = deliveries?.length ?? 0;

  // 全ノードへの到達率（Broadcast Veilなので全ノードに届くはず）
  const reachRate = ((sim.metrics.gossipReceived) / (sim.nodeCount - 1) * 100);

  console.log(`\n  📊 ${nodeCount}ノード:`);
  console.log(`    連結: ${sim.isFullyConnected() ? '✅' : '❌'}`);
  console.log(`    ゴシップ送信: ${sim.metrics.gossipSent}回`);
  console.log(`    到達ノード数: ${sim.metrics.gossipReceived} / ${nodeCount - 1}`);
  console.log(`    到達率: ${reachRate.toFixed(1)}%`);
  console.log(`    VIP購読者への配達: ${totalDelivered}人`);
  console.log(`    帯域(1メッセージあたりの中継回数): ${sim.metrics.gossipSent}`);

  // リセット
  sim.metrics.gossipSent = 0;
  sim.metrics.gossipReceived = 0;
  sim.metrics.deliveries.clear();
  sim.clearSeen();
}

// ═══ テスト2: 複数メッセージ配信 ═══

sep('テスト2: 複数メッセージの連続配信 (1000ノード)');

const sim2 = new RingMeshWithGossip(4, 4, 8);
for (let i = 0; i < 1000; i++) {
  const topics: string[] = [];
  if (Math.random() < 0.3) topics.push(TOPIC_VIP);
  if (Math.random() < 0.2) topics.push(TOPIC_ANIME);
  sim2.addNode(topics);
}
for (let r = 0; r < 3; r++) sim2.repairAll();

let totalReach = 0;
const msgCount = 20;

for (let m = 0; m < msgCount; m++) {
  sim2.clearSeen();
  sim2.metrics.gossipSent = 0;
  sim2.metrics.gossipReceived = 0;

  const author = sim2.nodeIds[Math.floor(Math.random() * sim2.nodeCount)];
  sim2.broadcastGossip(author, TOPIC_VIP, `メッセージ${m}`);

  const reach = sim2.metrics.gossipReceived / (sim2.nodeCount - 1) * 100;
  totalReach += reach;
}

console.log(`  ${msgCount}メッセージの平均到達率: ${(totalReach / msgCount).toFixed(2)}%`);

// ═══ テスト3: Mailbox (DHT) ═══

sep('テスト3: Mailbox (DHT K-Replication)');

const sim3 = new RingMeshWithGossip(4, 4, 8);
for (let i = 0; i < 1000; i++) sim3.addNode([TOPIC_VIP]);
for (let r = 0; r < 3; r++) sim3.repairAll();

// スレッドにデータを保管
const threadTopic = 'thread:vip:12345';
console.log('\n  ── PUT: スレッドデータを Mailbox に保管 ──');
const putResult = sim3.dhtPut(threadTopic, '>>1 VIPからき☆すた', 5);
console.log(`    保管先ノード: ${putResult.nodes.join(', ')} (${putResult.stored}/${5}冗長)`);

sim3.dhtPut(threadTopic, '>>2 そうだよ', 5);
sim3.dhtPut(threadTopic, '>>3 神スレ', 5);

// データ取得
console.log('\n  ── GET: Mailbox からデータ取得 ──');
const getResult = sim3.dhtGet(threadTopic, 5);
console.log(`    取得成功: ${getResult.found ? '✅' : '❌'}`);
console.log(`    コピー数: ${getResult.copies}`);
console.log(`    データ: ${getResult.data.slice(0, 5).join(' | ')}`);

// Mailboxノードが50%死亡してもデータが取れるか
console.log('\n  ── Mailboxノード50%死亡テスト ──');
const mailboxNodes = sim3.findMailboxNodes(threadTopic, 5);
console.log(`    Mailboxノード: ${mailboxNodes.join(', ')}`);

// 5人中3人を殺す
for (let i = 0; i < 3; i++) {
  sim3.removeNode(mailboxNodes[i]);
  console.log(`    ノード${mailboxNodes[i]}を削除`);
}
sim3.repairAll();

const getAfterDeath = sim3.dhtGet(threadTopic, 5);
console.log(`    取得成功: ${getAfterDeath.found ? '✅' : '❌'}`);
console.log(`    残存コピー数: ${getAfterDeath.copies}`);

// ═══ テスト4: ゴシップ + ノード削除 ═══

sep('テスト4: 30%ノード削除後のゴシップ到達率');

const sim4 = new RingMeshWithGossip(4, 4, 8);
for (let i = 0; i < 1000; i++) {
  sim4.addNode(Math.random() < 0.3 ? [TOPIC_VIP] : []);
}
for (let r = 0; r < 3; r++) sim4.repairAll();

// 削除前
sim4.clearSeen();
sim4.metrics.gossipSent = 0;
sim4.metrics.gossipReceived = 0;
let author = sim4.nodeIds[0];
sim4.broadcastGossip(author, TOPIC_VIP, 'テスト');
const beforeRate = sim4.metrics.gossipReceived / (sim4.nodeCount - 1) * 100;
console.log(`\n  削除前: 到達率 ${beforeRate.toFixed(1)}% (${sim4.metrics.gossipReceived}/${sim4.nodeCount - 1})`);

// 30%削除
const ids4 = sim4.nodeIds;
shuffle(ids4);
for (let i = 0; i < 300; i++) sim4.removeNode(ids4[i]);
sim4.repairAll();

// 削除後
sim4.clearSeen();
sim4.metrics.gossipSent = 0;
sim4.metrics.gossipReceived = 0;
author = sim4.nodeIds[0];
sim4.broadcastGossip(author, TOPIC_VIP, 'テスト2');
const afterRate = sim4.metrics.gossipReceived / (sim4.nodeCount - 1) * 100;
console.log(`  30%削除+修復後: 到達率 ${afterRate.toFixed(1)}% (${sim4.metrics.gossipReceived}/${sim4.nodeCount - 1})`);
console.log(`  連結: ${sim4.isFullyConnected() ? '✅' : '❌'}`);

// ═══ テスト5: Mailbox の再配置（Churn後） ═══

sep('テスト5: Churn後のMailbox再配置');

const sim5 = new RingMeshWithGossip(4, 4, 8);
for (let i = 0; i < 500; i++) sim5.addNode([TOPIC_VIP]);
for (let r = 0; r < 3; r++) sim5.repairAll();

// データ保管
const topic5 = 'thread:vip:99999';
sim5.dhtPut(topic5, '重要なデータ', 5);
const originalNodes = sim5.findMailboxNodes(topic5, 5);
console.log(`\n  保管先ノード: ${originalNodes.join(', ')}`);

// Churn: 30% 入れ替え
const ids5 = sim5.nodeIds;
shuffle(ids5);
for (let i = 0; i < 150; i++) sim5.removeNode(ids5[i]);
for (let i = 0; i < 150; i++) sim5.addNode([TOPIC_VIP]);
sim5.repairAll();

const newNodes = sim5.findMailboxNodes(topic5, 5);
const surviving = originalNodes.filter(id => sim5.nodeIds.includes(id));
console.log(`  Churn後の担当ノード: ${newNodes.join(', ')}`);
console.log(`  元の担当で生存: ${surviving.length}/5`);

const getAfterChurn = sim5.dhtGet(topic5, 5);
console.log(`  データ取得: ${getAfterChurn.found ? '✅' : '❌'} (コピー: ${getAfterChurn.copies})`);
if (surviving.length >= 1 && getAfterChurn.found) {
  console.log(`  → 生存ノードがデータを保持 → 新担当への再レプリケーションが必要`);
}

console.log(`\n${'═'.repeat(70)}`);
console.log('  ✅ 全テスト完了');
console.log('═'.repeat(70));
