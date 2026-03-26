/**
 * AETHER 強化メッシュシミュレータ (HyParView + Long-Range Links)
 *
 * 従来のPEXのみのモデルに加え、以下を実装:
 *   1. Passive View (知っているが接続はしていないピアのキャッシュ)
 *   2. Passive View Shuffle (Active経由でPassiveを交換し、多様性を確保)
 *   3. Passive View Promotion (分断時にPassiveから接続して橋を架ける)
 *   4. Long-Range Links (接続の半分をランダムな遠隔ノードに張る)
 */

export interface EnhancedMeshParams {
  minDegree: number;
  maxDegree: number;
  targetDegree: number;
  /** Passive View の最大サイズ */
  passiveViewSize: number;
  /** Shuffle 時に交換する Passive View エントリ数 */
  shuffleExchangeCount: number;
  /** Long-Range Link の割合 (0.0 - 1.0) */
  longRangeLinkRatio: number;
}

export interface SimMetrics {
  totalNodes: number;
  totalEdges: number;
  isolatedNodes: number;
  connectedComponents: number;
  isFullyConnected: boolean;
  averageDegree: number;
  degreeStdDev: number;
  minDeg: number;
  maxDeg: number;
  averageShortestPath: number;
  diameter: number;
  avgPassiveViewSize: number;
}

export class EnhancedMeshSimulator {
  /** Active View: 実際の接続 */
  private active: Map<number, Set<number>> = new Map();
  /** Passive View: 知っているが接続していないピア */
  private passive: Map<number, Set<number>> = new Map();
  private nextId = 0;
  private params: EnhancedMeshParams;

  constructor(params: EnhancedMeshParams) {
    this.params = params;
  }

  get nodeCount(): number { return this.active.size; }
  get nodeIds(): number[] { return Array.from(this.active.keys()); }

  /** ノード追加: Active接続 + Passive蓄積 */
  addNode(): number {
    const id = this.nextId++;
    this.active.set(id, new Set());
    this.passive.set(id, new Set());

    if (this.active.size === 1) return id;

    const allNodes = this.nodeIds.filter(n => n !== id);
    this.shuffle(allNodes);

    // Active: targetDegreeの半分をランダム(遠隔)、半分を最近追加順
    const longCount = Math.ceil(this.params.targetDegree * this.params.longRangeLinkRatio);
    const localCount = this.params.targetDegree - longCount;

    // Long-range: 完全ランダム選択
    const longCandidates = allNodes.filter(n => this.degree(n) < this.params.maxDegree);
    this.shuffle(longCandidates);
    let connected = 0;
    for (let i = 0; i < Math.min(longCount, longCandidates.length); i++) {
      this.connect(id, longCandidates[i]);
      connected++;
    }

    // Local: PEX的（既に接続したノードの隣人）
    const localCandidates: number[] = [];
    for (const peer of this.active.get(id)!) {
      for (const nn of this.active.get(peer) ?? []) {
        if (nn !== id && !this.active.get(id)!.has(nn) && this.degree(nn) < this.params.maxDegree) {
          localCandidates.push(nn);
        }
      }
    }
    this.shuffle(localCandidates);
    const seen = new Set(this.active.get(id)!);
    for (const c of localCandidates) {
      if (connected >= this.params.targetDegree) break;
      if (seen.has(c)) continue;
      this.connect(id, c);
      seen.add(c);
      connected++;
    }

    // まだ足りない場合はランダムから補充
    if (connected < this.params.targetDegree) {
      for (const n of allNodes) {
        if (connected >= this.params.targetDegree) break;
        if (this.active.get(id)!.has(n)) continue;
        if (this.degree(n) >= this.params.maxDegree) continue;
        this.connect(id, n);
        connected++;
      }
    }

    // Passive: Active以外のノードをランダムに蓄積
    const passiveCandidates = allNodes.filter(n => !this.active.get(id)!.has(n));
    this.shuffle(passiveCandidates);
    const pv = this.passive.get(id)!;
    for (let i = 0; i < Math.min(this.params.passiveViewSize, passiveCandidates.length); i++) {
      pv.add(passiveCandidates[i]);
    }

    // 新ノードを他のノードのPassive Viewにも追加
    const recipients = allNodes.slice(0, Math.min(10, allNodes.length));
    for (const r of recipients) {
      const rpv = this.passive.get(r);
      if (rpv && rpv.size < this.params.passiveViewSize && !this.active.get(r)!.has(id)) {
        rpv.add(id);
      }
    }

    return id;
  }

