// DAGMetadata is not used here directly as an object, so removing unused import

/**
 * DAGPost
 * 投稿データに DAG のメタデータを付与した内部管理構造
 */
export interface DAGPost {
  packet_id: string;
  content: string;
  post_number: number;
  created_at: number;
  board_id: string;
  thread_id: string;
  parents: string[];
  cumulative_pow: number;
  thread_root: string;
  // 表示用の追加メタデータ
  trip_pubkey?: Uint8Array;
  session_pubkey?: Uint8Array;
}

/**
 * ThreadDAGManager
 * スレッド内のパケット間の因果関係(DAG)を管理し、決定論的な表示順序を算出する。
 */
export class ThreadDAGManager {
  private nodes: Map<string, DAGPost> = new Map();
  private threadId: string;

  constructor(threadId: string) {
    this.threadId = threadId;
  }

  /**
   * 新しいパケットを DAG に追加する
   */
  public addPost(post: DAGPost): boolean {
    if (this.nodes.has(post.packet_id)) return false;
    
    // スレッドIDの一致確認
    if (post.thread_id !== this.threadId) {
      console.warn(`[DAGManager] Thread ID mismatch: ${post.thread_id} !== ${this.threadId}`);
      return false;
    }

    this.nodes.set(post.packet_id, post);
    return true;
  }

  /**
   * 決定論的なソート済みリストを取得する
   * ルール:
   * 1. 依存関係の維持 (親が先)
   * 2. 累積重み (PoW) が大きい方を優先
   * 3. 時刻 (created_at) が早い方を優先
   * 4. ID (packet_id) の辞書順でタイブレーク
   */
  /**
   * 決定論的なトポロジカルソート済みリストを取得する
   * Kahn's Algorithm を使用して因果関係を保証しつつ、タイブレーカーを適用。
   */
  public getSortedPosts(): DAGPost[] {
    const all = Array.from(this.nodes.values());
    if (all.length === 0) return [];

    // 1. 各ノードの入次数 (親の数) を計算
    const inDegree = new Map<string, number>();
    const childrenMap = new Map<string, string[]>();

    for (const node of all) {
      // 親が存在し、かつこのDAGに登録されているもののみカウント
      const validParents = node.parents.filter(p => this.nodes.has(p));
      inDegree.set(node.packet_id, validParents.length);
      
      validParents.forEach(p => {
        if (!childrenMap.get(p)) childrenMap.set(p, []);
        childrenMap.get(p)!.push(node.packet_id);
      });
    }

    // 2. タイブレーカー: [時刻] -> [ID順] で一意の文字列を生成
    const getTieBreakerValue = (id: string) => {
        const n = this.nodes.get(id)!;
        return `${n.created_at.toString().padStart(15, '0')}_${n.packet_id}`;
    };

    // 入次数 0 (親が既に処理された/存在しない) のノードを抽出
    let queue = all
      .filter(n => (inDegree.get(n.packet_id) || 0) === 0)
      .map(n => n.packet_id)
      .sort((a, b) => getTieBreakerValue(a).localeCompare(getTieBreakerValue(b)));

    const result: DAGPost[] = [];

    // 3. 処理
    while (queue.length > 0) {
      const currentId = queue.shift()!;
      const currentNode = this.nodes.get(currentId)!;
      result.push(currentNode);

      // 子ノードの入次数を減らす
      const children = childrenMap.get(currentId) || [];
      for (const childId of children) {
        const newDegree = (inDegree.get(childId) || 0) - 1;
        inDegree.set(childId, newDegree);

        if (newDegree === 0) {
          queue.push(childId);
          // キューを常に入るたびに再ソート (決定論的順序の維持)
          queue.sort((a, b) => getTieBreakerValue(a).localeCompare(getTieBreakerValue(b)));
        }
      }
    }

    return result;
  }

  /**
   * 現在の DAG の「先端 (Tips)」を取得する。
   * 新しいレスを書く際の親パケット候補。
   */
  public getTips(): string[] {
    const allIds = Array.from(this.nodes.keys());
    if (allIds.length === 0) return [];

    const hasChildren = new Set<string>();
    for (const node of this.nodes.values()) {
      node.parents.forEach(p => hasChildren.add(p));
    }

    // 子を持たないノードを抽出
    const tips = allIds.filter(id => !hasChildren.has(id));

    // 多すぎる場合は、重みや時刻で上位2つに絞る (パケットサイズ抑制)
    return tips.sort((a, b) => {
      const nodeA = this.nodes.get(a)!;
      const nodeB = this.nodes.get(b)!;
      return nodeB.cumulative_pow - nodeA.cumulative_pow || nodeB.created_at - nodeA.created_at;
    }).slice(0, 2);
  }

  /**
   * 現在の最大累積重みを取得
   */
  public getMaxCumulativePow(): number {
    let max = 0;
    for (const node of this.nodes.values()) {
      if (node.cumulative_pow > max) max = node.cumulative_pow;
    }
    return max;
  }

  public getCount(): number {
    return this.nodes.size;
  }

  public getById(id: string): DAGPost | undefined {
    return this.nodes.get(id);
  }
}
