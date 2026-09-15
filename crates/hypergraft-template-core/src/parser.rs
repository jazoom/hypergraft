use crate::source::Diagnostic;

pub enum Part {
    Literal(String),
    Render {
        expression: Box<syn::Expr>,
        offset: usize,
        end: usize,
        scope: Option<Box<syn::Expr>>,
    },
    Expression {
        expression: Box<syn::Expr>,
        offset: usize,
        end: usize,
    },
}

#[derive(Clone, Copy)]
enum State {
    Text,
    Tag,
    Quoted(u8),
    Comment,
    Declaration,
    Cdata,
    Raw,
    Rcdata,
}

// Token lengths keep delimiter-like bytes inside Rust literals and comments opaque.
fn expression_end(source: &str, delimiter: &str) -> Option<usize> {
    let mut offset = 0;
    let mut depth = 0usize;
    while offset < source.len() {
        let rest = &source[offset..];
        if depth == 0 && rest.starts_with(delimiter) {
            return Some(offset);
        }
        // This lexer predates C strings. Their raw delimiters match Rust raw strings.
        let prefix = usize::from(rest.starts_with("cr#") || rest.starts_with("cr\""));
        let token = rustc_lexer::first_token(&rest[prefix..]);
        match token.kind {
            rustc_lexer::TokenKind::OpenParen
            | rustc_lexer::TokenKind::OpenBrace
            | rustc_lexer::TokenKind::OpenBracket => depth += 1,
            rustc_lexer::TokenKind::CloseParen
            | rustc_lexer::TokenKind::CloseBrace
            | rustc_lexer::TokenKind::CloseBracket => depth = depth.saturating_sub(1),
            _ => {}
        }
        offset += prefix + token.len;
    }
    None
}

