pub mod sqlite_store;

use anyhow::Result;

/// Aetherのメッセージ永続化を担うストレージバックエンドの共通インターフェース
pub trait StorageBackend: Send + Sync {
    /// 指定されたトピックハッシュに関連付けてエントリを保存する
    fn put(&self, topic_hash: &str, entries: Vec<Vec<u8>>) -> Result<()>;
    
    /// 指定されたトピックハッシュのエントリを取得する
    fn get(&self, topic_hash: &str) -> Result<Vec<Vec<u8>>>;
    
    /// 保存されているユニークなトピックの総数を取得する
    fn topic_count(&self) -> Result<usize>;
    
    /// 古いエントリのクリーンアップを実行する
    fn cleanup(&self) -> Result<usize>;
}
