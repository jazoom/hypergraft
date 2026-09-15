pub mod codegen;
pub mod parser;
pub mod source;

pub fn normalise_path(path: &str) -> Result<String, &'static str> {
    if path.starts_with('/') || path.contains(['\\', ':']) {
        return Err("template path must be manifest-relative");
    }
    let mut parts = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts
                    .pop()
                    .ok_or("template path escapes the manifest directory")?;
            }
            _ => parts.push(part),
        }
    }
    let path = parts.join("/");
    if !path.ends_with(".graft.html") {
        return Err("template path must end with .graft.html");
    }
    Ok(path)
}

pub fn compile(
    path: &str,
    source: &str,
    runtime: &proc_macro2::TokenStream,
    output: &proc_macro2::Ident,
) -> Result<proc_macro2::TokenStream, source::Diagnostic> {
    Ok(codegen::generate(
        &parser::parse(path, source)?,
        runtime,
        output,
    ))
}