pub fn parse(path: &str, source: &str) -> Result<Document, Diagnostic> {
    let mut starts = Vec::new();
    let mut tags = Vec::new();
    let mut replacements = Vec::new();
    let mut expression_marker = "graft_expression_".to_owned();
    while source.contains(&expression_marker) {
        expression_marker.push('x');
    }
    let bytes = source.as_bytes();
    let mut parts = Vec::new();
    let mut state = State::Text;
    let mut start = 0;
    let mut i = 0;
    let mut tag_start = 0;
    let mut raw_name = String::new();
    let mut foreign = Vec::<String>::new();
    while i < bytes.len() {
        let rest = &source[i..];
        if rest.starts_with("{%") {
            if !matches!(state, State::Text) {
                return Err(Diagnostic::new(
                    path,
                    source,
                    i,
                    "composition requires ordinary node content",
                ));
            }
            let end = expression_end(&source[i + 2..], "%}")
                .ok_or_else(|| Diagnostic::new(path, source, i, "unterminated directive"))?
                + i
                + 2;
            let directive = source[i + 2..end].trim();
            let expression = directive
                .strip_prefix("render")
                .filter(|rest| rest.starts_with(char::is_whitespace))
                .ok_or_else(|| Diagnostic::new(path, source, i, "unsupported directive"))?;
            let (expression, scope) = render_expression(expression.trim()).map_err(|error| {
                Diagnostic::new(
                    path,
                    source,
                    i,
                    &format!("invalid Rust expression: {error}"),
                )
            })?;
            parts.push(Part::Literal(source[start..i].into()));
            parts.push(Part::Render {
                expression: Box::new(expression),
                offset: i,
                end: end + 2,
                scope: scope.map(Box::new),
            });
            replacements.push((i..end + 2, format!("{expression_marker}{i}_")));
            i = end + 2;
            start = i;
            continue;
        }
        if rest.starts_with("{{") {
            if !matches!(state, State::Text | State::Quoted(_) | State::Rcdata) {
                return Err(Diagnostic::new(
                    path,
                    source,
                    i,
                    "interpolation is not supported in this HTML context",
                ));
            }
            let end = expression_end(&source[i + 2..], "}}")
                .ok_or_else(|| Diagnostic::new(path, source, i, "unterminated Rust expression"))?
                + i
                + 2;
            let expression = syn::parse_str(&source[i + 2..end]).map_err(|error| {
                Diagnostic::new(
                    path,
                    source,
                    i,
                    &format!("invalid Rust expression: {error}"),
                )
            })?;
            parts.push(Part::Literal(source[start..i].into()));
            parts.push(Part::Expression {
                expression: Box::new(expression),
                offset: i,
                end: end + 2,
            });
            replacements.push((i..end + 2, format!("{expression_marker}{i}_")));
            i = end + 2;
            start = i;
            continue;
        }
        match state {
            State::Text => {
                if rest.starts_with("<![CDATA[") {
                    state = State::Cdata;
                } else if rest.starts_with("<!--") {
                    state = State::Comment;
                } else if rest.starts_with("<!") || rest.starts_with("<?") {
                    state = State::Declaration;
                } else if bytes[i] == b'<'
                    && bytes
                        .get(i + 1)
                        .is_some_and(|b| b.is_ascii_alphabetic() || matches!(*b, b'/' | b'{'))
                {
                    state = State::Tag;
                    tag_start = i;
                }
            }
            State::Cdata => {
                if rest.starts_with("]]>") {
                    state = State::Text;
                    i += 2;
                }
            }
            State::Comment => {
                if rest.starts_with("-->") {
                    state = State::Text;
                    i += 2;
                }
            }
            State::Declaration => {
                if bytes[i] == b'>' {
                    state = State::Text;
                }
            }
            State::Quoted(quote) => {
                if bytes[i] == quote {
                    state = State::Tag;
                }
            }
            State::Raw | State::Rcdata => {
                let end = format!("</{raw_name}");
                if rest
                    .get(..end.len())
                    .is_some_and(|s| s.eq_ignore_ascii_case(&end))
                    && bytes
                        .get(i + end.len())
                        .is_some_and(|b| b.is_ascii_whitespace() || matches!(*b, b'>' | b'/'))
                {
                    state = State::Tag;
                    tag_start = i;
                }
            }
            State::Tag => {
                if matches!(bytes[i], b'\'' | b'"') {
                    if !source[tag_start..i].trim_end().ends_with('=') {
                        return Err(Diagnostic::new(
                            path,
                            source,
                            i,
                            "attribute quotes must follow an equals sign",
                        ));
                    }
                    state = State::Quoted(bytes[i]);
                } else if bytes[i] == b'>' {
                    let tag = &source[tag_start + 1..i];
                    let mut token_source = tag.to_owned();
                    for (range, marker) in replacements
                        .iter()
                        .rev()
                        .take_while(|(range, _)| range.start > tag_start)
                    {
                        token_source.replace_range(
                            range.start - tag_start - 1..range.end - tag_start - 1,
                            marker,
                        );
                    }
                    let token = tokenise_tag(&token_source).ok_or_else(|| {
                        Diagnostic::new(path, source, tag_start, "invalid HTML tag")
                    })?;
                    let closing = tag.starts_with('/');
                    let name = tag
                        .trim_start_matches('/')
                        .split(|c: char| c.is_ascii_whitespace() || c == '/')
                        .next()
                        .unwrap_or("")
                        .to_ascii_lowercase();
                    state = State::Text;
                    if closing {
                        if let Some(index) = foreign.iter().rposition(|entry| entry == &name) {
                            foreign.truncate(index);
                        }
                    } else {
                        let marker = token
                            .attrs
                            .iter()
                            .find(|a| a.name.local.as_ref() == "data-graft-key");
                        let dynamic_marker =
                            marker.is_some_and(|a| a.value.contains(&expression_marker));
                        if let Some(marker) = marker.filter(|_| !dynamic_marker)
                            && !crate::identity::valid_authored(&marker.value)
                        {
                            return Err(Diagnostic::new(
                                path,
                                source,
                                tag_start,
                                "invalid authored reconciliation marker",
                            ));
                        }
                        tags.push(TagOutput {
                            range: tag_start..i + 1,
                            insertion: tag_start + 1 + name.len(),
                            generated: marker.is_none()
                                && !token.attrs.iter().any(|a| a.name.local.as_ref() == "id"),
                            dynamic_marker,
                        });
                        starts.push((tag_start..i + 1, tag_start + 1 + name.len()));
                        if matches!(foreign.last().map(String::as_str), Some("svg" | "math"))
                            && foreign_breakout(&token)
                        {
                            while matches!(foreign.last().map(String::as_str), Some("svg" | "math"))
                            {
                                foreign.pop();
                            }
                        }
                        let html_context = foreign
                            .last()
                            .is_none_or(|entry| !matches!(entry.as_str(), "svg" | "math"));
                        let integration = match foreign.last().map(String::as_str) {
                            Some("svg") => {
                                matches!(name.as_str(), "foreignobject" | "title" | "desc")
                            }
                            Some("math") => {
                                matches!(name.as_str(), "mi" | "mo" | "mn" | "ms" | "mtext")
                                    || (name == "annotation-xml"
                                        && token.attrs.iter().any(|attr| {
                                            attr.name.local.as_ref() == "encoding"
                                                && (attr.value.eq_ignore_ascii_case("text/html")
                                                    || attr.value.eq_ignore_ascii_case(
                                                        "application/xhtml+xml",
                                                    ))
                                        }))
                            }
                            _ => false,
                        };
                        if (matches!(name.as_str(), "svg" | "math") || integration)
                            && !token.self_closing
                        {
                            foreign.push(name.clone());
                        }
                        if html_context {
                            if matches!(
                                name.as_str(),
                                "script"
                                    | "style"
                                    | "xmp"
                                    | "iframe"
                                    | "noembed"
                                    | "noframes"
                                    | "noscript"
                                    | "plaintext"
                            ) {
                                state = State::Raw;
                                raw_name = name;
                            } else if matches!(name.as_str(), "title" | "textarea") {
                                state = State::Rcdata;
                                raw_name = name;
                            }
                        }
                    }
                }
            }
        }
        i += source[i..].chars().next().unwrap().len_utf8();
    }
    if matches!(
        state,
        State::Tag | State::Quoted(_) | State::Comment | State::Declaration | State::Cdata
    ) {
        return Err(Diagnostic::new(path, source, i, "unterminated HTML token"));
    }
    parts.push(Part::Literal(source[start..].into()));
    let (elements, content_parents) = structure(path, source, &starts, replacements)?;
    Ok(Document {
        parts,
        elements,
        tags,
        content_parents,
        source: source.to_owned(),
        authored: starts.into_iter().map(|(range, _)| range).collect(),
    })
}

