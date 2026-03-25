use anyhow::Result;
use rusqlite::{params, Connection};
use std::sync::{Arc, Mutex};
use tracing::info;

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

    pub fn put(&self, topic_hash: &str, entries: Vec<Vec<u8>>) -> Result<()> {
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

    pub fn get(&self, topic_hash: &str) -> Result<Vec<Vec<u8>>> {
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

    // Additional methods for eviction...
}
