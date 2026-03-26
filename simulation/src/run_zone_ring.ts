/**
 * Ring-Mesh + Zone Gossip 統合シミュレーション
 *
 * 256ゾーン、各ノード16ゾーン購読。
 * Ring backbone + Zone-aware connections でゾーン内ゴシップが回るか検証。
 * MAX接続数を変えて最適値を探す。
 */

interface ZoneNodeData {
  id: number;
  position: number;  // Ring position [0, 1)
  neighbors: Set<number>;
  zones: Set<number>;  // 購読ゾーン（16個）
}

class ZoneRingMesh {
  private nodes: Map<number, ZoneNodeData> = new Map();
  private nextId = 0;
  private ringLocal: number;
  private maxDegree: number;
  private totalZones: number;
  private zonesPerNode: number;

  constructor(ringLocal: number, maxDegree: number, totalZones = 256, zonesPerNode = 16) {
    this.ringLocal = ringLocal;
    this.maxDegree = maxDegree;
    this.totalZones = totalZones;
    this.zonesPerNode = zonesPerNode;
  }

  get nodeCount(): number { return this.nodes.size; }
  get nodeIds(): number[] { return Array.from(this.nodes.keys()); }

  private ringDist(a: number, b: number): number {
    const d = Math.abs(a - b); return Math.min(d, 1 - d);
  }
  private deg(id: number): number { return this.nodes.get(id)?.neighbors.size ?? 0; }
  private sorted(): ZoneNodeData[] {
    return Array.from(this.nodes.values()).sort((a, b) => a.position - b.position);
  }

  /** 2ノード間の共有ゾーン数 */
  private sharedZones(a: number, b: number): number {
    const za = this.nodes.get(a)?.zones;
    const zb = this.nodes.get(b)?.zones;
    if (!za || !zb) return 0;
    let count = 0;
    for (const z of za) if (zb.has(z)) count++;
    return count;
  }

  /** ローカルリンクのIDセットを返す */
  private getLocalIds(id: number): Set<number> {
    const s = this.sorted();
    const myIdx = s.findIndex(n => n.id === id);
    const n = s.length;
    const half = Math.ceil(this.ringLocal / 2);
    const ids = new Set<number>();
    for (let i = 1; i <= half && i < n; i++) {
      ids.add(s[(myIdx - i + n) % n].id);
      ids.add(s[(myIdx + i) % n].id);
    }
    return ids;
  }

  private connect(a: number, b: number): boolean {
    if (this.deg(a) >= this.maxDegree || this.deg(b) >= this.maxDegree) return false;
    if (a === b) return false;
    const na = this.nodes.get(a), nb = this.nodes.get(b);
    if (!na || !nb) return false;
    if (na.neighbors.has(b)) return true;
    na.neighbors.add(b);
    nb.neighbors.add(a);
    return true;
  }

  private connectLocal(a: number, b: number): boolean {
    if (a === b) return false;
    const na = this.nodes.get(a), nb = this.nodes.get(b);
    if (!na || !nb) return false;
    if (na.neighbors.has(b)) return true;
    if (this.deg(a) >= this.maxDegree) { if (!this.evictNonLocal(a)) return false; }
    if (this.deg(b) >= this.maxDegree) { if (!this.evictNonLocal(b)) return false; }
    na.neighbors.add(b);
    nb.neighbors.add(a);
    return true;
  }

  private evictNonLocal(id: number): boolean {
    const node = this.nodes.get(id);
    if (!node) return false;
    const localIds = this.getLocalIds(id);
    const nonLocal = Array.from(node.neighbors).filter(n => !localIds.has(n));
    if (nonLocal.length === 0) return false;
    const victim = nonLocal[Math.floor(Math.random() * nonLocal.length)];
    node.neighbors.delete(victim);
    this.nodes.get(victim)?.neighbors.delete(id);
    return true;
  }

  /** ランダムに16ゾーンを割り当て */
  private assignZones(): Set<number> {
    const zones = new Set<number>();
    while (zones.size < this.zonesPerNode) {
      zones.add(Math.floor(Math.random() * this.totalZones));
    }
    return zones;
  }

  addNode(): number {
    const id = this.nextId++;
    this.nodes.set(id, {
      id, position: Math.random(),
      neighbors: new Set(),
      zones: this.assignZones(),
    });
    if (this.nodes.size <= 1) return id;

    // Ring local links (優先)
    const localIds = this.getLocalIds(id);
    for (const lid of localIds) this.connectLocal(id, lid);

    // Zone-aware connections (残りの枠)
    this.fillZoneConnections(id);
    return id;
  }

