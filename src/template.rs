//! Owned template output and bounded runtime failures.

/// A trusted template that writes HTML through the owned interface.
pub trait GraftTemplate {
    /// Writes HTML directly. An error can leave partial output in `output`.
    fn render_into(&self, output: &mut String) -> Result<(), TemplateError>;

    /// Returns complete HTML. An error discards partial output.
    fn render(&self) -> Result<String, TemplateError> {
        let mut output = String::new();
        self.render_into(&mut output)?;
        Ok(output)
    }
}

impl<T: GraftTemplate + ?Sized> GraftTemplate for &T {
    fn render_into(&self, output: &mut String) -> Result<(), TemplateError> {
        T::render_into(*self, output)
    }
}

/// A bounded failure without template output or evaluated data.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[non_exhaustive]
pub enum TemplateError {
    /// Template evaluation or output failed.
    Rendering,
}

impl std::fmt::Display for TemplateError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("template rendering failed")
    }
}

impl std::error::Error for TemplateError {}

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
