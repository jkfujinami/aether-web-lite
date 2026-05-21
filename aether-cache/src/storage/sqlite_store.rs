use anyhow::Result;
use rusqlite::{params, Connection};
use std::sync::{Arc, Mutex};
use tracing::info;

use super::StorageBackend;

pub struct SqliteStore {
    conn: Arc<Mutex<Connection>>,
}

impl SqliteStore {
    pub fn new(db_path: &str) -> Result<Self> {
        let conn = Connection::open(db_path)?;

        // Initialize tables
        conn.execute(
            "CREATE TABLE IF NOT EXISTS mailbox_entries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                topic_hash TEXT NOT NULL,
                entry_blob BLOB NOT NULL,
                timestamp INTEGER NOT NULL
            )",
            [],
        )?;

        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_topic_hash ON mailbox_entries(topic_hash)",
            [],
        )?;

        info!("[Storage] SQLite initialized at {}", db_path);

        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }
}

impl StorageBackend for SqliteStore {
    fn put(&self, topic_hash: &str, entries: Vec<Vec<u8>>) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_millis() as u64;

        for entry in entries {
            conn.execute(
                "INSERT INTO mailbox_entries (topic_hash, entry_blob, timestamp) VALUES (?1, ?2, ?3)",
                params![topic_hash, entry, now],
            )?;
        }
        Ok(())
    }

    fn get(&self, topic_hash: &str) -> Result<Vec<Vec<u8>>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT entry_blob FROM mailbox_entries WHERE topic_hash = ?1 ORDER BY timestamp ASC",
        )?;
        let rows = stmt.query_map(params![topic_hash], |row| row.get(0))?;

        let mut entries = Vec::new();
        for entry in rows {
            entries.push(entry?);
        }
        Ok(entries)
    }

    fn topic_count(&self) -> Result<usize> {
        let conn = self.conn.lock().unwrap();
        let count: usize = conn.query_row(
            "SELECT COUNT(DISTINCT topic_hash) FROM mailbox_entries",
            [],
            |r| r.get(0),
        )?;
        Ok(count)
    }

    /// 24時間以上経過した古いエントリを削除する (Ikioiベースの管理)
    fn cleanup(&self) -> Result<usize> {
        let conn = self.conn.lock().unwrap();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_millis() as u64;
        
        // 24時間 (86,400,000 ms) 以上前のデータを削除
        let ttl = 86_400_000;
        let threshold = now.saturating_sub(ttl);
        
        let deleted = conn.execute(
            "DELETE FROM mailbox_entries WHERE timestamp < ?1",
            params![threshold],
        )?;
        
        if deleted > 0 {
            info!("[Storage] Cleaned up {} old mailbox entries", deleted);
        }
        Ok(deleted)
    }
}
