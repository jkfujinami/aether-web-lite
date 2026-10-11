# AETHER Electron クライアント 兼 常駐キャッシュノード実装計画書

## 1. プロジェクト概要

### 1.1 目的
Rust 製キャッシュサーバー（`aether-cache`）を退役させ、Electron ベースの **「常駐キャッシュノード 兼 デスクトップ閲覧クライアント」** を新設する。
ブラウザ版（WebLite）の短寿命・キャッシュ喪失（Chum 問題）を克服し、24時間バックグラウンドで P2P 網（DHT・Schrodinger Hint）を支えるフルノードを構築する。

### 1.2 アーキテクチャ構成
**単一 Renderer・トレイ常駐 ＋ Main プロセスによる UPnP 自動ポート開放**

```
apps/desktop/
├── electron/
│   ├── main.ts              # ライフサイクル管理、トレイ常駐、ウィンドウ非表示化
│   ├── upnp.ts              # UPnP / NAT-PMP 自動ポート開放 (nat-upnp)
│   └── preload.ts           # セキュア IPC ブリッジ (contextBridge)
├── src/                     # Renderer プロセス (Vite + React)
│   ├── main.tsx
│   ├── App.tsx              # 掲示板 UI マウント
│   └── hooks/               # P2P / NAT 状態監視フック
├── package.json             # @aether/core 依存、Electron、Vite
└── vite.config.ts
```

---

## 2. 段階的実装フェーズ

### Phase 1: `apps/desktop` 基盤構築（トレイ常駐 & ライフサイクル）
1. **モノレポ workspace 更新**:
   - ルート [`package.json`](file:///Users/fujinami/github/aether-web-lite/package.json) の workspaces に `"apps/*"` を追加。
2. **プロジェクト雛形作成**:
   - `apps/desktop` を新設し、Electron ＋ Vite ＋ React ＋ TypeScript を導入。
3. **完全常駐ライフサイクルの実装**:
   - ウィンドウの `close` イベントをインターセプトし、`e.preventDefault(); window.hide();` でタスクバー/トレイへ格納。
   - `backgroundThrottling: false` を BrowserWindow に指定（非表示時も Chromium のタイマー・WebRTC 処理を絞らせない）。
   - システムトレイ（タスクトレイ / メニューバー）アイコンを生成し、右クリックメニュー（「開く」「ステータス表示」「終了」）を実装。

---

### Phase 2: `@aether/core` 結合と UI 稼働
1. **コアノードの組み込み**:
   - Renderer プロセス内で `@aether/core` の [`AetherNode`](file:///Users/fujinami/github/aether-web-lite/packages/core/src/node/AetherNode.ts) をインスタンス化。
   - Chromium 標準の WebRTC（DataChannel）を直接駆動。
2. **掲示板 UI のマウント**:
   - [`web/src/components/`](file:///Users/fujinami/github/aether-web-lite/web/src/components) の BoardView, ThreadView, 投稿モーダルを Vite 側へ配置・再利用。
   - デスクトップアプリ上で板一覧取得、スレッド閲覧、書き込みが Web 版と全く同一に動作することを確認。
3. **バックグラウンドキャッシュ動作の検証**:
   - ウィンドウを `hide()` した後も、裏で DHT レプリケーションと 20分周期の決定論的 Hint 再放流（[`SchrodingerMailbox.ts`](file:///Users/fujinami/github/aether-web-lite/packages/core/src/network/hint/SchrodingerMailbox.ts#L253)）が停止しないことをログで確認。

---

### Phase 3: UPnP / NAT-PMP 自動ポート開放の統合
1. **Main プロセスでのポートマッピング**:
   - `nat-upnp` モジュールを導入。
   - アプリ起動時に家庭内ルーターへ IGD 要求を送信し、外部ポート（例: 40040）をマッピング。
   - ルーターから割り当てられたパブリック IP とポート番号を取得。
2. **IPC による Renderer 連携**:
   - `preload.ts` を通じて、NAT 開放状態（`open` / `failed`）、外部 IP、ポートを Renderer へ通知。
   - UI 上に「NAT 状態: ポート開放完了（フルノード稼働中）」等のステータスインジケーターを表示。
3. **スーパーノード化**:
   - 開放ポートを利用した直接のインバウンド接続待ち受け機構を整備し、ブラウザノード同士の通信を支える。

---

### Phase 4: パッケージング & 配布環境整備
1. **ビルドパイプライン**:
   - `electron-builder` を設定。
   - macOS（.dmg / .zip）、Windows（.exe / ポータブル版）向けのワンコマンドビルドを構築。
2. **Rust 版（`aether-cache`）の正式リプレイス**:
   - バックグラウンド常駐ノードとしての動作安定性を確認後、`cargo run` の依存を完全に排除。

---

## 3. 技術的留意点（落とし穴の事前防止）

1. **Chromium のバックグラウンド省電力制限**:
   - ウィンドウが隠れている際、Chromium は既定で `setInterval` の頻度を 1秒に1回などに制限する。
   - 対策: `webPreferences: { backgroundThrottling: false }` を必ず有効化する。
2. **ローカルストレージの永続性**:
   - Electron の Renderer プロセスは標準で独立した IndexedDB 領域を持つため、ブラウザのキャッシュクリア操作で勝手に消去されない。
   - アプリデータディレクトリ（`userData`）配下に確実に永続化される。
