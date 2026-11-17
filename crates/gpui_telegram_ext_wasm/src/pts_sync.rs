//! Deterministic per-chat PTS sequence coordinator (1:1 parity with
//! `gpui_telegram_client::sync::coordinator::ClientSyncCoordinator`).

use gpui_telegram_core::types::ChatId;
use gpui_telegram_proto::sync::{PtsUpdate, UpdateEvent};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum PtsEvalOutcomeDto {
    Contiguous {
        chat_id: i64,
        current_pts: u64,
    },
    Duplicate {
        chat_id: i64,
        current_pts: u64,
    },
    GapDetected {
        chat_id: i64,
        last_seen: u64,
        incoming: u64,
        missing_start: u64,
        missing_end: u64,
    },
}

#[derive(Debug, Default)]
pub struct WasmPtsCoordinator {
    last_seen_pts: HashMap<ChatId, u64>,
    pending_gap_buffers: HashMap<ChatId, BTreeMap<u64, PtsUpdate>>,
}

impl WasmPtsCoordinator {
    pub fn clear(&mut self) {
        self.last_seen_pts.clear();
        self.pending_gap_buffers.clear();
    }

    pub fn last_pts(&self, chat_id: ChatId) -> u64 {
        *self.last_seen_pts.get(&chat_id).unwrap_or(&0)
    }

    pub fn set_pts(&mut self, chat_id: ChatId, pts: u64) {
        self.last_seen_pts.insert(chat_id, pts);
    }

    pub fn buffered_count(&self, chat_id: ChatId) -> usize {
        self.pending_gap_buffers
            .get(&chat_id)
            .map_or(0, BTreeMap::len)
    }

    pub fn evaluate_update(&mut self, update: &PtsUpdate) -> PtsEvalOutcomeDto {
        let chat_raw = update.chat_id.0;
        let last = self.last_seen_pts.entry(update.chat_id).or_insert(0);

        // Initial unseeded chat state: adopt incoming pts if uninitialized
        if *last == 0 {
            *last = update.pts;
            return PtsEvalOutcomeDto::Contiguous {
                chat_id: chat_raw,
                current_pts: *last,
            };
        }

        // Ephemeral updates (pts_count == 0)
        if update.pts_count == 0 {
            if update.pts <= *last {
                return PtsEvalOutcomeDto::Contiguous {
                    chat_id: chat_raw,
                    current_pts: *last,
                };
            }
            return PtsEvalOutcomeDto::GapDetected {
                chat_id: chat_raw,
                last_seen: *last,
                incoming: update.pts,
                missing_start: *last + 1,
                missing_end: update.pts,
            };
        }

        let prev = update.prev_pts();
        if prev == *last {
            *last = update.pts;
            PtsEvalOutcomeDto::Contiguous {
                chat_id: chat_raw,
                current_pts: *last,
            }
        } else if update.pts <= *last {
            PtsEvalOutcomeDto::Duplicate {
                chat_id: chat_raw,
                current_pts: *last,
            }
        } else {
            PtsEvalOutcomeDto::GapDetected {
                chat_id: chat_raw,
                last_seen: *last,
                incoming: update.pts,
                missing_start: *last + 1,
                missing_end: prev,
            }
        }
    }

    pub fn buffer_gap_update(&mut self, update: PtsUpdate) -> usize {
        let queue = self.pending_gap_buffers.entry(update.chat_id).or_default();
        queue.insert(update.pts, update);
        queue.len()
    }

    pub fn drain_contiguous_buffer(&mut self, chat_id: ChatId) -> Vec<PtsUpdate> {
        let mut ready = Vec::new();
        let current_pts = self.last_seen_pts.entry(chat_id).or_insert(0);

        if let Some(queue) = self.pending_gap_buffers.get_mut(&chat_id) {
            while let Some((&pts, _)) = queue.iter().next() {
                let prev = queue[&pts].prev_pts();
                if prev == *current_pts {
                    let update = queue.remove(&pts).expect("pts key exists");
                    *current_pts = update.pts;
                    ready.push(update);
                } else if pts <= *current_pts {
                    queue.remove(&pts);
                } else {
                    break;
                }
            }
        }
        ready
    }
}

/// Parses either a full [`PtsUpdate`] JSON value or a compact `{ chat_id, pts, pts_count, timestamp_ms? }`
/// shorthand (synthesizing a benign `PinnedMessageChanged { message_id: None }` event when `"event"` is omitted).
pub fn parse_pts_update_flexible(val: &Value) -> Result<PtsUpdate, String> {
    let obj = val
        .as_object()
        .ok_or_else(|| "PTS update must be a JSON object".to_string())?;
    if obj.contains_key("event") {
        return serde_json::from_value::<PtsUpdate>(val.clone())
            .map_err(|e| format!("invalid PtsUpdate payload: {e}"));
    }

    let chat_id_raw = obj
        .get("chat_id")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| "missing integer 'chat_id' in PTS update".to_string())?;
    let pts = obj
        .get("pts")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| "missing unsigned integer 'pts' in PTS update".to_string())?;
    let pts_count_u64 = obj.get("pts_count").and_then(|v| v.as_u64()).unwrap_or(1);
    let pts_count = u32::try_from(pts_count_u64)
        .map_err(|_| format!("pts_count {pts_count_u64} overflows u32"))?;
    let timestamp_ms = obj
        .get("timestamp_ms")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);

    Ok(PtsUpdate::new(
        ChatId(chat_id_raw),
        pts,
        pts_count,
        UpdateEvent::PinnedMessageChanged { message_id: None },
        timestamp_ms,
    ))
}
