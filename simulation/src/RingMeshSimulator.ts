/**
 * AETHER Ring-Mesh Simulator
 *
 * 円環（Ring）トポロジーをベースにした自己組織化メッシュ。
 *
 * 基本構造:
 *   - 各ノードにランダムなID（0.0〜1.0の円環上の位置）を割り当て
 *   - ローカルリンク: 円環上で左右それぞれ最も近いK/2ノードと接続
 *   - ロングレンジリンク: 円環上で遠い位置のノードへ数本接続（小世界性）
 *   - ノード参加: 円環上の正しい位置に挿入、隣接ノードと接続
 *   - ノード離脱: 両隣のノードが再接続してリングを修復
 *
 * 保証:
 *   - リングが切れない限り全ノードが連結（構造的に孤立不可能）
 *   - 全ノードが同程度の接続数を持つ（均等な疎結合）
 */

export interface RingMeshParams {
  /** ローカルリンク数（円環上の隣人）: 左右各 localLinks/2 本 */
  localLinks: number;
  /** ロングレンジリンク数（円環上の対角近くへのショートカット） */
  longRangeLinks: number;
  /** Passive View サイズ */
  passiveViewSize: number;
}

export interface RingMetrics {
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
  /** リングが維持されているか（全ノードが円環上の左右隣と繋がっている） */
  ringIntact: boolean;
}

interface NodeData {
  id: number;
  /** 円環上の位置 [0.0, 1.0) */
  position: number;
  /** Active接続 */
  neighbors: Set<number>;
  /** Passive View */
  passive: Set<number>;
}

export class RingMeshSimulator {
  private nodes: Map<number, NodeData> = new Map();
  private nextId = 0;
  private params: RingMeshParams;

  constructor(params: RingMeshParams) {
    this.params = params;
  }

  get nodeCount(): number { return this.nodes.size; }
  get nodeIds(): number[] { return Array.from(this.nodes.keys()); }

  /** 円環上の距離（0.0〜0.5） */
  private ringDistance(a: number, b: number): number {
    const d = Math.abs(a - b);
    return Math.min(d, 1 - d);
  }

  /** 全ノードを円環上の位置でソートして返す */
  private getSortedNodes(): NodeData[] {
    return Array.from(this.nodes.values()).sort((a, b) => a.position - b.position);
  }

  /** ノードを追加: 円環上のランダムな位置に挿入 */
  addNode(): number {
    const id = this.nextId++;
    const position = Math.random();
    const node: NodeData = { id, position, neighbors: new Set(), passive: new Set() };
    this.nodes.set(id, node);

    if (this.nodes.size <= 1) return id;

    // 円環上で最も近いノードを見つけてローカルリンクを張る
    this.connectLocalLinks(id);

    // ロングレンジリンクを張る
    this.connectLongRangeLinks(id);

    // Passive Viewを構築
    this.buildPassiveView(id);

    return id;
  }

  /** ローカルリンクの接続: 円環上の左右 localLinks/2 人ずつ */
  private connectLocalLinks(id: number): void {
    const node = this.nodes.get(id)!;
    const sorted = this.getSortedNodes();
    const myIndex = sorted.findIndex(n => n.id === id);
    const n = sorted.length;
    const halfLocal = Math.ceil(this.params.localLinks / 2);

    // 左方向（反時計回り）
    for (let i = 1; i <= halfLocal && i < n; i++) {
      const idx = (myIndex - i + n) % n;
      const target = sorted[idx];
      if (target.id !== id) this.connect(id, target.id);
    }

    // 右方向（時計回り）
    for (let i = 1; i <= halfLocal && i < n; i++) {
      const idx = (myIndex + i) % n;
      const target = sorted[idx];
      if (target.id !== id) this.connect(id, target.id);
    }
  }

  /** ロングレンジリンク: 円環上の対角付近のノードへショートカット */
  private connectLongRangeLinks(id: number): void {
    const node = this.nodes.get(id)!;
    const allOthers = Array.from(this.nodes.values()).filter(n => n.id !== id && !node.neighbors.has(n.id));
    if (allOthers.length === 0) return;

    // 円環上で0.3〜0.7離れた範囲のノードを優先（対角方向のショートカット）
    const longRangeCandidates = allOthers.filter(n => {
      const d = this.ringDistance(node.position, n.position);
      return d >= 0.2;
    });

    const candidates = longRangeCandidates.length > 0 ? longRangeCandidates : allOthers;
    this.shuffleArr(candidates);

    for (let i = 0; i < Math.min(this.params.longRangeLinks, candidates.length); i++) {
      this.connect(id, candidates[i].id);
    }
  }

  /** Passive Viewの構築 */
  private buildPassiveView(id: number): void {
    const node = this.nodes.get(id)!;
    const others = Array.from(this.nodes.values()).filter(
      n => n.id !== id && !node.neighbors.has(n.id)
    );
    this.shuffleArr(others);
    for (let i = 0; i < Math.min(this.params.passiveViewSize, others.length); i++) {
      node.passive.add(others[i].id);
    }
  }