  /** ゾーンメイトを優先して接続を埋める */
  private fillZoneConnections(id: number): void {
    const node = this.nodes.get(id)!;
    const remaining = this.maxDegree - this.deg(id);
    if (remaining <= 0) return;

    // 全候補をゾーン共有数でソート（多い順）
    const candidates = Array.from(this.nodes.values())
      .filter(n => n.id !== id && !node.neighbors.has(n.id) && this.deg(n.id) < this.maxDegree)
      .map(n => ({ id: n.id, shared: this.sharedZones(id, n.id) }))
      .filter(c => c.shared > 0)  // ゾーン共有がある相手のみ
      .sort((a, b) => b.shared - a.shared);  // 共有ゾーン数が多い順

    let filled = 0;
    for (const c of candidates) {
      if (filled >= remaining) break;
      if (this.connect(id, c.id)) filled++;
    }

    // まだ枠があればランダム（ロングレンジ）
    if (filled < remaining) {
      const rngCandidates = Array.from(this.nodes.values())
        .filter(n => n.id !== id && !node.neighbors.has(n.id) &&
                this.deg(n.id) < this.maxDegree &&
                this.ringDist(node.position, n.position) >= 0.2);
      this.shuffleArr(rngCandidates);
      for (const c of rngCandidates) {
        if (filled >= remaining) break;
        if (this.connect(id, c.id)) filled++;
      }
    }
  }

  removeNode(id: number): void {
    const node = this.nodes.get(id);
    if (!node) return;
    const localIds = this.getLocalIds(id);
    const repairIds = new Set([...localIds]);
    for (const nid of node.neighbors) this.nodes.get(nid)?.neighbors.delete(id);
    this.nodes.delete(id);
    for (const nid of repairIds) {
      if (!this.nodes.has(nid)) continue;
      for (const lid of this.getLocalIds(nid)) this.connectLocal(nid, lid);
    }
  }

  repairAll(): void {
    for (const id of this.nodeIds) {
      for (const lid of this.getLocalIds(id)) this.connectLocal(id, lid);
      this.fillZoneConnections(id);
    }
  }

  // ═══ ゾーン内ゴシップ ═══

  /** 特定ゾーン内でBFS Gossip。ゾーン内のみリレー。 */
  zoneGossip(authorId: number, zoneId: number): {
    totalInZone: number;   // ゾーン内の全ノード数
    reached: number;       // ゴシップ到達数
    reachRate: number;     // 到達率
    maxHops: number;       // 最大ホップ
    relays: number;        // 中継回数（帯域コスト）
  } {
    // ゾーン内ノードを全列挙
    const zoneMembers = this.nodeIds.filter(id => this.nodes.get(id)!.zones.has(zoneId));
    if (zoneMembers.length === 0) return { totalInZone: 0, reached: 0, reachRate: 1, maxHops: 0, relays: 0 };

    // BFS（ゾーン内の隣人のみを辿る）
    const seen = new Set<number>();
    const queue: { id: number; hops: number }[] = [{ id: authorId, hops: 0 }];
    seen.add(authorId);
    let maxHops = 0;
    let relays = 0;

    while (queue.length > 0) {
      const { id, hops } = queue.shift()!;
      const node = this.nodes.get(id);
      if (!node) continue;

      for (const nid of node.neighbors) {
        if (seen.has(nid)) continue;
        const neighbor = this.nodes.get(nid);
        if (!neighbor) continue;
        if (!neighbor.zones.has(zoneId)) continue;  // ★ ゾーン外ノードはスキップ

        seen.add(nid);
        relays++;
        if (hops + 1 > maxHops) maxHops = hops + 1;
        queue.push({ id: nid, hops: hops + 1 });
      }
    }

    const reached = seen.size - (this.nodes.get(authorId)?.zones.has(zoneId) ? 0 : 1);
    const expectedReach = zoneMembers.length - (this.nodes.get(authorId)?.zones.has(zoneId) ? 1 : 0);

    return {
      totalInZone: zoneMembers.length,
      reached,
      reachRate: expectedReach > 0 ? reached / expectedReach : 1,
      maxHops,
      relays,
    };
  }

