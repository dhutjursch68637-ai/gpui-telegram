pub mod flags;
pub mod ids;
pub mod presence;

pub use flags::{ChatFlags, MessageFlags, PrivacyFlags};
pub use ids::{ChannelId, ChatId, MessageId, MessageKey, MsgId, PeerId, TopicId, UserId};
pub use presence::{TypingStatus, UserStatus};

/// Returns wall-clock `Utc::now()` on native host targets and `DateTime::UNIX_EPOCH`
/// on `wasm32-unknown-unknown` (where `std::time::SystemTime::now()` panics at runtime).
#[inline]
pub fn now_utc_or_epoch() -> chrono::DateTime<chrono::Utc> {
    #[cfg(not(target_arch = "wasm32"))]
    {
        chrono::Utc::now()
    }
    #[cfg(target_arch = "wasm32")]
    {
        chrono::DateTime::<chrono::Utc>::UNIX_EPOCH
    }
}