  /** ノードを削除: リングの修復（両隣の再接続）を自動実行 */
  removeNode(id: number): void {
    const node = this.nodes.get(id);
    if (!node) return;

    // 削除前に、このノードの円環上の左右の隣人を特定
    const sorted = this.getSortedNodes();
    const myIndex = sorted.findIndex(n => n.id === id);
    const n = sorted.length;

    // 左隣と右隣を見つける
    const leftNeighbors: number[] = [];
    const rightNeighbors: number[] = [];
    const halfLocal = Math.ceil(this.params.localLinks / 2);

    for (let i = 1; i <= halfLocal + 1 && i < n; i++) {
      const leftIdx = (myIndex - i + n) % n;
      const rightIdx = (myIndex + i) % n;
      if (sorted[leftIdx].id !== id) leftNeighbors.push(sorted[leftIdx].id);
      if (sorted[rightIdx].id !== id) rightNeighbors.push(sorted[rightIdx].id);
    }

    // ノードを除去
    for (const neighbor of node.neighbors) {
      this.nodes.get(neighbor)?.neighbors.delete(id);
    }
    this.nodes.delete(id);

    // 全ノードのPassive Viewからも削除
    for (const [, nd] of this.nodes) {
      nd.passive.delete(id);
    }

    // リング修復: 左右の隣人が互いに接続していなければ接続する
    for (const left of leftNeighbors) {
      for (const right of rightNeighbors) {
        if (left !== right && this.nodes.has(left) && this.nodes.has(right)) {
          const leftNode = this.nodes.get(left)!;
          if (!leftNode.neighbors.has(right)) {
            this.connect(left, right);
          }
        }
      }
    }

    // 削除されたノードの元隣人がローカルリンク不足なら補修
    for (const neighbor of [...leftNeighbors, ...rightNeighbors]) {
      if (this.nodes.has(neighbor)) {
        this.repairLocalLinks(neighbor);
      }
    }
  }

  /** 特定ノードのローカルリンクを修復 */
  private repairLocalLinks(id: number): void {
    const node = this.nodes.get(id);
    if (!node) return;

    const sorted = this.getSortedNodes();
    const myIndex = sorted.findIndex(n => n.id === id);
    const n = sorted.length;
    const halfLocal = Math.ceil(this.params.localLinks / 2);

    for (let i = 1; i <= halfLocal && i < n; i++) {
      const leftIdx = (myIndex - i + n) % n;
      const rightIdx = (myIndex + i) % n;

      if (!node.neighbors.has(sorted[leftIdx].id)) {
        this.connect(id, sorted[leftIdx].id);
      }
      if (!node.neighbors.has(sorted[rightIdx].id)) {
        this.connect(id, sorted[rightIdx].id);
      }
    }
  }

  /** 全ノードの自己修復 */
  repairAll(): number {
    let count = 0;
    for (const id of this.nodeIds) {
      const node = this.nodes.get(id)!;
      const targetDeg = this.params.localLinks + this.params.longRangeLinks;

      // ローカルリンク修復
      this.repairLocalLinks(id);

      // ロングレンジリンクの補充
      if (node.neighbors.size < targetDeg) {
        // Passive Viewから接続
        const pvArr = Array.from(node.passive).filter(
          pid => this.nodes.has(pid) && !node.neighbors.has(pid)
        );
        this.shuffleArr(pvArr);
        const needed = targetDeg - node.neighbors.size;
        for (let i = 0; i < Math.min(needed, pvArr.length); i++) {
          this.connect(id, pvArr[i]);
          node.passive.delete(pvArr[i]);
          count++;
        }
      }
    }
    return count;
  }

  /** 撹拌: ロングレンジリンクを1本入れ替える */
  shuffleAll(): void {
    for (const id of this.nodeIds) {
      const node = this.nodes.get(id)!;
      const sorted = this.getSortedNodes();
      const myIndex = sorted.findIndex(n => n.id === id);
      const n = sorted.length;
      const halfLocal = Math.ceil(this.params.localLinks / 2);

      // ローカルリンクのIDを特定（これは切らない）
      const localIds = new Set<number>();
      for (let i = 1; i <= halfLocal && i < n; i++) {
        localIds.add(sorted[(myIndex - i + n) % n].id);
        localIds.add(sorted[(myIndex + i) % n].id);
      }

      // ロングレンジリンクだけを対象にシャッフル
      const longRange = Array.from(node.neighbors).filter(nid => !localIds.has(nid));
      if (longRange.length === 0) continue;

      // Passive Viewから新しいロングレンジ候補を探す
      const pvCandidates = Array.from(node.passive).filter(pid => {
        if (!this.nodes.has(pid) || node.neighbors.has(pid)) return false;
        const d = this.ringDistance(node.position, this.nodes.get(pid)!.position);
        return d >= 0.2;
      });
      if (pvCandidates.length === 0) continue;

      // 1本入れ替え
      const newPeer = pvCandidates[Math.floor(Math.random() * pvCandidates.length)];
      this.connect(id, newPeer);
      node.passive.delete(newPeer);

      const oldPeer = longRange[Math.floor(Math.random() * longRange.length)];
      this.disconnect(id, oldPeer);
      node.passive.add(oldPeer);
    }
  }