pub struct TagOutput {
    pub range: std::ops::Range<usize>,
    pub insertion: usize,
    pub generated: bool,
    pub dynamic_marker: bool,
}

pub type ContentParents = std::collections::HashMap<usize, Option<usize>>;

pub struct Document {
    pub source: String,
    pub tags: Vec<TagOutput>,
    pub content_parents: ContentParents,
    pub authored: Vec<std::ops::Range<usize>>,
    pub parts: Vec<Part>,
    pub elements: Vec<Element>,
}

pub struct Element {
    pub namespace: String,
    pub name: String,
    pub parent: Option<usize>,
    pub source: Option<std::ops::Range<usize>>,
}

fn structure(
    path: &str,
    source: &str,
    starts: &[(std::ops::Range<usize>, usize)],
    mut replacements: Vec<(std::ops::Range<usize>, String)>,
) -> Result<(Vec<Element>, ContentParents), Diagnostic> {
    use html5ever::tendril::TendrilSink;
    use markup5ever_rcdom::{NodeData, RcDom};
    // This private parse copy never enters output. The marker maps authored tags
    // to the browser tree, which also contains implied and reconstructed nodes.
    let mut marker = "data-hypergraft-source".to_owned();
    while source.to_ascii_lowercase().contains(&marker) {
        marker.push('x');
    }
    let expressions: Vec<_> = replacements
        .iter()
        .map(|(range, marker)| (range.start, marker.clone()))
        .collect();
    for (index, (_, end)) in starts.iter().enumerate() {
        replacements.push((*end..*end, format!(" {marker}=\"{index}\" ")));
    }
    replacements.sort_by_key(|(range, _)| range.start);
    let mut html = String::new();
    let mut cursor = 0;
    for (range, replacement) in replacements {
        html.push_str(&source[cursor..range.start]);
        html.push_str(&replacement);
        cursor = range.end;
    }
    html.push_str(&source[cursor..]);
    // Template context preserves standalone table fragments. Document context
    // remains necessary for authored html, head and body elements.
    let document_source = source
        .trim_start()
        .to_ascii_lowercase()
        .starts_with("<!doctype")
        || starts.iter().any(|(range, name_end)| {
            matches!(
                source[range.start + 1..*name_end]
                    .to_ascii_lowercase()
                    .as_str(),
                "html" | "head" | "body"
            )
        });
    let dom = if document_source {
        html5ever::parse_document(RcDom::default(), Default::default()).one(html)
    } else {
        html5ever::parse_fragment(
            RcDom::default(),
            Default::default(),
            html5ever::QualName::new(
                None,
                html5ever::ns!(html),
                html5ever::local_name!("template"),
            ),
            Vec::new(),
            true,
        )
        .one(html)
    };
    let mut elements = Vec::<Element>::new();
    let mut content_parents = std::collections::HashMap::new();
    let mut pending = vec![(dom.document.clone(), None, false)];
    let mut authored = std::collections::HashSet::new();
    let mut found = std::collections::HashSet::new();
    while let Some((node, mut parent, mut raw)) = pending.pop() {
        match &node.data {
            NodeData::Element {
                name,
                attrs,
                template_contents,
                ..
            } => {
                let namespace = name.ns.to_string();
                let local = name.local.to_string();
                raw = raw
                    || matches!(local.as_str(), "script" | "style")
                    || (namespace == "http://www.w3.org/1999/xhtml"
                        && matches!(
                            local.as_str(),
                            "xmp" | "iframe" | "noembed" | "noframes" | "noscript" | "plaintext"
                        ));
                for (offset, expression) in &expressions {
                    if local.contains(expression)
                        || attrs
                            .borrow()
                            .iter()
                            .any(|a| a.name.local.contains(expression))
                    {
                        return Err(Diagnostic::new(
                            path,
                            source,
                            *offset,
                            "dynamic HTML names are not supported",
                        ));
                    }
                    if attrs.borrow().iter().any(|a| a.value.contains(expression)) {
                        found.insert(*offset);
                    }
                }
                let origin = attrs
                    .borrow()
                    .iter()
                    .find(|a| a.name.local.as_ref() == marker)
                    .and_then(|a| a.value.parse::<usize>().ok());
                let range = origin
                    .filter(|index| authored.insert(*index))
                    .map(|index| starts[index].0.clone());
                let index = elements.len();
                elements.push(Element {
                    namespace,
                    name: local,
                    parent,
                    source: range,
                });
                parent = Some(index);
                if let Some(contents) = template_contents.borrow().as_ref() {
                    pending.push((contents.clone(), parent, false));
                }
            }
            NodeData::Text { contents } => {
                for (offset, expression) in &expressions {
                    if contents.borrow().contains(expression) {
                        if raw {
                            return Err(Diagnostic::new(
                                path,
                                source,
                                *offset,
                                "interpolation is not supported in raw text",
                            ));
                        }
                        found.insert(*offset);
                        content_parents.insert(*offset, parent);
                    }
                }
            }
            _ => {}
        }
        for child in node.children.borrow().iter().rev() {
            pending.push((child.clone(), parent, raw));
        }
    }
    for (offset, _) in expressions {
        if !found.contains(&offset) {
            return Err(Diagnostic::new(
                path,
                source,
                offset,
                "interpolation does not occupy HTML text or an attribute value",
            ));
        }
    }
    if !document_source {
        // The fragment parser's synthetic html root is not an output parent.
        for parent in content_parents
            .values_mut()
            .chain(elements.iter_mut().map(|e| &mut e.parent))
        {
            if *parent == Some(0) {
                *parent = None;
            }
        }
    }
    Ok((elements, content_parents))
}

