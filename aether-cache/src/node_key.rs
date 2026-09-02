//! ノード identity の seed を永続化する。
//!
//! NodeId PoW (Argon2id) の採掘は既定パラメータで数秒かかるので、
//! 一度採掘したら保存して使い回す。保存するのは 32 バイトの Ed25519 seed で、
//! peerId / position / PoW 解はそこから決定的に再導出できる。
//!
//! ブラウザ側はパスフレーズで封印できる ({@link SecretVault}) が、
//! 常駐デーモンには対話的なアンロックが馴染まない。ここではファイル権限
//! (0600) に頼る。「押収に対しては無防備」という点は明示しておく必要がある。
//! 秘匿が必要な運用では `AETHER_NODE_SEED` 環境変数で外部の秘密管理から
//! 注入すること。

use anyhow::{anyhow, Context, Result};
use rand::RngCore;
use std::path::{Path, PathBuf};
use tracing::{info, warn};

const DEFAULT_SEED_FILE: &str = "./node_identity.key";

/// seed を読み込む。無ければ生成して保存する。
pub fn load_or_create_seed() -> Result<[u8; 32]> {
    // 1. 環境変数からの注入を最優先する (秘密管理システム経由の運用)
    if let Ok(hex_seed) = std::env::var("AETHER_NODE_SEED") {
        let bytes = hex::decode(hex_seed.trim())
            .context("AETHER_NODE_SEED must be 64 hex characters")?;
        let seed: [u8; 32] = bytes
            .try_into()
            .map_err(|_| anyhow!("AETHER_NODE_SEED must decode to exactly 32 bytes"))?;
        info!("[NodeKey] Using node seed from AETHER_NODE_SEED");
        return Ok(seed);
    }

    let path: PathBuf = std::env::var("AETHER_NODE_SEED_FILE")
        .unwrap_or_else(|_| DEFAULT_SEED_FILE.to_string())
        .into();

    if path.exists() {
        let contents = std::fs::read_to_string(&path)
            .with_context(|| format!("failed to read {}", path.display()))?;
        let bytes = hex::decode(contents.trim())
            .with_context(|| format!("{} does not contain valid hex", path.display()))?;
        let seed: [u8; 32] = bytes
            .try_into()
            .map_err(|_| anyhow!("{} must contain exactly 32 bytes", path.display()))?;
        info!("[NodeKey] Loaded node seed from {}", path.display());
        return Ok(seed);
    }

    let mut seed = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut seed);
    write_private(&path, &hex::encode(seed))?;
    info!("[NodeKey] Generated new node seed at {}", path.display());
    warn!("[NodeKey] The seed is stored unencrypted; protect the file or use AETHER_NODE_SEED.");
    Ok(seed)
}

/// 所有者のみ読み書き可能な権限で書き出す
fn write_private(path: &Path, contents: &str) -> Result<()> {
    std::fs::write(path, contents)
        .with_context(|| format!("failed to write {}", path.display()))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .with_context(|| format!("failed to chmod {}", path.display()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::crypto::node_identity::{NodeIdentity, NODE_ID_POW_FAST};

    #[test]
    fn seed_round_trips_to_the_same_identity() {
        let seed = [7u8; 32];
        let a = NodeIdentity::from_seed(&seed, &NODE_ID_POW_FAST).unwrap();
        let b = NodeIdentity::from_seed(&seed, &NODE_ID_POW_FAST).unwrap();
        assert_eq!(a.peer_id, b.peer_id);
        assert_eq!(a.position, b.position);
        assert_eq!(a.pow_counter, b.pow_counter);
    }

    #[test]
    fn different_seeds_give_different_identities() {
        let a = NodeIdentity::from_seed(&[1u8; 32], &NODE_ID_POW_FAST).unwrap();
        let b = NodeIdentity::from_seed(&[2u8; 32], &NODE_ID_POW_FAST).unwrap();
        assert_ne!(a.peer_id, b.peer_id);
    }
}