  /** Passive View Shuffle */
  shufflePassiveViews(): void {
    for (const id of this.nodeIds) {
      const node = this.nodes.get(id)!;
      const neighbors = Array.from(node.neighbors);
      if (neighbors.length === 0) continue;

      const target = neighbors[Math.floor(Math.random() * neighbors.length)];
      const targetNode = this.nodes.get(target);
      if (!targetNode) continue;

      // 交換
      const myEntries = Array.from(node.passive).slice(0, 8);
      const theirEntries = Array.from(targetNode.passive).slice(0, 8);

      for (const e of theirEntries) {
        if (e !== id && !node.neighbors.has(e) && this.nodes.has(e)) {
          node.passive.add(e);
          if (node.passive.size > this.params.passiveViewSize) {
            const first = node.passive.values().next().value;
            if (first !== undefined) node.passive.delete(first);
          }
        }
      }
      for (const e of myEntries) {
        if (e !== target && !targetNode.neighbors.has(e) && this.nodes.has(e)) {
          targetNode.passive.add(e);
          if (targetNode.passive.size > this.params.passiveViewSize) {
            const first = targetNode.passive.values().next().value;
            if (first !== undefined) targetNode.passive.delete(first);
          }
        }
      }
    }
  }

  /** メトリクス計算 */
  computeMetrics(): RingMetrics {
    const ids = this.nodeIds;
    const n = ids.length;
    if (n === 0) {
      return { totalNodes: 0, totalEdges: 0, isolatedNodes: 0, connectedComponents: 0,
        isFullyConnected: true, averageDegree: 0, degreeStdDev: 0, minDeg: 0, maxDeg: 0,
        averageShortestPath: 0, diameter: 0, ringIntact: true };
    }

    const degrees = ids.map(id => this.nodes.get(id)!.neighbors.size);
    const avg = degrees.reduce((a, b) => a + b, 0) / n;
    const variance = degrees.reduce((s, d) => s + (d - avg) ** 2, 0) / n;
    const isolated = degrees.filter(d => d === 0).length;
    const totalEdges = degrees.reduce((a, b) => a + b, 0) / 2;
    const components = this.findComponents();

    // リング完全性チェック
    const sorted = this.getSortedNodes();
    let ringIntact = true;
    for (let i = 0; i < sorted.length; i++) {
      const next = sorted[(i + 1) % sorted.length];
      if (!sorted[i].neighbors.has(next.id)) {
        ringIntact = false;
        break;
      }
    }

    // BFS for shortest path (sampled)
    const sampleSize = Math.min(n, 100);
    const sample = this.sampleArr(ids, sampleSize);
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
      diameter, ringIntact,
    };
  }

  /** トポロジーの可視化データ（ブラウザ用） */
  getVisualizationData(): { nodes: { id: number; position: number }[]; edges: [number, number][] } {
    const sorted = this.getSortedNodes();
    const nodeData = sorted.map(n => ({ id: n.id, position: n.position }));
    const edges: [number, number][] = [];
    const seen = new Set<string>();
    for (const node of sorted) {
      for (const nid of node.neighbors) {
        const key = [Math.min(node.id, nid), Math.max(node.id, nid)].join('-');
        if (!seen.has(key)) {
          seen.add(key);
          edges.push([node.id, nid]);
        }
      }
    }
    return { nodes: nodeData, edges };
  }

  // ── Private ──
  private connect(a: number, b: number): void {
    this.nodes.get(a)?.neighbors.add(b);
    this.nodes.get(b)?.neighbors.add(a);
  }
  private disconnect(a: number, b: number): void {
    this.nodes.get(a)?.neighbors.delete(b);
    this.nodes.get(b)?.neighbors.delete(a);
  }
  private findComponents(): number[][] {
    const visited = new Set<number>();
    const comps: number[][] = [];
    for (const id of this.nodeIds) {
      if (visited.has(id)) continue;
      const comp: number[] = [];
      const q = [id]; visited.add(id);
      while (q.length > 0) {
        const c = q.shift()!; comp.push(c);
        for (const n of this.nodes.get(c)?.neighbors ?? []) {
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
      for (const n of this.nodes.get(c)?.neighbors ?? []) {
        if (!dist.has(n)) { dist.set(n, d + 1); q.push(n); }
      }
    }
    return dist;
  }
  private shuffleArr<T>(arr: T[]): void {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }
  private sampleArr<T>(arr: T[], size: number): T[] {
    const c = [...arr]; this.shuffleArr(c); return c.slice(0, size);
  }
}
