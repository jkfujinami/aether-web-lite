/**
 * AETHER メッシュネットワークシミュレータ
 *
 * ノードの追加・削除・撹拌をシミュレートし、
 * 孤立防止・均等疎結合・ネットワーク連結性を検証する。
 */

// ── 型定義 ──

export interface MeshParams {
  minDegree: number;
  maxDegree: number;
  targetDegree: number;
  pexMaxPeers: number;
  shuffleDropCount: number;
}

export interface SimulationMetrics {
  totalNodes: number;
  totalEdges: number;
  isolatedNodes: number;
  connectedComponents: number;
  isFullyConnected: boolean;
  averageDegree: number;
  degreeStdDev: number;
  minDegreeActual: number;
  maxDegreeActual: number;
  averageShortestPath: number;
  diameter: number;
  clusteringCoefficient: number;
}

// ── MeshSimulator ──

export class MeshSimulator {
  private adjacency: Map<number, Set<number>> = new Map();
  private nextId = 0;
  private params: MeshParams;

  constructor(params: MeshParams) {
    this.params = params;
  }

  get nodeCount(): number {
    return this.adjacency.size;
  }

  get nodeIds(): number[] {
    return Array.from(this.adjacency.keys());
  }

  /** ノードを1つ追加し、ランダムな既存ノードと接続する */
  addNode(): number {
    const id = this.nextId++;
    this.adjacency.set(id, new Set());

    if (this.adjacency.size === 1) return id;

    // 既存ノードからランダムにtargetDegree人を選んで接続
    const candidates = this.nodeIds.filter(
      (n) => n !== id && this.degree(n) < this.params.maxDegree
    );
    this.shuffleArray(candidates);

    const connectCount = Math.min(this.params.targetDegree, candidates.length);
    for (let i = 0; i < connectCount; i++) {
      this.connect(id, candidates[i]);
    }

    return id;
  }

  /** ノードを削除し、全接続を切断する */
  removeNode(id: number): void {
    const neighbors = this.adjacency.get(id);
    if (!neighbors) return;

    for (const neighbor of neighbors) {
      this.adjacency.get(neighbor)?.delete(id);
    }
    this.adjacency.delete(id);
  }

  /** 自己修復: MIN_DEGREE未満のノードがPEXで新規接続を試みる */
  repairAll(): number {
    let repairCount = 0;
    for (const id of this.nodeIds) {
      if (this.degree(id) < this.params.minDegree) {
        repairCount += this.repairNode(id);
      }
    }
    return repairCount;
  }

  /** 撹拌: ランダムに1接続を切り、別のノードと繋ぎ直す */
  shuffleAll(): void {
    for (const id of this.nodeIds) {
      if (this.degree(id) <= this.params.minDegree) continue;

      const neighbors = Array.from(this.adjacency.get(id)!);
      if (neighbors.length === 0) continue;

      // 新しい接続先を探す
      const nonNeighbors = this.nodeIds.filter(
        (n) =>
          n !== id &&
          !this.adjacency.get(id)!.has(n) &&
          this.degree(n) < this.params.maxDegree
      );
      if (nonNeighbors.length === 0) continue;

      // 新接続をまず確立
      const newPeer = nonNeighbors[Math.floor(Math.random() * nonNeighbors.length)];
      this.connect(id, newPeer);

      // 旧接続を1つ切断（安全確認: MIN以上か）
      if (this.degree(id) > this.params.minDegree) {
        const dropTarget = neighbors[Math.floor(Math.random() * neighbors.length)];
        // 相手もMIN以上か確認
        if (this.degree(dropTarget) > this.params.minDegree) {
          this.disconnect(id, dropTarget);
        }
      }
    }
  }

