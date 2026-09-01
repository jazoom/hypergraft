use serde::Deserialize;

use crate::response::validate_navigation;
use crate::{
    MAX_RESPONSE_BYTES, VERSION,
    live::{
        CLOSE_LEASE_EXPIRY, CLOSE_PROTOCOL, CLOSE_RESYNCHRONISATION, CLOSE_RETRYABLE,
        CLOSE_TERMINAL, MAX_CONTROL_MESSAGE_BYTES, MAX_PROJECTION_URL_BYTES,
        SUBSCRIPTION_HEADER_BYTES,
    },
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CloseClass {
    Retryable,
    Terminal,
    Protocol,
    LeaseExpiry,
    Resynchronisation,
}

impl CloseClass {
    pub const fn code(self) -> u16 {
        match self {
            Self::Retryable => CLOSE_RETRYABLE,
            Self::Terminal => CLOSE_TERMINAL,
            Self::Protocol => CLOSE_PROTOCOL,
            Self::LeaseExpiry => CLOSE_LEASE_EXPIRY,
            Self::Resynchronisation => CLOSE_RESYNCHRONISATION,
        }
    }

    pub const fn from_code(code: u16) -> Option<Self> {
        match code {
            CLOSE_RETRYABLE => Some(Self::Retryable),
            CLOSE_TERMINAL => Some(Self::Terminal),
            CLOSE_PROTOCOL => Some(Self::Protocol),
            CLOSE_LEASE_EXPIRY => Some(Self::LeaseExpiry),
            CLOSE_RESYNCHRONISATION => Some(Self::Resynchronisation),
            _ => None,
        }
    }

    pub const fn reconnects(self) -> bool {
        matches!(
            self,
            Self::Retryable | Self::LeaseExpiry | Self::Resynchronisation
        )
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ControlMessage {
    Subscribe { id: u32, url: String },
    Unsubscribe { id: u32 },
    Terminal,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
enum WireControl {
    #[serde(rename = "subscribe")]
    Subscribe { v: String, id: u32, url: String },
    #[serde(rename = "unsubscribe")]
    Unsubscribe { v: String, id: u32 },
    #[serde(rename = "terminal")]
    Terminal { v: String },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ControlError {
    Protocol,
}

pub(crate) fn parse_control(text: &str) -> Result<ControlMessage, ControlError> {
    if text.len() > MAX_CONTROL_MESSAGE_BYTES {
        return Err(ControlError::Protocol);
    }
    let wire: WireControl = serde_json::from_str(text).map_err(|_| ControlError::Protocol)?;
    match wire {
        WireControl::Subscribe { v, id, url } => {
            if v != VERSION || id == 0 {
                return Err(ControlError::Protocol);
            }
            if url.len() > MAX_PROJECTION_URL_BYTES {
                return Err(ControlError::Protocol);
            }
            validate_navigation(&url).map_err(|_| ControlError::Protocol)?;
            Ok(ControlMessage::Subscribe { id, url })
        }
        WireControl::Unsubscribe { v, id } => {
            if v != VERSION || id == 0 {
                return Err(ControlError::Protocol);
            }
            Ok(ControlMessage::Unsubscribe { id })
        }
        WireControl::Terminal { v } => {
            if v != VERSION {
                return Err(ControlError::Protocol);
            }
            Ok(ControlMessage::Terminal)
        }
    }
}

pub fn encode_patch_frame(subscription_id: u32, envelope: &str) -> Result<Vec<u8>, LiveFrameError> {
    if subscription_id == 0 || envelope.len() > MAX_RESPONSE_BYTES {
        return Err(LiveFrameError);
    }
    let mut bytes = Vec::with_capacity(SUBSCRIPTION_HEADER_BYTES + envelope.len());
    bytes.extend_from_slice(&subscription_id.to_be_bytes());
    bytes.extend_from_slice(envelope.as_bytes());
    Ok(bytes)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LiveFrameError;

pub fn decode_patch_frame(bytes: &[u8]) -> Result<(u32, &str), LiveFrameError> {
    if bytes.len() < SUBSCRIPTION_HEADER_BYTES {
        return Err(LiveFrameError);
    }
    let id = u32::from_be_bytes(
        bytes[..SUBSCRIPTION_HEADER_BYTES]
            .try_into()
            .expect("header length is 4"),
    );
    if id == 0 || bytes.len() - SUBSCRIPTION_HEADER_BYTES > MAX_RESPONSE_BYTES {
        return Err(LiveFrameError);
    }
    let envelope =
        std::str::from_utf8(&bytes[SUBSCRIPTION_HEADER_BYTES..]).map_err(|_| LiveFrameError)?;
    Ok((id, envelope))
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DecodedPatch {
    pub operation: String,
    pub target: String,
    pub html: String,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct DecodedLivePatch {
    pub targets: Vec<DecodedPatch>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LiveEnvelopeError {
    Protocol,
}

pub fn decode_live_envelope(html: &str) -> Result<DecodedLivePatch, LiveEnvelopeError> {
    let html = html.trim();
    let prefix = "<graft-patch-set version=\"1\">";
    let suffix = "</graft-patch-set>";
    if !html.starts_with(prefix) || !html.ends_with(suffix) {
        return Err(LiveEnvelopeError::Protocol);
    }
    let body = &html[prefix.len()..html.len() - suffix.len()];
    let mut targets = Vec::new();
    let mut rest = body;
    while !rest.is_empty() {
        const OPEN: &str = "<graft-patch operation=\"";
        let Some(start) = rest.find(OPEN) else {
            if rest.trim().is_empty() {
                break;
            }
            return Err(LiveEnvelopeError::Protocol);
        };
        if !rest[..start].trim().is_empty() {
            return Err(LiveEnvelopeError::Protocol);
        }
        rest = &rest[start + OPEN.len()..];
        let Some(op_end) = rest.find('"') else {
            return Err(LiveEnvelopeError::Protocol);
        };
        let operation = rest[..op_end].to_owned();
        rest = &rest[op_end + 1..];
        const TARGET: &str = " target=\"";
        if !rest.starts_with(TARGET) {
            return Err(LiveEnvelopeError::Protocol);
        }
        rest = &rest[TARGET.len()..];
        let Some(target_end) = rest.find('"') else {
            return Err(LiveEnvelopeError::Protocol);
        };
        let target = rest[..target_end].to_owned();
        rest = &rest[target_end + 1..];
        const TEMPLATE: &str = "><template>";
        const CLOSE: &str = "</template></graft-patch>";
        if !rest.starts_with(TEMPLATE) {
            return Err(LiveEnvelopeError::Protocol);
        }
        rest = &rest[TEMPLATE.len()..];
        let Some(close) = rest.find(CLOSE) else {
            return Err(LiveEnvelopeError::Protocol);
        };
        let content = rest[..close].to_owned();
        rest = &rest[close + CLOSE.len()..];
        if operation != "children" && operation != "append" {
            return Err(LiveEnvelopeError::Protocol);
        }
        targets.push(DecodedPatch {
            operation,
            target,
            html: content,
        });
    }
    if targets.is_empty() {
        return Err(LiveEnvelopeError::Protocol);
    }
    Ok(DecodedLivePatch { targets })
}
