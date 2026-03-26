/**
 * 適応的Zone分割（Adaptive Zone Depth）シミュレーション
 *
 * CIDRサブネッティング方式: ハッシュの先頭ビットでZoneを決定。
 * ノード数に応じてdepthが自動変化し、帯域を最適化。
 */

interface AdaptiveNode {
  id: number;
  position: number;
  neighbors: Set<number>;
  zones: Set<number>;
  hashBits: number;  // 0-255 のゾーン決定用ハッシュ
}

class AdaptiveZoneRingMesh {
  private nodes: Map<number, AdaptiveNode> = new Map();
  private nextId = 0;
  private ringLocal: number;
  private maxDegree: number;
  private maxDepth: number;
  private targetZonePop: number;
  private subscribeCount: number;
  private currentDepth: number = 0;

  constructor(
    ringLocal: number,
    maxDegree: number,
    maxDepth = 8,
    targetZonePop = 500,
    subscribeCount = 16,
  ) {
    this.ringLocal = ringLocal;
    this.maxDegree = maxDegree;
    this.maxDepth = maxDepth;
    this.targetZonePop = targetZonePop;
    this.subscribeCount = subscribeCount;
  }

  get nodeCount(): number { return this.nodes.size; }
  get nodeIds(): number[] { return Array.from(this.nodes.keys()); }
  get depth(): number { return this.currentDepth; }
  get totalZones(): number { return 1 << this.currentDepth; }

  /** ネットワークサイズからdepthを計算 */
  computeDepth(n?: number): number {
    const size = n ?? this.nodeCount;
    if (size <= this.targetZonePop) return 0;
    const raw = Math.ceil(Math.log2(size / this.targetZonePop));
    return Math.max(0, Math.min(this.maxDepth, raw));
  }

  /** ハッシュビットからゾーンIDを取得 */
  getZoneId(hashBits: number, depth: number): number {
    if (depth === 0) return 0;
    return hashBits >> (8 - depth);
  }

  /** ノードが購読するゾーンセットを(再)計算 */
  private computeSubscribedZones(node: AdaptiveNode): Set<number> {
    const totalZones = 1 << this.currentDepth;
    if (totalZones <= this.subscribeCount) {
      // Full Flood: 全ゾーン購読
      const all = new Set<number>();
      for (let i = 0; i < totalZones; i++) all.add(i);
      return all;
    }
    // 自分のスレッド用ゾーン(一意) + ダミー
    const zones = new Set<number>();
    // 自分のハッシュに基づくゾーン（必ず含む）
    zones.add(this.getZoneId(node.hashBits, this.currentDepth));
    // ダミー: ランダムに追加
    while (zones.size < this.subscribeCount) {
      zones.add(Math.floor(Math.random() * totalZones));
    }
    return zones;
  }

  /** 全ノードのゾーン購読を更新 */
  updateDepth(): void {
    this.currentDepth = this.computeDepth();
    for (const [, node] of this.nodes) {
      node.zones = this.computeSubscribedZones(node);
    }
  }

  // ── Ring-Mesh 基盤 ──

  private ringDist(a: number, b: number): number {
    const d = Math.abs(a - b); return Math.min(d, 1 - d);
  }
  private deg(id: number): number { return this.nodes.get(id)?.neighbors.size ?? 0; }
  private sorted(): AdaptiveNode[] {
    return Array.from(this.nodes.values()).sort((a, b) => a.position - b.position);
  }