  /** 全ゾーンのゴシップ到達率を計算 */
  testAllZoneGossip(): {
    avgReachRate: number;
    minReachRate: number;
    emptyZones: number;
    avgHops: number;
    avgRelays: number;
    avgZoneDegree: number;
  } {
    let totalRate = 0, minRate = 1, count = 0, totalHops = 0, totalRelays = 0;
    let emptyZones = 0;
    let totalZoneDeg = 0, zoneDegCount = 0;

    for (let z = 0; z < this.totalZones; z++) {
      const members = this.nodeIds.filter(id => this.nodes.get(id)!.zones.has(z));
      if (members.length <= 1) { emptyZones++; continue; }

      // ランダムな作者からゴシップ
      const author = members[Math.floor(Math.random() * members.length)];
      const result = this.zoneGossip(author, z);

      totalRate += result.reachRate;
      if (result.reachRate < minRate) minRate = result.reachRate;
      totalHops += result.maxHops;
      totalRelays += result.relays;
      count++;

      // ゾーン内の平均接続数
      for (const m of members) {
        const node = this.nodes.get(m)!;
        let zoneDeg = 0;
        for (const n of node.neighbors) {
          if (this.nodes.get(n)?.zones.has(z)) zoneDeg++;
        }
        totalZoneDeg += zoneDeg;
        zoneDegCount++;
      }
    }

    return {
      avgReachRate: count > 0 ? totalRate / count : 1,
      minReachRate: minRate,
      emptyZones,
      avgHops: count > 0 ? totalHops / count : 0,
      avgRelays: count > 0 ? totalRelays / count : 0,
      avgZoneDegree: zoneDegCount > 0 ? totalZoneDeg / zoneDegCount : 0,
    };
  }

