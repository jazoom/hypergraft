use axum::http::{HeaderMap, HeaderValue, Uri, header};

use crate::live::DEFAULT_PATH;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiveEndpoint {
    origin: String,
    path: String,
    websocket_url: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LiveEndpointError {
    Origin,
    Path,
}

impl std::fmt::Display for LiveEndpointError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Origin => "invalid live endpoint origin",
            Self::Path => "invalid live endpoint path",
        })
    }
}

impl std::error::Error for LiveEndpointError {}

impl LiveEndpoint {
    pub fn new(public_origin: &str, path: &str) -> Result<Self, LiveEndpointError> {
        let origin = normalise_origin(public_origin).ok_or(LiveEndpointError::Origin)?;
        if !valid_path(path) {
            return Err(LiveEndpointError::Path);
        }
        let websocket_url = websocket_url(&origin, path);
        Ok(Self {
            origin,
            path: path.to_owned(),
            websocket_url,
        })
    }

    pub fn with_default_path(public_origin: &str) -> Result<Self, LiveEndpointError> {
        Self::new(public_origin, DEFAULT_PATH)
    }

    pub fn path(&self) -> &str {
        &self.path
    }

    pub fn expected_origin(&self) -> &str {
        &self.origin
    }

    pub fn browser_path(&self) -> &str {
        &self.path
    }

    pub fn websocket_url(&self) -> &str {
        &self.websocket_url
    }

    pub fn csp_connect_src(&self) -> &str {
        &self.websocket_url
    }

    pub(crate) fn origin_matches(&self, headers: &HeaderMap) -> bool {
        let mut values = headers.get_all(header::ORIGIN).iter();
        let Some(first) = values.next() else {
            return false;
        };
        if values.next().is_some() {
            return false;
        }
        origin_header_matches(first, &self.origin)
    }
}

pub(crate) fn offered_subprotocol(headers: &HeaderMap, subprotocol: &str) -> bool {
    headers
        .get_all(header::SEC_WEBSOCKET_PROTOCOL)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .any(|token| token.trim() == subprotocol)
}

fn origin_header_matches(value: &HeaderValue, expected: &str) -> bool {
    let Ok(raw) = value.to_str() else {
        return false;
    };
    normalise_origin(raw).as_deref() == Some(expected)
}

fn valid_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.first() == Some(&b'/')
        && bytes.get(1) != Some(&b'/')
        && path.is_ascii()
        && !bytes.iter().any(|byte| byte.is_ascii_control())
        && !path.contains(['\\', '#', '?', '{', '}', '*'])
        && path
            .parse::<Uri>()
            .is_ok_and(|uri| uri.scheme().is_none() && uri.authority().is_none())
}

fn websocket_url(origin: &str, path: &str) -> String {
    let scheme = if origin.starts_with("https://") {
        "wss://"
    } else {
        "ws://"
    };
    let host = origin
        .split_once("://")
        .map(|(_, host)| host)
        .unwrap_or(origin);
    format!("{scheme}{host}{path}")
}

pub(crate) fn normalise_origin(value: &str) -> Option<String> {
    if value.contains(['#', '\\']) || value.contains('@') {
        return None;
    }
    let uri: Uri = value.parse().ok()?;
    let scheme = uri.scheme_str()?;
    if scheme != "http" && scheme != "https" {
        return None;
    }
    if uri.query().is_some() {
        return None;
    }
    let path = uri.path();
    if path != "/" && !path.is_empty() {
        return None;
    }
    let host = uri
        .host()?
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_ascii_lowercase();
    if host.is_empty() {
        return None;
    }
    let host = if host.contains(':') {
        format!("[{host}]")
    } else {
        host
    };
    let mut origin = format!("{scheme}://{host}");
    if let Some(port) = uri.port_u16()
        && !matches!((scheme, port), ("http", 80) | ("https", 443))
    {
        origin.push(':');
        origin.push_str(&port.to_string());
    }
    Some(origin)
}
