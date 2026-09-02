// mailbox::mailbox は既存の構成をそのまま維持している (呼び出し側への影響を避けるため)
#![allow(clippy::module_inception)]

pub mod dht_mailbox;
pub mod mailbox;
pub mod entry;