  /** ノード削除 */
  removeNode(id: number): void {
    const neighbors = this.active.get(id);
    if (!neighbors) return;
    for (const n of neighbors) {
      this.active.get(n)?.delete(id);
    }
    this.active.delete(id);

    // 全ノードのPassive Viewからも削除
    for (const [, pv] of this.passive) {
      pv.delete(id);
    }
    this.passive.delete(id);
  }

  /** PEXのみで修復 (従来方式、比較用) */
  repairPEXOnly(): number {
    let count = 0;
    for (const id of this.nodeIds) {
      if (this.degree(id) >= this.params.minDegree) continue;
      const needed = this.params.minDegree - this.degree(id);
      const candidates = new Set<number>();
      for (const n of this.active.get(id)!) {
        for (const nn of this.active.get(n) ?? []) {
          if (nn !== id && !this.active.get(id)!.has(nn) && this.degree(nn) < this.params.maxDegree) {
            candidates.add(nn);
          }
        }
      }
      const arr = Array.from(candidates);
      this.shuffle(arr);
      for (let i = 0; i < Math.min(needed, arr.length); i++) {
        this.connect(id, arr[i]);
        count++;
      }
    }
    return count;
  }

  /** Passive View Promotion で修復 (強化方式) */
  repairWithPassiveView(): number {
    let count = 0;
    for (const id of this.nodeIds) {
      if (this.degree(id) >= this.params.minDegree) continue;
      const needed = this.params.minDegree - this.degree(id);

      // Step 1: PEX (友達の友達)
      const pexCandidates = new Set<number>();
      for (const n of this.active.get(id)!) {
        for (const nn of this.active.get(n) ?? []) {
          if (nn !== id && !this.active.get(id)!.has(nn) && this.degree(nn) < this.params.maxDegree) {
            pexCandidates.add(nn);
          }
        }
      }
      let arr = Array.from(pexCandidates);
      this.shuffle(arr);
      let filled = 0;
      for (const c of arr) {
        if (filled >= needed) break;
        if (!this.active.has(c)) continue; // ノードがまだ生きているか確認
        this.connect(id, c);
        filled++;
        count++;
      }

      // Step 2: Passive View Promotion (PEXで足りなかった分)
      if (this.degree(id) < this.params.minDegree) {
        const pv = this.passive.get(id);
        if (pv) {
          const pvArr = Array.from(pv).filter(
            n => this.active.has(n) && !this.active.get(id)!.has(n) && this.degree(n) < this.params.maxDegree
          );
          this.shuffle(pvArr);
          const stillNeeded = this.params.minDegree - this.degree(id);
          for (let i = 0; i < Math.min(stillNeeded, pvArr.length); i++) {
            this.connect(id, pvArr[i]);
            pv.delete(pvArr[i]); // Passive → Active に昇格
            count++;
          }
        }
      }
    }
    return count;
  }

  /** Passive View Shuffle: Activeピアを通じてPassive Viewを交換 */
  shufflePassiveViews(): void {
    for (const id of this.nodeIds) {
      const neighbors = Array.from(this.active.get(id)!);
      if (neighbors.length === 0) continue;

      // ランダムな隣人を1人選ぶ
      const target = neighbors[Math.floor(Math.random() * neighbors.length)];

      // 自分のPassive Viewからランダムにエントリを選ぶ
      const myPV = this.passive.get(id)!;
      const myEntries = Array.from(myPV);
      this.shuffle(myEntries);
      const toSend = myEntries.slice(0, this.params.shuffleExchangeCount);

      // 相手のPassive Viewからもランダムにエントリを受け取る
      const theirPV = this.passive.get(target)!;
      const theirEntries = Array.from(theirPV);
      this.shuffle(theirEntries);
      const toReceive = theirEntries.slice(0, this.params.shuffleExchangeCount);

      // 交換: 相手のエントリを自分のPassiveに追加
      for (const entry of toReceive) {
        if (entry !== id && !this.active.get(id)!.has(entry) && this.active.has(entry)) {
          myPV.add(entry);
          if (myPV.size > this.params.passiveViewSize) {
            // 溢れたら古いのを1つ消す
            const first = myPV.values().next().value;
            if (first !== undefined) myPV.delete(first);
          }
        }
      }
      for (const entry of toSend) {
        if (entry !== target && !this.active.get(target)!.has(entry) && this.active.has(entry)) {
          theirPV.add(entry);
          if (theirPV.size > this.params.passiveViewSize) {
            const first = theirPV.values().next().value;
            if (first !== undefined) theirPV.delete(first);
          }
        }
      }
    }
  }

