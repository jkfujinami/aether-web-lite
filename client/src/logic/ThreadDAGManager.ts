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
  public getSortedPosts(): DAGPost[] {
    const all = Array.from(this.nodes.values());

    // 単純なトポロジカルソートをベースにタイブレーカーを適用
    return all.sort((a, b) => {
      // 親子関係の直接チェック
      if (b.parents.includes(a.packet_id)) return -1; // aはbの親なので前
      if (a.parents.includes(b.packet_id)) return 1;  // bはaの親なので後

      // 累積重み (熱量)
      if (a.cumulative_pow !== b.cumulative_pow) {
        return b.cumulative_pow - a.cumulative_pow; 
      }

      // 時刻
      if (a.created_at !== b.created_at) {
        return a.created_at - b.created_at;
      }

      // 最終タイブレーカー (ハッシュ辞書順)
      return a.packet_id.localeCompare(b.packet_id);
    });
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