fn render_expression(source: &str) -> syn::Result<(syn::Expr, Option<syn::Expr>)> {
    use syn::parse::Parser;
    let parser = |input: syn::parse::ParseStream<'_>| {
        let expression = input.parse::<syn::Expr>()?;
        let scope = if input.is_empty() {
            None
        } else {
            let keyword = input.parse::<syn::Ident>()?;
            if keyword != "scope" {
                return Err(syn::Error::new(keyword.span(), "expected scope"));
            }
            let content;
            syn::parenthesized!(content in input);
            let value = content.parse::<syn::Expr>()?;
            if !content.is_empty() {
                return Err(content.error("unexpected scope tokens"));
            }
            Some(value)
        };
        Ok((expression, scope))
    };
    parser.parse_str(source)
}

fn tokenise_tag(source: &str) -> Option<html5ever::tokenizer::Tag> {
    use html5ever::tokenizer::{BufferQueue, Tag, Token, TokenSink, TokenSinkResult, Tokenizer};
    use std::cell::RefCell;
    struct Sink(RefCell<Option<Tag>>);
    impl TokenSink for Sink {
        type Handle = ();
        fn process_token(&self, token: Token, _: u64) -> TokenSinkResult<()> {
            if let Token::TagToken(tag) = token {
                *self.0.borrow_mut() = Some(tag);
            }
            TokenSinkResult::Continue
        }
    }
    let tokenizer = Tokenizer::new(Sink(RefCell::new(None)), Default::default());
    let queue = BufferQueue::default();
    queue.push_back(format!("<{source}>").into());
    let _ = tokenizer.feed(&queue);
    tokenizer.end();
    tokenizer.sink.0.into_inner()
}

fn foreign_breakout(tag: &html5ever::tokenizer::Tag) -> bool {
    matches!(
        tag.name.as_ref(),
        "b" | "big"
            | "blockquote"
            | "body"
            | "br"
            | "center"
            | "code"
            | "dd"
            | "div"
            | "dl"
            | "dt"
            | "em"
            | "embed"
            | "h1"
            | "h2"
            | "h3"
            | "h4"
            | "h5"
            | "h6"
            | "head"
            | "hr"
            | "i"
            | "img"
            | "li"
            | "listing"
            | "menu"
            | "meta"
            | "nobr"
            | "ol"
            | "p"
            | "pre"
            | "ruby"
            | "s"
            | "small"
            | "span"
            | "strong"
            | "strike"
            | "sub"
            | "sup"
            | "table"
            | "tt"
            | "u"
            | "ul"
            | "var"
    ) || (tag.name.as_ref() == "font"
        && tag
            .attrs
            .iter()
            .any(|attr| matches!(attr.name.local.as_ref(), "color" | "face" | "size")))
}