  /** Active View の撹拌 (Long-Range再配線) */
  shuffleActive(): void {
    for (const id of this.nodeIds) {
      if (this.degree(id) <= this.params.minDegree) continue;

      // Passive Viewからランダムな候補を選ぶ
      const pv = this.passive.get(id)!;
      const candidates = Array.from(pv).filter(
        n => this.active.has(n) && !this.active.get(id)!.has(n) && this.degree(n) < this.params.maxDegree
      );
      if (candidates.length === 0) continue;

      const newPeer = candidates[Math.floor(Math.random() * candidates.length)];
      this.connect(id, newPeer);
      pv.delete(newPeer);

      // 旧接続を1つ切断（安全確認付き）
      if (this.degree(id) > this.params.minDegree) {
        const neighbors = Array.from(this.active.get(id)!);
        // 切断しても相手がMIN以上になる相手を選ぶ
        const droppable = neighbors.filter(n => n !== newPeer && this.degree(n) > this.params.minDegree);
        if (droppable.length > 0) {
          const drop = droppable[Math.floor(Math.random() * droppable.length)];
          this.disconnect(id, drop);
          // 切断したピアをPassive Viewに移動
          pv.add(drop);
          this.passive.get(drop)?.add(id);
        }
      }
    }
  }

  computeMetrics(): SimMetrics {
    const nodes = this.nodeIds;
    const n = nodes.length;
    if (n === 0) {
      return { totalNodes: 0, totalEdges: 0, isolatedNodes: 0, connectedComponents: 0,
        isFullyConnected: true, averageDegree: 0, degreeStdDev: 0, minDeg: 0, maxDeg: 0,
        averageShortestPath: 0, diameter: 0, avgPassiveViewSize: 0 };
    }

    const degrees = nodes.map(id => this.degree(id));
    const avg = degrees.reduce((a,b) => a+b, 0) / n;
    const variance = degrees.reduce((s,d) => s + (d-avg)**2, 0) / n;
    const isolated = degrees.filter(d => d === 0).length;
    const totalEdges = degrees.reduce((a,b) => a+b, 0) / 2;
    const components = this.findComponents();

    // Passive View統計
    let pvTotal = 0;
    for (const [, pv] of this.passive) pvTotal += pv.size;
    const avgPV = pvTotal / n;

    // サンプリングBFS
    const sampleSize = Math.min(n, 100);
    const sample = this.sampleArr(nodes, sampleSize);
    let pathSum = 0, pathCount = 0, diameter = 0;
    for (const src of sample) {
      const dist = this.bfs(src);
      for (const [, d] of dist) {
        if (d > 0 && d < Infinity) { pathSum += d; pathCount++; if (d > diameter) diameter = d; }
      }
    }

    return {
      totalNodes: n, totalEdges, isolatedNodes: isolated,
      connectedComponents: components.length,
      isFullyConnected: components.length === 1 && isolated === 0,
      averageDegree: avg, degreeStdDev: Math.sqrt(variance),
      minDeg: Math.min(...degrees), maxDeg: Math.max(...degrees),
      averageShortestPath: pathCount > 0 ? pathSum / pathCount : 0,
      diameter, avgPassiveViewSize: avgPV,
    };
  }

  // ── Private ──
  private degree(id: number): number { return this.active.get(id)?.size ?? 0; }
  private connect(a: number, b: number): void { this.active.get(a)?.add(b); this.active.get(b)?.add(a); }
  private disconnect(a: number, b: number): void { this.active.get(a)?.delete(b); this.active.get(b)?.delete(a); }

  private findComponents(): number[][] {
    const visited = new Set<number>();
    const comps: number[][] = [];
    for (const id of this.nodeIds) {
      if (visited.has(id)) continue;
      const comp: number[] = [];
      const q = [id]; visited.add(id);
      while (q.length > 0) {
        const c = q.shift()!; comp.push(c);
        for (const n of this.active.get(c) ?? []) {
          if (!visited.has(n)) { visited.add(n); q.push(n); }
        }
      }
      comps.push(comp);
    }
    return comps;
  }

  private bfs(src: number): Map<number, number> {
    const dist = new Map<number, number>(); dist.set(src, 0);
    const q = [src];
    while (q.length > 0) {
      const c = q.shift()!; const d = dist.get(c)!;
      for (const n of this.active.get(c) ?? []) {
        if (!dist.has(n)) { dist.set(n, d+1); q.push(n); }
      }
    }
    return dist;
  }

  private shuffle<T>(arr: T[]): void {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }

  private sampleArr<T>(arr: T[], size: number): T[] {
    const c = [...arr]; this.shuffle(c); return c.slice(0, size);
  }
}
