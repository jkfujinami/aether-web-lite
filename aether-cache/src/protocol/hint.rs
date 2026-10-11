//! Hint パケット (Schrödinger Mailbox の索引)
//!
//! ★ キャッシュノードは Hint を**復号しない**
//!
//! 本体は `mailbox_key = SHA256(random nonce)` というランダムな鍵の下に
//! 保管され、その nonce は Hint の暗号文の中にある。板やスレッドの鍵を
//! 持たないキャッシュノードには、Hint は不透明なバイト列にしか見えない。
//!
//! したがってこのノードに必要なのは
//!
//!   1. ワイヤ形式の符号化・復号
//!   2. `id()` の計算 (重複排除)
//!   3. PoW の検証 (フラッド対策)
//!   4. 中継
//!
//! だけで、HMAC も AEAD も要らない。**鍵の導出も試行復号もブラウザ側の責務。**
//! ブラウザ側の実装は `web/src/lib/network/hint/` を参照。

use crate::crypto::pow::{meets_difficulty, pow_hash};
use sha2::{Digest, Sha256};

/// blind_tag の長さ
pub const BLIND_TAG_SIZE: usize = 4;
/// ChaCha20-Poly1305 (IETF) の nonce 長
pub const HINT_NONCE_SIZE: usize = 12;
/// ciphertext の固定長 = 平文 48 + Poly1305 タグ 16
///
/// 長さを固定しておくと、サイズだけで中身を推測される余地が消える。
pub const HINT_CIPHERTEXT_SIZE: usize = 64;

/// プロトコルバージョン
pub const HINT_VERSION: u8 = 1;

/// Hint の PoW 難易度。
///
/// **ブラウザ側 `HINT_POW_DIFFICULTY` と必ず一致させること。**
/// Hint は投稿ごとに全ノードへ配られるため、ここが唯一のフラッド防壁になる。
pub const HINT_POW_DIFFICULTY: u32 = 12;

/// プリイメージのドメイン分離子。ちょうど 16 バイト ("AETHER/v3/hint__")。
pub const HINT_DOMAIN: &[u8; 16] = b"AETHER/v3/hint__";

/// 検証で弾いた理由
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HintReject {
    Version,
    BlindTagSize,
    NonceSize,
    CiphertextSize,
    Pow,
}

/// Hint の中身に対する検証と識別子計算。
///
/// ワイヤ表現 (`P2PMessage::Hint`) からフィールドを借りて使う。
pub struct HintView<'a> {
    pub version: u8,
    pub blind_tag: &'a [u8],
    pub nonce: &'a [u8],
    pub pow_nonce: u64,
    pub ciphertext: &'a [u8],
}

impl<'a> HintView<'a> {
    /// PoW と `id()` がコミットするバイト列。
    ///
    /// ★ `ttl` と `pow_nonce` を意図的に除外している。
    ///
    ///   - `ttl` は中継のたびに変わる。含めると同一 Hint が別物として扱われ、
    ///     重複排除をすり抜けて無限に再フラッドできる
    ///   - `pow_nonce` は探索変数。含めると、攻撃者が同じ中身に対して
    ///     別の有効な解を見つけるだけで「別の Hint」として再フラッドできる
    pub fn preimage(&self) -> Option<Vec<u8>> {
        if self.blind_tag.len() != BLIND_TAG_SIZE {
            return None;
        }
        if self.nonce.len() != HINT_NONCE_SIZE {
            return None;
        }
        if self.ciphertext.len() > u32::MAX as usize {
            return None;
        }

        let mut out = Vec::with_capacity(16 + 1 + BLIND_TAG_SIZE + HINT_NONCE_SIZE + 4 + self.ciphertext.len());
        out.extend_from_slice(HINT_DOMAIN);
        out.push(self.version);
        out.extend_from_slice(self.blind_tag);
        out.extend_from_slice(self.nonce);
        out.extend_from_slice(&(self.ciphertext.len() as u32).to_be_bytes());
        out.extend_from_slice(self.ciphertext);
        Some(out)
    }