  // stats
  getStats() {
    const ids = this.nodeIds;
    const degs = ids.map(id => this.deg(id));
    const avg = degs.reduce((a,b)=>a+b,0)/ids.length;
    const sd = Math.sqrt(degs.reduce((s,d)=>s+(d-avg)**2,0)/ids.length);

    // 平均ゾーン共有数
    let totalShared = 0, connCount = 0;
    for (const id of ids) {
      for (const nid of this.nodes.get(id)!.neighbors) {
        if (nid > id) { totalShared += this.sharedZones(id, nid); connCount++; }
      }
    }

    return {
      totalNodes: ids.length,
      avgDeg: avg, sdDeg: sd,
      minDeg: Math.min(...degs), maxDeg: Math.max(...degs),
      avgSharedZones: connCount > 0 ? totalShared / connCount : 0,
      isConnected: this.isFullyConnected(),
    };
  }

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

console.log('🌐 Ring-Mesh + Zone Gossip 統合シミュレーション');
console.log(`   実行日時: ${new Date().toISOString()}\n`);

// ═══ テスト1: MAX接続数 × ゾーンゴシップ到達率 ═══

console.log('═══ テスト1: MAX接続数のスイープ (1000ノード, 256ゾーン, 16ゾーン/ノード) ═══\n');
console.log('  MAX │ avg度数 │ σ    │ 連結 │ avgZoneDeg │ avgZone到達率 │ min到達率 │ 空Zone │ avgZone共有');
console.log('  ────┼────────┼──────┼──────┼───────────┼─────────────┼─────────┼───────┼──────────');

for (const maxDeg of [8, 10, 12, 16, 20, 24]) {
  const sim = new ZoneRingMesh(4, maxDeg, 256, 16);
  for (let i = 0; i < 1000; i++) sim.addNode();
  sim.repairAll();

  const stats = sim.getStats();
  const zoneResults = sim.testAllZoneGossip();

  console.log(
    `   ${String(maxDeg).padStart(2)} │ ${stats.avgDeg.toFixed(1).padStart(6)} │ ${stats.sdDeg.toFixed(2).padStart(4)} │  ${stats.isConnected?'✅':'❌'}  │   ${zoneResults.avgZoneDegree.toFixed(2).padStart(5)}   │    ${(zoneResults.avgReachRate*100).toFixed(1).padStart(5)}%   │  ${(zoneResults.minReachRate*100).toFixed(0).padStart(4)}%   │  ${String(zoneResults.emptyZones).padStart(4)} │   ${stats.avgSharedZones.toFixed(2)}`
  );
}

// ═══ テスト2: ゾーン数のスイープ ═══

console.log('\n═══ テスト2: ゾーン構成のスイープ (1000ノード, MAX=16) ═══\n');
console.log('  ゾーン数 │ 購読数 │ avgZoneDeg │ 到達率    │ min   │ 帯域削減率 │ K-匿名');
console.log('  ────────┼───────┼───────────┼──────────┼──────┼──────────┼───────');

const zoneConfigs = [
  { total: 16,  per: 4,  label: ' 16/ 4' },
  { total: 32,  per: 8,  label: ' 32/ 8' },
  { total: 64,  per: 8,  label: ' 64/ 8' },
  { total: 128, per: 16, label: '128/16' },
  { total: 256, per: 16, label: '256/16' },
];

for (const cfg of zoneConfigs) {
  const sim = new ZoneRingMesh(4, 16, cfg.total, cfg.per);
  for (let i = 0; i < 1000; i++) sim.addNode();
  sim.repairAll();

  const zr = sim.testAllZoneGossip();
  const bwReduction = ((1 - cfg.per / cfg.total) * 100).toFixed(1);
  const kAnon = ((cfg.per / cfg.total) * 100).toFixed(1);

  console.log(
    `  ${cfg.label}   │   ${String(cfg.per).padStart(3)}  │   ${zr.avgZoneDegree.toFixed(2).padStart(5)}   │ ${(zr.avgReachRate*100).toFixed(1).padStart(6)}%   │ ${(zr.minReachRate*100).toFixed(0).padStart(4)}% │   ${bwReduction.padStart(5)}%   │  ${kAnon}%`
  );
}

// ═══ テスト3: 推奨構成の詳細テスト ═══

console.log('\n═══ テスト3: 推奨構成の詳細テスト ═══\n');

// MAX=16ならまだブラウザ的にOKか → 256/16で動くか検証

for (const nodeCount of [500, 1000, 5000]) {
  console.log(`\n  ── ${nodeCount}ノード (MAX=16, 256ゾーン, 16購読) ──`);
  const sim = new ZoneRingMesh(4, 16, 256, 16);
  for (let i = 0; i < nodeCount; i++) sim.addNode();
  sim.repairAll();

  const stats = sim.getStats();
  const zr = sim.testAllZoneGossip();

  console.log(`    連結: ${stats.isConnected?'✅':'❌'} | deg: ${stats.avgDeg.toFixed(1)} σ=${stats.sdDeg.toFixed(2)} [${stats.minDeg}..${stats.maxDeg}]`);
  console.log(`    avg Zone共有: ${stats.avgSharedZones.toFixed(2)}`);
  console.log(`    Zone到達率: avg=${(zr.avgReachRate*100).toFixed(1)}% min=${(zr.minReachRate*100).toFixed(0)}% 空Zone=${zr.emptyZones}`);
  console.log(`    Zone内度数: ${zr.avgZoneDegree.toFixed(2)} | avg中継: ${zr.avgRelays.toFixed(0)} | avgホップ: ${zr.avgHops.toFixed(1)}`);

  // 帯域計算
  const msgsPerMin = Math.floor(nodeCount * 0.01); // 1%が毎分投稿
  const msgsPerNodePerMin = msgsPerMin * (16 / 256); // 購読ゾーンのみ
  const bwPerNode = msgsPerNodePerMin * 16 * 1; // degree * 1KB
  console.log(`    帯域: ${msgsPerMin}msg/min → ${msgsPerNodePerMin.toFixed(0)}msg関連/min → ${(bwPerNode/60).toFixed(1)}KB/s per node`);
}

// ═══ テスト4: 30%ノード削除後のゾーンゴシップ ═══

console.log('\n═══ テスト4: 30%削除後のゾーンゴシップ復旧 ═══\n');

const sim4 = new ZoneRingMesh(4, 16, 256, 16);
for (let i = 0; i < 1000; i++) sim4.addNode();
sim4.repairAll();

const before4 = sim4.testAllZoneGossip();
console.log(`  削除前: Zone到達率=${(before4.avgReachRate*100).toFixed(1)}% min=${(before4.minReachRate*100).toFixed(0)}%`);

const ids4 = sim4.nodeIds; shuffle(ids4);
for (let i = 0; i < 300; i++) sim4.removeNode(ids4[i]);
sim4.repairAll();

const after4 = sim4.testAllZoneGossip();
console.log(`  30%削除+修復: Zone到達率=${(after4.avgReachRate*100).toFixed(1)}% min=${(after4.minReachRate*100).toFixed(0)}% 連結=${sim4.isFullyConnected()?'✅':'❌'}`);

console.log(`\n${'═'.repeat(70)}`);
console.log('  ✅ 完了');
console.log('═'.repeat(70));
