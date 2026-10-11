import { describe, it, expect } from 'vitest';
import { ThreadDAGManager, type DAGPost } from '../../src/logic/ThreadDAGManager';

const T = 'thread0001';

function post(id: string, opts: Partial<DAGPost> = {}): DAGPost {
  return {
    packet_id: id,
    content: `content ${id}`,
    post_number: 0,
    created_at: 1_700_000_000_000,
    board_id: 'b',
    thread_id: T,
    parents: [],
    cumulative_pow: 0,
    thread_root: T,
    ...opts,
  };
}

const ids = (posts: DAGPost[]) => posts.map(p => p.packet_id);

/** 全ての辺で親が子より先に来ているか */
function respectsCausality(sorted: DAGPost[]): boolean {
  const index = new Map(sorted.map((p, i) => [p.packet_id, i]));
  return sorted.every(p => p.parents.every(parent => !index.has(parent) || index.get(parent)! < index.get(p.packet_id)!));
}

describe('ThreadDAGManager: 追加', () => {
  it('新しい投稿は true、同じ packet_id の再追加は false', () => {
    const dag = new ThreadDAGManager(T);
    expect(dag.addPost(post('a'))).toBe(true);
    expect(dag.addPost(post('a', { content: '改竄' }))).toBe(false);
    expect(dag.getCount()).toBe(1);
    expect(dag.getById('a')!.content).toBe('content a'); // 先着を保つ
  });

  it('別スレッドの投稿は受け付けない', () => {
    const dag = new ThreadDAGManager(T);
    expect(dag.addPost(post('x', { thread_id: 'other' }))).toBe(false);
    expect(dag.getCount()).toBe(0);
    expect(dag.getById('x')).toBeUndefined();
  });

  it('空の DAG は空のリスト・空の先端・重み 0', () => {
    const dag = new ThreadDAGManager(T);
    expect(dag.getSortedPosts()).toEqual([]);
    expect(dag.getTips()).toEqual([]);
    expect(dag.getMaxCumulativePow()).toBe(0);
  });
});

