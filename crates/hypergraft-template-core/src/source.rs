use std::fmt;

#[derive(Debug)]
pub struct Diagnostic {
    pub path: String,
    pub offset: usize,
    pub line: usize,
    pub column: usize,
    pub message: String,
}

impl Diagnostic {
    pub fn new(path: &str, source: &str, offset: usize, message: &str) -> Self {
        let prefix = &source[..offset];
        Self {
            path: path.into(),
            offset,
            line: prefix.bytes().filter(|b| *b == b'\n').count() + 1,
            column: prefix.rsplit('\n').next().unwrap_or("").chars().count() + 1,
            message: message.into(),
        }
    }
}
impl fmt::Display for Diagnostic {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{}:{}:{}: {}",
            self.path, self.line, self.column, self.message
        )
    }
}
impl std::error::Error for Diagnostic {}