  private sharedZones(a: number, b: number): number {
    const za = this.nodes.get(a)?.zones;
    const zb = this.nodes.get(b)?.zones;
    if (!za || !zb) return 0;
    let c = 0; for (const z of za) if (zb.has(z)) c++;
    return c;
  }

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
    na.neighbors.add(b); nb.neighbors.add(a);
    return true;
  }

  private connectLocal(a: number, b: number): boolean {
    if (a === b) return false;
    const na = this.nodes.get(a), nb = this.nodes.get(b);
    if (!na || !nb) return false;
    if (na.neighbors.has(b)) return true;
    if (this.deg(a) >= this.maxDegree) { if (!this.evictNonLocal(a)) return false; }
    if (this.deg(b) >= this.maxDegree) { if (!this.evictNonLocal(b)) return false; }
    na.neighbors.add(b); nb.neighbors.add(a);
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

  addNode(): number {
    const id = this.nextId++;
    this.nodes.set(id, {
      id, position: Math.random(),
      neighbors: new Set(),
      zones: new Set(),
      hashBits: Math.floor(Math.random() * 256),
    });
    if (this.nodes.size <= 1) { this.updateDepth(); return id; }

    // depthを再計算（ノード増加でdepthが変わる可能性）
    const newDepth = this.computeDepth();
    if (newDepth !== this.currentDepth) this.updateDepth();
    else this.nodes.get(id)!.zones = this.computeSubscribedZones(this.nodes.get(id)!);

    // Ring local
    for (const lid of this.getLocalIds(id)) this.connectLocal(id, lid);

    // Zone-aware connections
    this.fillZoneConnections(id);
    return id;
  }

  private fillZoneConnections(id: number): void {
    const node = this.nodes.get(id)!;
    const remaining = this.maxDegree - this.deg(id);
    if (remaining <= 0) return;

    const candidates = Array.from(this.nodes.values())
      .filter(n => n.id !== id && !node.neighbors.has(n.id) && this.deg(n.id) < this.maxDegree)
      .map(n => ({ id: n.id, shared: this.sharedZones(id, n.id) }))
      .filter(c => c.shared > 0)
      .sort((a, b) => b.shared - a.shared);

    let filled = 0;
    for (const c of candidates) {
      if (filled >= remaining) break;
      if (this.connect(id, c.id)) filled++;
    }

    if (filled < remaining) {
      const rngCands = Array.from(this.nodes.values())
        .filter(n => n.id !== id && !node.neighbors.has(n.id) &&
                this.deg(n.id) < this.maxDegree &&
                this.ringDist(node.position, n.position) >= 0.2);
      this.shuffleArr(rngCands);
      for (const c of rngCands) {
        if (filled >= remaining) break;
        if (this.connect(id, c.id)) filled++;
      }
    }
  }

  repairAll(): void {
    for (const id of this.nodeIds) {
      for (const lid of this.getLocalIds(id)) this.connectLocal(id, lid);
      this.fillZoneConnections(id);
    }
  }

  removeNode(id: number): void {
    const node = this.nodes.get(id);
    if (!node) return;
    for (const nid of node.neighbors) this.nodes.get(nid)?.neighbors.delete(id);
    this.nodes.delete(id);
    // depth再計算
    const nd = this.computeDepth();
    if (nd !== this.currentDepth) this.updateDepth();
  }

  // ── Zone Gossip ──

  zoneGossip(authorId: number, zoneId: number): {
    totalInZone: number; reached: number; reachRate: number; maxHops: number;
  } {
    const members = this.nodeIds.filter(id => this.nodes.get(id)!.zones.has(zoneId));
    if (members.length <= 1) return { totalInZone: members.length, reached: 0, reachRate: 1, maxHops: 0 };

    const seen = new Set<number>([authorId]);
    const queue: { id: number; hops: number }[] = [{ id: authorId, hops: 0 }];
    let maxHops = 0;

    while (queue.length > 0) {
      const { id, hops } = queue.shift()!;
      for (const nid of this.nodes.get(id)?.neighbors ?? []) {
        if (seen.has(nid)) continue;
        if (!this.nodes.get(nid)?.zones.has(zoneId)) continue;
        seen.add(nid);
        if (hops + 1 > maxHops) maxHops = hops + 1;
        queue.push({ id: nid, hops: hops + 1 });
      }
    }

    const reached = seen.size - 1;
    const expected = members.length - 1;
    return { totalInZone: members.length, reached, reachRate: expected > 0 ? reached / expected : 1, maxHops };
  }

  testAllZoneGossip(): { avgReach: number; minReach: number; empty: number; avgDeg: number } {
    const tz = this.totalZones;
    let totalR = 0, minR = 1, count = 0, empty = 0;
    let totalZDeg = 0, zdCount = 0;

    for (let z = 0; z < tz; z++) {
      const mem = this.nodeIds.filter(id => this.nodes.get(id)!.zones.has(z));
      if (mem.length <= 1) { empty++; continue; }
      const author = mem[Math.floor(Math.random() * mem.length)];
      const r = this.zoneGossip(author, z);
      totalR += r.reachRate;
      if (r.reachRate < minR) minR = r.reachRate;
      count++;
      for (const m of mem) {
        let zd = 0;
        for (const n of this.nodes.get(m)!.neighbors) if (this.nodes.get(n)?.zones.has(z)) zd++;
        totalZDeg += zd; zdCount++;
      }
    }

    return {
      avgReach: count > 0 ? totalR / count : 1,
      minReach: minR,
      empty,
      avgDeg: zdCount > 0 ? totalZDeg / zdCount : 0,
    };
  }

  isConnected(): boolean {
    const ids = this.nodeIds;
    if (ids.length === 0) return true;
    const visited = new Set<number>([ids[0]]);
    const q = [ids[0]];
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

// ═══ テスト ═══

console.log('🌐 適応的Zone分割 (Adaptive Zone Depth) シミュレーション');
console.log(`   実行日時: ${new Date().toISOString()}\n`);

// ═══ テスト1: 段階的成長に伴うdepth自動変化 ═══

console.log('═══ テスト1: 段階的成長 (MAX=16, TARGET_POP=500) ═══\n');
console.log('  ノード数 │ depth │ Zones │ 購読  │ 連結 │ Zone到達率 │ min   │ 帯域推定');
console.log('  ─────────┼───────┼───────┼──────┼──────┼──────────┼──────┼────────');

const sim1 = new AdaptiveZoneRingMesh(4, 16, 8, 500, 16);

for (const target of [50, 100, 500, 1000, 2000, 5000, 10000]) {
  while (sim1.nodeCount < target) sim1.addNode();
  sim1.repairAll();

  const tz = sim1.totalZones;
  const sub = Math.min(16, tz);
  const zr = sim1.testAllZoneGossip();
  const conn = sim1.isConnected();

  // 帯域推定: msgs/min = N*1%, per node = msgs * sub/tz * degree * 1KB / 60
  const msgs = target * 0.01;
  const bw = msgs * (sub / tz) * 16 * 1 / 60;

  const subLabel = tz <= 16 ? `${sub}/${tz}(FF)` : `${sub}/${tz}`;

  console.log(
    `  ${String(target).padStart(9)} │   ${String(sim1.depth).padStart(3)}  │  ${String(tz).padStart(4)} │ ${subLabel.padStart(8)} │  ${conn?'✅':'❌'}  │  ${(zr.avgReach*100).toFixed(1).padStart(6)}%  │ ${(zr.minReach*100).toFixed(0).padStart(4)}% │ ${bw.toFixed(1).padStart(6)} KB/s`
  );
}

// ═══ テスト2: MAX接続数の影響 ═══

console.log('\n═══ テスト2: MAX接続数の影響 (5000ノード, adaptive) ═══\n');
console.log('  MAX │ depth │ Zones │ Zone到達率 │ min   │ Zone内度数 │ 帯域');
console.log('  ────┼───────┼───────┼──────────┼──────┼──────────┼──────');

for (const maxDeg of [8, 12, 16, 20, 24]) {
  const sim = new AdaptiveZoneRingMesh(4, maxDeg, 8, 500, 16);
  for (let i = 0; i < 5000; i++) sim.addNode();
  sim.repairAll();

  const zr = sim.testAllZoneGossip();
  const tz = sim.totalZones;
  const sub = Math.min(16, tz);
  const msgs = 5000 * 0.01;
  const bw = msgs * (sub / tz) * maxDeg * 1 / 60;

  console.log(
    `   ${String(maxDeg).padStart(2)} │   ${String(sim.depth).padStart(3)}  │  ${String(tz).padStart(4)} │  ${(zr.avgReach*100).toFixed(1).padStart(6)}%  │ ${(zr.minReach*100).toFixed(0).padStart(4)}% │    ${zr.avgDeg.toFixed(2).padStart(5)}  │ ${bw.toFixed(1).padStart(5)} KB/s`
  );
}

// ═══ テスト3: TARGET_POP の調整 ═══

console.log('\n═══ テスト3: TARGET_ZONE_POP の影響 (5000ノード, MAX=16) ═══\n');
console.log('  TARGET │ depth │ Zones │ Zone到達率 │ min   │ Zone内度数 │ 帯域');
console.log('  ───────┼───────┼───────┼──────────┼──────┼──────────┼──────');

for (const pop of [200, 500, 1000, 2000, 5000]) {
  const sim = new AdaptiveZoneRingMesh(4, 16, 8, pop, 16);
  for (let i = 0; i < 5000; i++) sim.addNode();
  sim.repairAll();

  const zr = sim.testAllZoneGossip();
  const tz = sim.totalZones;
  const sub = Math.min(16, tz);
  const msgs = 5000 * 0.01;
  const bw = msgs * (sub / tz) * 16 * 1 / 60;

  console.log(
    `  ${String(pop).padStart(5)}  │   ${String(sim.depth).padStart(3)}  │  ${String(tz).padStart(4)} │  ${(zr.avgReach*100).toFixed(1).padStart(6)}%  │ ${(zr.minReach*100).toFixed(0).padStart(4)}% │    ${zr.avgDeg.toFixed(2).padStart(5)}  │ ${bw.toFixed(1).padStart(5)} KB/s`
  );
}

// ═══ テスト4: depth変化時のスムーズさ(Churn) ═══

console.log('\n═══ テスト4: Churn中のdepth変化 (MAX=16, TARGET=500) ═══\n');

const sim4 = new AdaptiveZoneRingMesh(4, 16, 8, 500, 16);
// 2000から開始
for (let i = 0; i < 2000; i++) sim4.addNode();
sim4.repairAll();
console.log(`  初期: ${sim4.nodeCount}ノード depth=${sim4.depth} zones=${sim4.totalZones}`);

// 急激に増加
for (let i = 0; i < 3000; i++) sim4.addNode();
sim4.updateDepth();
sim4.repairAll();
let zr4 = sim4.testAllZoneGossip();
console.log(`  +3000: ${sim4.nodeCount}ノード depth=${sim4.depth} zones=${sim4.totalZones} reach=${(zr4.avgReach*100).toFixed(1)}%`);

// さらに増加
for (let i = 0; i < 5000; i++) sim4.addNode();
sim4.updateDepth();
sim4.repairAll();
zr4 = sim4.testAllZoneGossip();
console.log(`  +5000: ${sim4.nodeCount}ノード depth=${sim4.depth} zones=${sim4.totalZones} reach=${(zr4.avgReach*100).toFixed(1)}%`);

// 大量離脱（70%削除）
const ids4 = sim4.nodeIds;
for (let i = ids4.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i+1));
  [ids4[i], ids4[j]] = [ids4[j], ids4[i]];
}
for (let i = 0; i < Math.floor(sim4.nodeCount * 0.7); i++) sim4.removeNode(ids4[i]);
sim4.updateDepth();
sim4.repairAll();
zr4 = sim4.testAllZoneGossip();
console.log(`  70%離脱: ${sim4.nodeCount}ノード depth=${sim4.depth} zones=${sim4.totalZones} reach=${(zr4.avgReach*100).toFixed(1)}% connected=${sim4.isConnected()?'✅':'❌'}`);