    /// 重複排除用の識別子 (hex)
    pub fn id(&self) -> Option<String> {
        let pre = self.preimage()?;
        Some(hex::encode(Sha256::digest(&pre)))
    }

    /// 形式と PoW をまとめて検証する
    pub fn check(&self, difficulty: u32) -> Result<(), HintReject> {
        if self.version != HINT_VERSION {
            return Err(HintReject::Version);
        }
        if self.blind_tag.len() != BLIND_TAG_SIZE {
            return Err(HintReject::BlindTagSize);
        }
        if self.nonce.len() != HINT_NONCE_SIZE {
            return Err(HintReject::NonceSize);
        }
        // 長さの揺れを許さない
        if self.ciphertext.len() != HINT_CIPHERTEXT_SIZE {
            return Err(HintReject::CiphertextSize);
        }
        if difficulty > 0 {
            let pre = self.preimage().ok_or(HintReject::CiphertextSize)?;
            if !meets_difficulty(&pow_hash(&pre, self.pow_nonce), difficulty) {
                return Err(HintReject::Pow);
            }
        }
        Ok(())
    }

    /// PoW を解く (テスト・ツール用。実運用の発信はブラウザ側)
    pub fn solve_pow(&self, difficulty: u32, max_iterations: u64) -> Option<u64> {
        let pre = self.preimage()?;
        (0..max_iterations).find(|&n| meets_difficulty(&pow_hash(&pre, n), difficulty))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn view(ct: &[u8]) -> HintView<'_> {
        HintView {
            version: HINT_VERSION,
            blind_tag: &[1, 2, 3, 4],
            nonce: &[9u8; HINT_NONCE_SIZE],
            pow_nonce: 0,
            ciphertext: ct,
        }
    }

    #[test]
    fn preimage_starts_with_domain() {
        let ct = [0xAAu8; HINT_CIPHERTEXT_SIZE];
        let pre = view(&ct).preimage().unwrap();
        assert_eq!(&pre[..16], HINT_DOMAIN);
    }

    #[test]
    fn id_is_independent_of_pow_nonce() {
        let ct = [0xAAu8; HINT_CIPHERTEXT_SIZE];
        let mut a = view(&ct);
        let mut b = view(&ct);
        a.pow_nonce = 1;
        b.pow_nonce = 999_999;
        assert_eq!(a.id(), b.id(), "pow_nonce は id に影響してはならない");
    }

    #[test]
    fn id_changes_with_content() {
        let ct1 = [0xAAu8; HINT_CIPHERTEXT_SIZE];
        let mut ct2 = ct1;
        ct2[0] ^= 0xFF;
        assert_ne!(view(&ct1).id(), view(&ct2).id());
    }

    #[test]
    fn rejects_malformed_sizes() {
        let ok = [0u8; HINT_CIPHERTEXT_SIZE];
        assert_eq!(view(&ok).check(0), Ok(()));

        let short = [0u8; 10];
        assert_eq!(view(&short).check(0), Err(HintReject::CiphertextSize));

        let mut v = view(&ok);
        v.version = 99;
        assert_eq!(v.check(0), Err(HintReject::Version));

        let mut v = view(&ok);
        v.blind_tag = &[1, 2];
        assert_eq!(v.check(0), Err(HintReject::BlindTagSize));

        let mut v = view(&ok);
        v.nonce = &[1, 2, 3];
        assert_eq!(v.check(0), Err(HintReject::NonceSize));
    }

    #[test]
    fn pow_roundtrip() {
        let ct = [0x5Au8; HINT_CIPHERTEXT_SIZE];
        let mut v = view(&ct);
        let difficulty = 10;
        v.pow_nonce = v.solve_pow(difficulty, 5_000_000).expect("solvable");
        assert_eq!(v.check(difficulty), Ok(()));

        // 改竄した pow_nonce は通らない
        let mut tampered = view(&ct);
        tampered.pow_nonce = v.pow_nonce.wrapping_add(1);
        assert_eq!(tampered.check(difficulty), Err(HintReject::Pow));
    }

