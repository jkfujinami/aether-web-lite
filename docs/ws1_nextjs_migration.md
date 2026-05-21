# WS-1: Next.js 移植 — 詳細実装計画

> 依存: なし（最初に着手）
> 前提: Next.js 15+ / App Router / React 19

---

## 1. 方針

### 1.1 なぜ Next.js か

| 現行 | 課題 |
|:-----|:-----|
| Vite (Client) | フロントのみ。サーバー機能なし |
| Express (Server) | 静的配信 + WebSocket。別プロセス |
| 手動ビルド連携 | `npm run build` → `client/dist/` → Express が配信 |

Next.js に統合することで：
- **モノレポ**: クライアント + サーバーが 1 プロジェクト
- **App Router**: ファイルベースルーティング。hash routing 廃止
- **SSR/ISR**: 将来的な SEO 対応（板一覧の静的生成など）
- **API Routes**: REST エンドポイントの追加が容易

### 1.2 移植の原則

```
原則1: P2P ロジックは "use client" の中に完全隔離
原則2: サーバーが知るのは「WebSocket シグナリング」だけ
原則3: 暗号・ネットワーク・ストレージの API 境界は変えない
原則4: UI は React コンポーネントに書き直す（DOM 直接操作を廃止）
```

---

## 2. フェーズ分割

### Phase 1: Scaffold（骨格構築）

```bash
# 新プロジェクト初期化
npx -y create-next-app@latest ./ --ts --app --src-dir --no-tailwind --no-eslint

# 依存追加
npm install libsodium-wrappers ws
npm install -D @types/ws
```

#### ディレクトリ構造

```
aether-web-lite/          # プロジェクトルート
├── src/
│   ├── app/              # Next.js App Router
│   │   ├── layout.tsx    # ルートレイアウト（P2PProvider配置）
│   │   ├── page.tsx      # ランディング → /board/vip にリダイレクト
│   │   ├── board/
│   │   │   └── [boardId]/
│   │   │       ├── page.tsx          # BoardView（スレ一覧）
│   │   │       └── thread/
│   │   │           └── [threadId]/
│   │   │               └── page.tsx  # ThreadView（本文）
│   │   └── globals.css
│   │
│   ├── lib/              # コアロジック（全て "use client" 可能）
│   │   ├── network/      # ← client/src/network/** をそのまま移動
│   │   ├── crypto/       # ← client/src/crypto/**
│   │   ├── logic/        # ← client/src/logic/**
│   │   ├── storage/      # ← client/src/storage/**
│   │   ├── worker/       # ← client/src/worker/**
│   │   ├── types.ts
│   │   └── constants.ts
│   │
│   ├── hooks/            # React Hooks（P2P状態管理）
│   │   ├── useP2P.ts     # PeerManager / Router / Mailbox 等のコンテキスト
│   │   ├── useBoard.ts   # 板のスレッド一覧取得・新スレ作成
│   │   └── useThread.ts  # スレッドの投稿一覧取得・レス投稿
│   │
│   ├── components/       # UIコンポーネント
│   │   ├── BoardList.tsx
│   │   ├── ThreadList.tsx
│   │   ├── PostStream.tsx
│   │   ├── ReplyFooter.tsx
│   │   └── NetworkStatus.tsx
│   │
│   └── providers/
│       └── P2PProvider.tsx  # ← main.ts の bootstrap() に相当
│
├── server.ts             # Custom Server（WebSocket対応）
├── next.config.ts
├── tsconfig.json
└── package.json
```

#### Custom Server（WebSocket 統合）

```typescript
// server.ts
import { createServer } from 'http';
import next from 'next';
import { TrackerServer } from './src/lib/server/TrackerServer';

const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = createServer((req, res) => handle(req, res));
  
  // WebSocket シグナリングを HTTP サーバーにアタッチ
  new TrackerServer(server);
  
  server.listen(3000, () => {
    console.log('> AETHER ready on http://localhost:3000');
  });
});
```

---

### Phase 2: コアロジック移植

**ファイルはほぼコピー。変更は import パスのみ。**

```
旧: client/src/network/PeerManager.ts
    import { RING_MESH } from '../constants';

新: src/lib/network/PeerManager.ts
    import { RING_MESH } from '../constants';  ← パスは同じ（lib内の相対参照）
```

> [!IMPORTANT]
> `lib/` 以下のファイルは **純粋な TypeScript モジュール** として移植する。
> React 依存を一切持たない。DOM 直接操作もしない。
> これにより「ロジック層は UI フレームワークに依存しない」設計を維持。

#### P2PProvider（main.ts の bootstrap を React 化）

