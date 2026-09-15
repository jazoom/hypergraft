//! Owned template output and bounded runtime failures.

/// A trusted template that writes HTML through the owned interface.
pub trait GraftTemplate {
    /// Writes HTML directly. An error can leave partial output in `output`.
    fn render_into(&self, output: &mut String, scope: &Scope) -> Result<(), TemplateError>;

    // Separate inherited scope from a suffix so borrowed scoped values retain chain order.
    #[doc(hidden)]
    fn render_scoped_into(
        &self,
        output: &mut String,
        scope: &Scope,
        suffix: &Scope,
    ) -> Result<(), TemplateError> {
        self.render_into(output, &scope.joined(suffix)?)
    }

    /// Adds one public semantic instance key to the output scope.
    fn scoped<K: SemanticKey>(self, key: K) -> Scoped<Self>
    where
        Self: Sized,
    {
        Scoped {
            template: self,
            scope: Scope::default().extended(&key),
        }
    }

    /// Returns complete HTML. An error discards partial output.
    fn render(&self) -> Result<String, TemplateError> {
        let mut output = String::new();
        self.render_into(&mut output, &Scope::default())?;
        Ok(output)
    }
}

impl<T: GraftTemplate + ?Sized> GraftTemplate for &T {
    fn render_into(&self, output: &mut String, scope: &Scope) -> Result<(), TemplateError> {
        T::render_into(*self, output, scope)
    }

    fn render_scoped_into(
        &self,
        output: &mut String,
        scope: &Scope,
        suffix: &Scope,
    ) -> Result<(), TemplateError> {
        T::render_scoped_into(*self, output, scope, suffix)
    }
}

/// A bounded failure without template output or evaluated data.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[non_exhaustive]
pub enum TemplateError {
    /// Template evaluation or output failed.
    Rendering,
    /// Reconciliation metadata violates its encoding or byte bound.
    InvalidKey,
}

impl std::fmt::Display for TemplateError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Rendering => "template rendering failed",
            Self::InvalidKey => "template identity is invalid",
        })
    }
}

impl std::error::Error for TemplateError {}

/// Maximum bytes in one semantic value, accumulated scope or textual marker.
pub const KEY_MAXIMUM_BYTES: usize = 1024;

/// Parent-relative scope for direct template output.
#[derive(Clone, Debug, Default)]
pub struct Scope(Vec<u8>);

impl Scope {
    #[doc(hidden)]
    pub fn extended(&self, key: &impl SemanticKey) -> Result<Self, TemplateError> {
        let mut value = Vec::new();
        key.encode(&mut value)?;
        let mut scope = self.clone();
        frame(&mut scope.0, &value)?;
        Ok(scope)
    }

    fn joined(&self, suffix: &Self) -> Result<Self, TemplateError> {
        let mut scope = self.clone();
        bytes(&mut scope.0, &suffix.0)?;
        Ok(scope)
    }
}

/// A typed fragment with explicit public instance scope.
pub struct Scoped<T> {
    template: T,
    scope: Result<Scope, TemplateError>,
}

impl<T: GraftTemplate> GraftTemplate for Scoped<T> {
    fn render_into(&self, output: &mut String, scope: &Scope) -> Result<(), TemplateError> {
        self.template
            .render_scoped_into(output, scope, self.scope.as_ref().map_err(|e| *e)?)
    }

    fn render_scoped_into(
        &self,
        output: &mut String,
        scope: &Scope,
        suffix: &Scope,
    ) -> Result<(), TemplateError> {
        self.template.render_scoped_into(
            output,
            scope,
            &self.scope.as_ref().map_err(|e| *e)?.joined(suffix)?,
        )
    }
}

mod sealed {
    pub trait Key {
        fn encode(&self, output: &mut Vec<u8>) -> Result<(), super::TemplateError>;
    }
}

/// A canonical format-1 key value. Applications cannot add encoders.
pub trait SemanticKey: sealed::Key {}
impl<T: sealed::Key + ?Sized> SemanticKey for T {}

fn bytes(output: &mut Vec<u8>, value: &[u8]) -> Result<(), TemplateError> {
    if value.len() > KEY_MAXIMUM_BYTES.saturating_sub(output.len()) {
        return Err(TemplateError::InvalidKey);
    }
    output.extend_from_slice(value);
    Ok(())
}

fn frame(output: &mut Vec<u8>, value: &[u8]) -> Result<(), TemplateError> {
    let length = u32::try_from(value.len()).map_err(|_| TemplateError::InvalidKey)?;
    bytes(output, &length.to_be_bytes())?;
    bytes(output, value)
}

impl<T: SemanticKey + ?Sized> sealed::Key for &T {
    fn encode(&self, output: &mut Vec<u8>) -> Result<(), TemplateError> {
        T::encode(self, output)
    }
}

impl sealed::Key for str {
    fn encode(&self, output: &mut Vec<u8>) -> Result<(), TemplateError> {
        bytes(output, b"s")?;
        frame(output, self.as_bytes())
    }
}

impl sealed::Key for String {
    fn encode(&self, output: &mut Vec<u8>) -> Result<(), TemplateError> {
        self.as_str().encode(output)
    }
}

