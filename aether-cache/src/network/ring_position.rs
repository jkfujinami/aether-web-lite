use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone, Copy)]
pub struct RingPosition {
    pub value: f64,
}

impl RingPosition {
    pub fn new(value: f64) -> Self {
        Self { value }
    }

    pub fn random() -> Self {
        use rand::Rng;
        let mut rng = rand::thread_rng();
        Self { value: rng.gen::<f64>() }
    }

    pub fn distance(a: f64, b: f64) -> f64 {
        let diff = (a - b).abs();
        if diff > 0.5 {
            1.0 - diff
        } else {
            diff
        }
    }
}