```typescript
// src/providers/P2PProvider.tsx
"use client";

import { createContext, useContext, useEffect, useState, useRef } from 'react';
import sodium from 'libsodium-wrappers';
// ... 既存の import 群 ...

interface P2PContext {
  pm: PeerManager | null;
  db: IndexedDBStore | null;
  identity: Identity | null;
  mailbox: DHTMailbox | null;
  cryptoEng: CryptoEngine | null;
  powEng: IPoWEngine | null;
  syncProtocol: SyncProtocol | null;
  router: ZoneGossipRouter | null;
  zm: ZoneManager | null;
  isReady: boolean;
}

const P2PCtx = createContext<P2PContext>(/* ... */);

export function P2PProvider({ children }: { children: React.ReactNode }) {
  const [ctx, setCtx] = useState<P2PContext>(/* initial */);
  const initialized = useRef(false);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    
    // ← main.ts の bootstrap() をここに移植
    (async () => {
      await sodium.ready;
      const ringPos = await RingPosition.loadOrCreate();
      // ... 全モジュール初期化 ...
      
      setCtx({ pm, db, identity, mailbox, cryptoEng, powEng, syncProtocol, router, zm, isReady: true });
      
      await pm.start();
    })();
  }, []);

  return <P2PCtx.Provider value={ctx}>{children}</P2PCtx.Provider>;
}

export const useP2PContext = () => useContext(P2PCtx);
```

---

### Phase 3: UI の React 化

#### BoardView → React

```typescript
// src/app/board/[boardId]/page.tsx
"use client";

import { useBoard } from '@/hooks/useBoard';
import { ThreadList } from '@/components/ThreadList';
import { ReplyFooter } from '@/components/ReplyFooter';

export default function BoardPage({ params }: { params: { boardId: string } }) {
  const { threads, isLoading, createThread } = useBoard(params.boardId);

  return (
    <div className="column-content">
      <header className="thread-header">
        <h1>/ARCHIVE/{params.boardId.toUpperCase()}/</h1>
      </header>
      
      <ThreadList threads={threads} boardId={params.boardId} />
      
      <ReplyFooter 
        placeholder="アーカイブの索引に題名を書き込む..."
        onSubmit={(title) => createThread(title)}
        buttonLabel="SIGN & POST"
      />
    </div>
  );
}
```

#### useBoard Hook（BoardView のロジック抽出）

```typescript
// src/hooks/useBoard.ts
"use client";

import { useState, useEffect, useCallback } from 'react';
import { useP2PContext } from '@/providers/P2PProvider';
import { KeyManager } from '@/lib/crypto/KeyManager';

export function useBoard(boardId: string) {
  const { pm, mailbox, cryptoEng, db, router, identity, powEng, zm } = useP2PContext();
  const [threads, setThreads] = useState<ThreadMeta[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // BoardView.init() + refresh() のロジックをここに
  useEffect(() => {
    if (!pm || !mailbox) return;
    // ... loadFromDB, refresh, onMessage ...
  }, [boardId, pm, mailbox]);

  const createThread = useCallback(async (title: string) => {
    // BoardView.submitNewThread() のロジックをここに
  }, [/* deps */]);

  return { threads, isLoading, createThread };
}
```

---

### Phase 4: ルーティング・スタイル・クリーンアップ

| 項目 | 内容 |
|:-----|:-----|
| ルーティング | `#board=vip` → `/board/vip`。`#board=x&thread=y` → `/board/x/thread/y` |
| CSS | globals.css に現行 index.css + style.css を統合 |
| 旧ファイル削除 | `client/`, `server/`, `vite.config.ts` 等を削除 |
| 動作確認 | `npm run dev` で全機能が動作することを確認 |

---

## 3. リスクと対策

| リスク | 対策 |
|:-------|:-----|
| SSR で WebRTC API が undefined | `"use client"` + `typeof window !== 'undefined'` ガード |
| libsodium の WASM ロードが SSR で失敗 | dynamic import + クライアント側でのみ初期化 |
| IndexedDB が SSR で利用不可 | P2PProvider 内で useEffect 内のみ使用 |
| Custom Server で `next dev` の HMR が壊れる | 開発時は標準 `next dev` + 別ポートで WS サーバー起動 |

---

## 4. 移植チェックリスト

- [ ] Phase 1: Next.js scaffold + custom server
- [ ] Phase 2: lib/ にコアロジック全移管
- [ ] Phase 2: P2PProvider で bootstrap 完了確認
- [ ] Phase 3: BoardView React 化 + useBoard
- [ ] Phase 3: ThreadView React 化 + useThread
- [ ] Phase 3: NetworkStatus コンポーネント
- [ ] Phase 4: App Router ルーティング動作確認
- [ ] Phase 4: CSS 統合
- [ ] Phase 4: 旧構造削除
- [ ] Phase 4: `npm run build` 成功 + 本番動作確認
