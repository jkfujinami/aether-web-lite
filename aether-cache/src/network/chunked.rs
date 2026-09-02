use std::collections::HashMap;
use std::time::{Duration, Instant};

pub const CHUNK_SIZE: usize = 4096;
pub const HEADER_SIZE: usize = 12;
const REASSEMBLY_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Default)]
pub struct ChunkedSender {
    msg_counter: u32,
}

impl ChunkedSender {
    pub fn new() -> Self {
        Self { msg_counter: 0 }
    }

    /// Splits a large payload into chunks. If the payload is smaller than CHUNK_SIZE,
    /// it is returned as-is (in a single chunk containing the original data).
    pub fn encode(&mut self, data: &[u8]) -> Vec<Vec<u8>> {
        if data.len() <= CHUNK_SIZE {
            return vec![data.to_vec()];
        }

        let msg_id = self.msg_counter;
        self.msg_counter = self.msg_counter.wrapping_add(1);

        let total_chunks = data.len().div_ceil(CHUNK_SIZE);
        let mut chunks = Vec::with_capacity(total_chunks);

        for seq in 0..total_chunks {
            let offset = seq * CHUNK_SIZE;
            let end = std::cmp::min(offset + CHUNK_SIZE, data.len());
            let payload = &data[offset..end];

            let mut chunk = vec![0u8; HEADER_SIZE + payload.len()];
            
            // Header:
            // [0]: Magic (0x00)
            chunk[0] = 0x00;
            // [1..5]: msg_id (u32, BE)
            chunk[1..5].copy_from_slice(&msg_id.to_be_bytes());
            // [5..7]: seq (u16, BE)
            chunk[5..7].copy_from_slice(&(seq as u16).to_be_bytes());
            // [7..9]: total_chunks (u16, BE)
            chunk[7..9].copy_from_slice(&(total_chunks as u16).to_be_bytes());
            // [9..11]: payload_len (u16, BE)
            chunk[9..11].copy_from_slice(&(payload.len() as u16).to_be_bytes());
            // [11]: final_flag (0x01 if last chunk, else 0x00)
            chunk[11] = if seq == total_chunks - 1 { 0x01 } else { 0x00 };

            // Payload:
            chunk[HEADER_SIZE..].copy_from_slice(payload);

            chunks.push(chunk);
        }

        chunks
    }
}

struct PendingMessage {
    chunks: HashMap<u16, Vec<u8>>,
    total_chunks: u16,
    total_size: usize,
    created_at: Instant,
}

pub struct ChunkedReceiver {
    pending: HashMap<u32, PendingMessage>,
}

impl Default for ChunkedReceiver {
    fn default() -> Self {
        Self::new()
    }
}

impl ChunkedReceiver {
    pub fn new() -> Self {
        Self {
            pending: HashMap::new(),
        }
    }

    /// Process a received chunk/packet.
    /// If the data is not chunked (raw) or the reassembly completes, it returns Some(payload).
    /// If it is an incomplete chunk, it returns None.
    pub fn receive(&mut self, raw: Vec<u8>) -> Option<Vec<u8>> {
        self.cleanup();

        if raw.len() < HEADER_SIZE {
            return Some(raw);
        }

        if raw[0] != 0x00 {
            return Some(raw);
        }

        let msg_id = u32::from_be_bytes(raw[1..5].try_into().unwrap());
        let seq_no = u16::from_be_bytes(raw[5..7].try_into().unwrap());
        let total_chunks = u16::from_be_bytes(raw[7..9].try_into().unwrap());
        let chunk_size = u16::from_be_bytes(raw[9..11].try_into().unwrap()) as usize;

        if total_chunks == 0 || seq_no >= total_chunks {
            return Some(raw);
        }

        let payload_end = HEADER_SIZE + chunk_size;
        if raw.len() < payload_end {
            return Some(raw);
        }
        let payload = raw[HEADER_SIZE..payload_end].to_vec();

        let pm = self.pending.entry(msg_id).or_insert_with(|| PendingMessage {
            chunks: HashMap::new(),
            total_chunks,
            total_size: 0,
            created_at: Instant::now(),
        });

        if !pm.chunks.contains_key(&seq_no) {
            pm.total_size += payload.len();
            pm.chunks.insert(seq_no, payload);
        }

        if pm.chunks.len() == pm.total_chunks as usize {
            let mut assembled = vec![0u8; pm.total_size];
            let mut offset = 0;
            for i in 0..pm.total_chunks {
                if let Some(chunk) = pm.chunks.get(&i) {
                    assembled[offset..offset + chunk.len()].copy_from_slice(chunk);
                    offset += chunk.len();
                } else {
                    self.pending.remove(&msg_id);
                    return None;
                }
            }
            self.pending.remove(&msg_id);
            Some(assembled)
        } else {
            None
        }
    }

    fn cleanup(&mut self) {
        let now = Instant::now();
        self.pending.retain(|_msg_id, pm| {
            now.duration_since(pm.created_at) < REASSEMBLY_TIMEOUT
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_small_data_no_chunking() {
        let mut sender = ChunkedSender::new();
        let data = vec![1, 2, 3, 4, 5];
        let encoded = sender.encode(&data);
        assert_eq!(encoded.len(), 1);
        assert_eq!(encoded[0], data);

        let mut receiver = ChunkedReceiver::new();
        let decoded = receiver.receive(encoded[0].clone());
        assert_eq!(decoded, Some(data));
    }

    #[test]
    fn test_large_data_chunking_reassembly() {
        let mut sender = ChunkedSender::new();
        // 4096 + 10 bytes to trigger chunking
        let data = vec![42u8; CHUNK_SIZE + 10];
        let encoded = sender.encode(&data);
        assert_eq!(encoded.len(), 2);

        let mut receiver = ChunkedReceiver::new();
        
        // First chunk
        let res1 = receiver.receive(encoded[0].clone());
        assert!(res1.is_none());

        // Second chunk (should complete assembly)
        let res2 = receiver.receive(encoded[1].clone());
        assert_eq!(res2, Some(data));
    }
}
