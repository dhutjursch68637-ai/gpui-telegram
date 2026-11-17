pub mod auth;
#[cfg(feature = "host")]
pub mod domain;
pub mod error;
pub mod types;

pub use auth::{GenerationFence, SessionToken};
pub use error::{Result, TelegramError};
pub use types::{
    now_utc_or_epoch, ChannelId, ChatFlags, ChatId, MessageFlags, MessageId, MessageKey, MsgId,
    PeerId, PrivacyFlags, TopicId, TypingStatus, UserId, UserStatus,
};

#[cfg(feature = "host")]
pub mod core;
#[cfg(feature = "host")]
pub mod mtproto;

#[cfg(feature = "host")]
pub mod passport;
#[cfg(feature = "host")]
pub use passport::*;

#[cfg(feature = "host")]
pub mod action_bus;
#[cfg(feature = "host")]
pub use action_bus::*;