describe('ThreadDAGManager: 決定論的な表示順序', () => {
  it('親は子より先に並ぶ (子の方が時刻が早くても)', () => {
    const dag = new ThreadDAGManager(T);
    dag.addPost(post('child', { parents: ['parent'], created_at: 1000 }));
    dag.addPost(post('parent', { created_at: 5000 }));
    expect(ids(dag.getSortedPosts())).toEqual(['parent', 'child']);
  });

  it('依存関係が無ければ時刻順、同時刻なら packet_id の辞書順', () => {
    const dag = new ThreadDAGManager(T);
    dag.addPost(post('c', { created_at: 2000 }));
    dag.addPost(post('b', { created_at: 1000 }));
    dag.addPost(post('a', { created_at: 2000 }));
    expect(ids(dag.getSortedPosts())).toEqual(['b', 'a', 'c']);
  });

  it('時刻の桁数が違っても数値として正しく比較する', () => {
    const dag = new ThreadDAGManager(T);
    dag.addPost(post('late', { created_at: 10_000 }));
    dag.addPost(post('early', { created_at: 9_999 }));
    expect(ids(dag.getSortedPosts())).toEqual(['early', 'late']);
  });

  it('到着順に依存しない (どの順で追加しても同じ並び)', () => {
    const all = [
      post('root', { created_at: 100 }),
      post('r1', { parents: ['root'], created_at: 300 }),
      post('r2', { parents: ['root'], created_at: 200 }),
      post('merge', { parents: ['r1', 'r2'], created_at: 150 }),
      post('solo', { created_at: 250 }),
    ];
    const orders = [
      [0, 1, 2, 3, 4], [4, 3, 2, 1, 0], [3, 0, 4, 2, 1], [2, 4, 0, 3, 1],
    ];
    const results = orders.map(order => {
      const dag = new ThreadDAGManager(T);
      for (const i of order) dag.addPost(all[i]);
      return ids(dag.getSortedPosts());
    });
    for (const r of results) expect(r).toEqual(results[0]);
    expect(results[0]).toEqual(['root', 'r2', 'solo', 'r1', 'merge']);
  });

  it('菱形 (合流) の DAG で、合流点は両方の親の後に来る', () => {
    const dag = new ThreadDAGManager(T);
    dag.addPost(post('root', { created_at: 1 }));
    dag.addPost(post('left', { parents: ['root'], created_at: 50 }));
    dag.addPost(post('right', { parents: ['root'], created_at: 10 }));
    dag.addPost(post('join', { parents: ['left', 'right'], created_at: 5 }));
    const sorted = dag.getSortedPosts();
    expect(ids(sorted)).toEqual(['root', 'right', 'left', 'join']);
    expect(respectsCausality(sorted)).toBe(true);
  });

  it('まだ届いていない親を持つ投稿は根として扱い、表示から落とさない', () => {
    const dag = new ThreadDAGManager(T);
    dag.addPost(post('orphan', { parents: ['missing'], created_at: 10 }));
    dag.addPost(post('a', { created_at: 20 }));
    expect(ids(dag.getSortedPosts())).toEqual(['orphan', 'a']);

    // 後から親が届けば、親が先に来る
    dag.addPost(post('missing', { created_at: 30 }));
    expect(ids(dag.getSortedPosts())).toEqual(['a', 'missing', 'orphan']);
  });

  it('同じ親を重複して指していても、子は 1 回だけ現れる', () => {
    const dag = new ThreadDAGManager(T);
    dag.addPost(post('p'));
    dag.addPost(post('c', { parents: ['p', 'p'] }));
    expect(ids(dag.getSortedPosts())).toEqual(['p', 'c']);
  });

  it('長い鎖 (200 件) でも因果順を保ち、全件が並ぶ', () => {
    const dag = new ThreadDAGManager(T);
    // 逆順・時刻も逆向きに追加する
    for (let i = 199; i >= 0; i--) {
      dag.addPost(post(`p${String(i).padStart(3, '0')}`, {
        parents: i === 0 ? [] : [`p${String(i - 1).padStart(3, '0')}`],
        created_at: 1_000_000 - i,
      }));
    }
    const sorted = dag.getSortedPosts();
    expect(sorted).toHaveLength(200);
    expect(respectsCausality(sorted)).toBe(true);
    expect(sorted[0].packet_id).toBe('p000');
    expect(sorted[199].packet_id).toBe('p199');
  });
});

describe('ThreadDAGManager: 先端 (Tips) と重み', () => {
  it('子を持たない投稿だけが先端になる', () => {
    const dag = new ThreadDAGManager(T);
    dag.addPost(post('a'));
    dag.addPost(post('b', { parents: ['a'] }));
    expect(dag.getTips()).toEqual(['b']);
  });

  it('先端は最大 2 つ。累積重みの大きい順、同じなら新しい順', () => {
    const dag = new ThreadDAGManager(T);
    dag.addPost(post('light', { cumulative_pow: 10, created_at: 999 }));
    dag.addPost(post('heavy', { cumulative_pow: 50, created_at: 1 }));
    dag.addPost(post('mid-old', { cumulative_pow: 30, created_at: 100 }));
    dag.addPost(post('mid-new', { cumulative_pow: 30, created_at: 200 }));
    expect(dag.getTips()).toEqual(['heavy', 'mid-new']);
  });

  it('存在しない親を指していても、その投稿自身は先端になれる', () => {
    const dag = new ThreadDAGManager(T);
    dag.addPost(post('x', { parents: ['ghost'] }));
    expect(dag.getTips()).toEqual(['x']);
  });

  it('getMaxCumulativePow は全投稿の最大値', () => {
    const dag = new ThreadDAGManager(T);
    dag.addPost(post('a', { cumulative_pow: 12 }));
    dag.addPost(post('b', { cumulative_pow: 36, parents: ['a'] }));
    dag.addPost(post('c', { cumulative_pow: 24, parents: ['a'] }));
    expect(dag.getMaxCumulativePow()).toBe(36);
  });
});