// ═══ テスト5: 100万ノード相当の帯域推定 ═══

console.log('\n═══ テスト5: 帯域推定（シミュレーションなし、計算のみ） ═══\n');
console.log('  ノード数    │ depth │ Zones │ 購読   │ msgs/min │ per-node帯域');
console.log('  ───────────┼───────┼───────┼───────┼─────────┼──────────');

for (const n of [100, 1000, 10000, 100000, 1000000, 10000000]) {
  const depth = Math.max(0, Math.min(8, Math.ceil(Math.log2(n / 500))));
  const zones = 1 << depth;
  const sub = Math.min(16, zones);
  const msgs = n * 0.01;
  const bw = msgs * (sub / zones) * 16 * 1 / 60;
  const subLabel = zones <= 16 ? `${sub}/${zones}(FF)` : `${sub}/${zones}`;

  console.log(
    `  ${String(n).padStart(11)} │   ${String(depth).padStart(3)}  │  ${String(zones).padStart(4)} │ ${subLabel.padStart(7)} │ ${String(Math.floor(msgs)).padStart(7)}  │ ${bw.toFixed(1).padStart(8)} KB/s`
  );
}

console.log(`\n${'═'.repeat(70)}`);
console.log('  ✅ 完了');
console.log('═'.repeat(70));