impl sealed::Key for bool {
    fn encode(&self, output: &mut Vec<u8>) -> Result<(), TemplateError> {
        bytes(output, &[b'b', u8::from(*self)])
    }
}

macro_rules! integers {
    ($($type:ty),*) => { $(
        impl sealed::Key for $type {
            fn encode(&self, output: &mut Vec<u8>) -> Result<(), TemplateError> {
                bytes(output, b"i")?;
                frame(output, self.to_string().as_bytes())
            }
        }
    )* };
}
integers!(
    u8, u16, u32, u64, u128, usize, i8, i16, i32, i64, i128, isize
);

macro_rules! tuples {
    ($count:expr; $($type:ident:$index:tt),+) => {
        impl<$($type: SemanticKey),+> sealed::Key for ($($type,)+) {
            fn encode(&self, output: &mut Vec<u8>) -> Result<(), TemplateError> {
                bytes(output, b"t")?;
                bytes(output, &($count as u32).to_be_bytes())?;
                $(let mut member = Vec::new(); self.$index.encode(&mut member)?; frame(output, &member)?;)+
                Ok(())
            }
        }
    };
}
tuples!(1; A:0);
tuples!(2; A:0, B:1);
tuples!(3; A:0, B:1, C:2);
tuples!(4; A:0, B:1, C:2, D:3);
tuples!(5; A:0, B:1, C:2, D:3, E:4);
tuples!(6; A:0, B:1, C:2, D:3, E:4, F:5);
tuples!(7; A:0, B:1, C:2, D:3, E:4, F:5, G:6);
tuples!(8; A:0, B:1, C:2, D:3, E:4, F:5, G:6, H:7);
tuples!(9; A:0, B:1, C:2, D:3, E:4, F:5, G:6, H:7, I:8);
tuples!(10; A:0, B:1, C:2, D:3, E:4, F:5, G:6, H:7, I:8, J:9);
tuples!(11; A:0, B:1, C:2, D:3, E:4, F:5, G:6, H:7, I:8, J:9, K:10);
tuples!(12; A:0, B:1, C:2, D:3, E:4, F:5, G:6, H:7, I:8, J:9, K:10, L:11);

#[doc(hidden)]
pub fn write_key(
    output: &mut String,
    namespace: &str,
    slot: u64,
    scope: &Scope,
) -> Result<(), TemplateError> {
    use std::fmt::Write;
    let prefix = format!("g1:{namespace}:{slot}:");
    if namespace.len() != 64
        || !namespace.bytes().all(lower_hex)
        || prefix.len() + scope.0.len() * 2 > KEY_MAXIMUM_BYTES
    {
        return Err(TemplateError::InvalidKey);
    }
    output.push_str(" data-graft-key=\"");
    output.push_str(&prefix);
    for byte in &scope.0 {
        write!(output, "{byte:02x}").map_err(|_| TemplateError::Rendering)?;
    }
    output.push('"');
    Ok(())
}

fn lower_hex(byte: u8) -> bool {
    byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
}

#[doc(hidden)]
pub fn validate_authored_tag(source: &str) -> Result<(), TemplateError> {
    use html5ever::tokenizer::{BufferQueue, Token, TokenSink, TokenSinkResult, Tokenizer};
    struct Sink(std::cell::Cell<bool>);
    impl TokenSink for Sink {
        type Handle = ();
        fn process_token(&self, token: Token, _: u64) -> TokenSinkResult<()> {
            if let Token::TagToken(tag) = token {
                self.0.set(
                    tag.attrs
                        .iter()
                        .find(|a| a.name.local.as_ref() == "data-graft-key")
                        .is_some_and(|a| {
                            a.value.len() <= KEY_MAXIMUM_BYTES
                                && a.value.strip_prefix("u:").is_some_and(|hex| {
                                    !hex.is_empty()
                                        && hex.len().is_multiple_of(2)
                                        && hex.bytes().all(lower_hex)
                                })
                        }),
                );
            }
            TokenSinkResult::Continue
        }
    }
    // Validate the exact escaped tag. Character references can cross expression boundaries.
    let tokenizer = Tokenizer::new(Sink(std::cell::Cell::new(false)), Default::default());
    let input = BufferQueue::default();
    input.push_back(source.into());
    let _ = tokenizer.feed(&input);
    tokenizer.end();
    if tokenizer.sink.0.get() {
        Ok(())
    } else {
        Err(TemplateError::InvalidKey)
    }
}

#[doc(hidden)]
pub fn write_escaped(
    output: &mut String,
    value: &(impl std::fmt::Display + ?Sized),
) -> Result<(), TemplateError> {
    use std::fmt::Write;
    struct Escaped<'a>(&'a mut String);
    impl Write for Escaped<'_> {
        fn write_str(&mut self, text: &str) -> std::fmt::Result {
            for character in text.chars() {
                match character {
                    '&' => self.0.push_str("&amp;"),
                    '<' => self.0.push_str("&lt;"),
                    '>' => self.0.push_str("&gt;"),
                    '"' => self.0.push_str("&quot;"),
                    '\'' => self.0.push_str("&#39;"),
                    _ => self.0.push(character),
                }
            }
            Ok(())
        }
    }
    write!(Escaped(output), "{value}").map_err(|_| TemplateError::Rendering)
}
