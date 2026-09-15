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