  /** メトリクスを計算 */
  computeMetrics(): SimulationMetrics {
    const nodes = this.nodeIds;
    const n = nodes.length;

    if (n === 0) {
      return {
        totalNodes: 0, totalEdges: 0, isolatedNodes: 0,
        connectedComponents: 0, isFullyConnected: true,
        averageDegree: 0, degreeStdDev: 0,
        minDegreeActual: 0, maxDegreeActual: 0,
        averageShortestPath: 0, diameter: 0,
        clusteringCoefficient: 0,
      };
    }

    // Degree統計
    const degrees = nodes.map((id) => this.degree(id));
    const avgDeg = degrees.reduce((a, b) => a + b, 0) / n;
    const variance = degrees.reduce((sum, d) => sum + (d - avgDeg) ** 2, 0) / n;
    const isolated = degrees.filter((d) => d === 0).length;
    const totalEdges = degrees.reduce((a, b) => a + b, 0) / 2;

    // 連結成分
    const components = this.findConnectedComponents();

    // 最短経路（BFS）- サンプリングで計算（大規模時）
    let avgPath = 0;
    let diameter = 0;
    const sampleSize = Math.min(n, 100);
    const sampleNodes = this.sampleArray(nodes, sampleSize);
    let pathCount = 0;

    for (const src of sampleNodes) {
      const dist = this.bfs(src);
      for (const [, d] of dist) {
        if (d > 0 && d < Infinity) {
          avgPath += d;
          pathCount++;
          if (d > diameter) diameter = d;
        }
      }
    }
    avgPath = pathCount > 0 ? avgPath / pathCount : 0;

    // クラスタリング係数（サンプリング）
    let ccSum = 0;
    let ccCount = 0;
    for (const id of sampleNodes) {
      const cc = this.localClustering(id);
      if (cc >= 0) {
        ccSum += cc;
        ccCount++;
      }
    }
    const clusteringCoeff = ccCount > 0 ? ccSum / ccCount : 0;

    return {
      totalNodes: n,
      totalEdges,
      isolatedNodes: isolated,
      connectedComponents: components.length,
      isFullyConnected: components.length === 1 && isolated === 0,
      averageDegree: avgDeg,
      degreeStdDev: Math.sqrt(variance),
      minDegreeActual: Math.min(...degrees),
      maxDegreeActual: Math.max(...degrees),
      averageShortestPath: avgPath,
      diameter,
      clusteringCoefficient: clusteringCoeff,
    };
  }

  // ── Private メソッド ──

  private degree(id: number): number {
    return this.adjacency.get(id)?.size ?? 0;
  }

  private connect(a: number, b: number): void {
    this.adjacency.get(a)?.add(b);
    this.adjacency.get(b)?.add(a);
  }

  private disconnect(a: number, b: number): void {
    this.adjacency.get(a)?.delete(b);
    this.adjacency.get(b)?.delete(a);
  }

  private repairNode(id: number): number {
    let repaired = 0;
    const needed = this.params.minDegree - this.degree(id);
    if (needed <= 0) return 0;

    // PEXシミュレーション: 隣人の隣人から候補取得
    const candidates = new Set<number>();
    const myNeighbors = this.adjacency.get(id) ?? new Set();

    for (const neighbor of myNeighbors) {
      const nn = this.adjacency.get(neighbor) ?? new Set();
      for (const candidate of nn) {
        if (
          candidate !== id &&
          !myNeighbors.has(candidate) &&
          this.degree(candidate) < this.params.maxDegree
        ) {
          candidates.add(candidate);
        }
      }
    }

    // 候補不足の場合はランダムピック（トラッカーフォールバック相当）
    if (candidates.size < needed) {
      for (const nodeId of this.nodeIds) {
        if (
          nodeId !== id &&
          !myNeighbors.has(nodeId) &&
          !candidates.has(nodeId) &&
          this.degree(nodeId) < this.params.maxDegree
        ) {
          candidates.add(nodeId);
          if (candidates.size >= needed + 5) break;
        }
      }
    }

    const candidateArr = Array.from(candidates);
    this.shuffleArray(candidateArr);

    for (let i = 0; i < Math.min(needed, candidateArr.length); i++) {
      this.connect(id, candidateArr[i]);
      repaired++;
    }

    return repaired;
  }

  private findConnectedComponents(): number[][] {
    const visited = new Set<number>();
    const components: number[][] = [];

    for (const id of this.nodeIds) {
      if (visited.has(id)) continue;
      const component: number[] = [];
      const queue = [id];
      visited.add(id);
      while (queue.length > 0) {
        const current = queue.shift()!;
        component.push(current);
        for (const neighbor of this.adjacency.get(current) ?? []) {
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            queue.push(neighbor);
          }
        }
      }
      components.push(component);
    }
    return components;
  }

  private bfs(src: number): Map<number, number> {
    const dist = new Map<number, number>();
    dist.set(src, 0);
    const queue = [src];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const d = dist.get(current)!;
      for (const neighbor of this.adjacency.get(current) ?? []) {
        if (!dist.has(neighbor)) {
          dist.set(neighbor, d + 1);
          queue.push(neighbor);
        }
      }
    }
    return dist;
  }

  private localClustering(id: number): number {
    const neighbors = Array.from(this.adjacency.get(id) ?? []);
    const k = neighbors.length;
    if (k < 2) return -1; // undefinedなので除外
    let links = 0;
    for (let i = 0; i < k; i++) {
      for (let j = i + 1; j < k; j++) {
        if (this.adjacency.get(neighbors[i])?.has(neighbors[j])) {
          links++;
        }
      }
    }
    return (2 * links) / (k * (k - 1));
  }

  private shuffleArray<T>(arr: T[]): void {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }

  private sampleArray<T>(arr: T[], size: number): T[] {
    const copy = [...arr];
    this.shuffleArray(copy);
    return copy.slice(0, size);
  }
}