    #[test]
    fn pow_cannot_be_reused_for_other_content() {
        let ct = [0x5Au8; HINT_CIPHERTEXT_SIZE];
        let mut v = view(&ct);
        let difficulty = 10;
        v.pow_nonce = v.solve_pow(difficulty, 5_000_000).expect("solvable");

        let mut other_ct = ct;
        other_ct[0] ^= 0xFF;
        let mut reused = view(&other_ct);
        reused.pow_nonce = v.pow_nonce;
        assert_eq!(reused.check(difficulty), Err(HintReject::Pow));
    }
}

/// Slot に保管されるバイト列 = `u32be(hintLen) ‖ hint_blob ‖ body_blob`
///
/// ★ なぜ本体と索引を同じ Slot に入れるのか (§18.3-A)
///
/// Hint を受け取れなかったノードは `mailbox_key` を永久に計算できない。
/// したがって Hint が一度きりの放流だと、後から参加した人は過去ログを
/// 一切発見できない。保持者が索引を再投入できるよう、本体と一緒に置く。
/// **保持者は hint_blob を復号できないが、バイト列としてそのまま
/// Gossip へ再投入できる。**
pub mod slot {
    use super::*;

    /// 保管用に符号化された Hint の長さ
    /// version(1) + ttl(1) + blind_tag(4) + nonce(12) + pow_nonce(8) + ciphertext(64)
    pub const ENCODED_HINT_SIZE: usize =
        1 + 1 + BLIND_TAG_SIZE + HINT_NONCE_SIZE + 8 + HINT_CIPHERTEXT_SIZE;

    pub struct SlotBlob<'a> {
        pub hint: EncodedHint<'a>,
        pub body: &'a [u8],
    }

    /// 保管形式の Hint。バイト列を借りたまま検証する。
    pub struct EncodedHint<'a> {
        pub version: u8,
        pub ttl: u8,
        pub blind_tag: &'a [u8],
        pub nonce: &'a [u8],
        pub pow_nonce: u64,
        pub ciphertext: &'a [u8],
    }

    impl<'a> EncodedHint<'a> {
        pub fn view(&self) -> HintView<'a> {
            HintView {
                version: self.version,
                blind_tag: self.blind_tag,
                nonce: self.nonce,
                pow_nonce: self.pow_nonce,
                ciphertext: self.ciphertext,
            }
        }
    }

    /// Slot 形式として解釈を試みる。違えば None (通常のパケットとして扱う)。
    pub fn decode(bytes: &[u8]) -> Option<SlotBlob<'_>> {
        if bytes.len() < 4 {
            return None;
        }
        let hint_len = u32::from_be_bytes(bytes[0..4].try_into().ok()?) as usize;
        // 長さは固定なので、違う値は Slot ではないと判断する
        if hint_len != ENCODED_HINT_SIZE || bytes.len() < 4 + hint_len {
            return None;
        }

        let h = &bytes[4..4 + hint_len];
        let mut o = 0usize;
        let version = h[o]; o += 1;
        let ttl = h[o]; o += 1;
        let blind_tag = &h[o..o + BLIND_TAG_SIZE]; o += BLIND_TAG_SIZE;
        let nonce = &h[o..o + HINT_NONCE_SIZE]; o += HINT_NONCE_SIZE;
        let pow_nonce = u64::from_be_bytes(h[o..o + 8].try_into().ok()?); o += 8;
        let ciphertext = &h[o..];

        Some(SlotBlob {
            hint: EncodedHint { version, ttl, blind_tag, nonce, pow_nonce, ciphertext },
            body: &bytes[4 + hint_len..],
        })
    }
}
