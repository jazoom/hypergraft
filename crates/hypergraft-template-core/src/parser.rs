use crate::source::Diagnostic;

pub enum Control {
    If(Box<syn::Expr>),
    ElseIf(Box<syn::Expr>),
    Else,
    For {
        pattern: Box<syn::Pat>,
        expression: Box<syn::Expr>,
        key: Box<syn::Expr>,
    },
    EndIf,
    EndFor,
}

pub enum Part {
    Control {
        control: Control,
        offset: usize,
        end: usize,
        attribute: bool,
    },
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
    let mut controls = Vec::<(bool, bool, usize, bool)>::new();
    let mut text_start = None;
    let mut text_ranges = Vec::new();
    while i < bytes.len() {
        let rest = &source[i..];
        if (rest.starts_with("{{") || rest.starts_with("{%"))
            && let Some(start) = text_start.take()
        {
            text_ranges.push(start..i);
        }
        if rest.starts_with("{%") {
            if !matches!(state, State::Text | State::Tag) {
                return Err(Diagnostic::new(
                    path,
                    source,
                    i,
                    "directives require ordinary node content or complete attribute boundaries",
                ));
            }
            let end = expression_end(&source[i + 2..], "%}")
                .ok_or_else(|| Diagnostic::new(path, source, i, "unterminated directive"))?
                + i
                + 2;
            let directive = source[i + 2..end].trim();
            if strip_keyword(directive, "render").is_none() {
                let control = parse_control(directive).map_err(|error| {
                    Diagnostic::new(
                        path,
                        source,
                        i,
                        &format!("invalid control directive: {error}"),
                    )
                })?;
                let attribute = matches!(state, State::Tag);
                if attribute
                    && (source[tag_start + 1..].starts_with('/')
                        || source[tag_start + 1..i].trim().is_empty()
                        || (matches!(control, Control::If(_))
                            && !bytes[i - 1].is_ascii_whitespace()
                            && !matches!(parts.last(), Some(Part::Control { end, attribute: true, .. }) if *end == i))
                        || source[tag_start..i].trim_end().ends_with('='))
                {
                    return Err(Diagnostic::new(
                        path,
                        source,
                        i,
                        "control directives require complete attribute boundaries",
                    ));
                }
                match &control {
                    Control::If(_) => controls.push((false, attribute, tag_start, false)),
                    Control::For { .. } if !attribute => {
                        controls.push((true, false, tag_start, false))
                    }
                    Control::Else | Control::ElseIf(_) | Control::EndIf | Control::EndFor => {
                        let Some((is_loop, in_tag, opening_tag, had_else)) = controls.last_mut()
                        else {
                            return Err(Diagnostic::new(
                                path,
                                source,
                                i,
                                "unmatched control directive",
                            ));
                        };
                        if *in_tag != attribute
                            || (attribute && *opening_tag != tag_start)
                            || *is_loop != matches!(control, Control::EndFor)
                            || (*had_else && matches!(control, Control::Else | Control::ElseIf(_)))
                        {
                            return Err(Diagnostic::new(
                                path,
                                source,
                                i,
                                "malformed control nesting or HTML boundary",
                            ));
                        }
                        if matches!(control, Control::Else) {
                            *had_else = true;
                        }
                        if matches!(control, Control::EndIf | Control::EndFor) {
                            controls.pop();
                        }
                    }
                    _ => {
                        return Err(Diagnostic::new(
                            path,
                            source,
                            i,
                            "loops require ordinary node content",
                        ));
                    }
                }
                parts.push(Part::Literal(source[start..i].into()));
                parts.push(Part::Control {
                    control,
                    offset: i,
                    end: end + 2,
                    attribute,
                });
                replacements.push((
                    i..end + 2,
                    if attribute {
                        " ".into()
                    } else {
                        format!("<!--{expression_marker}{i}_-->")
                    },
                ));
                i = end + 2;
                start = i;
                continue;
            }
            if !matches!(state, State::Text) {
                return Err(Diagnostic::new(
                    path,
                    source,
                    i,
                    "composition requires ordinary node content",
                ));
            }
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
        let was_text = matches!(state, State::Text);
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
        if was_text
            && matches!(state, State::Text)
            && controls.iter().any(|(_, attribute, _, _)| !attribute)
        {
            text_start.get_or_insert(i);
        } else if let Some(start) = text_start.take() {
            text_ranges.push(start..i);
        }
        i += source[i..].chars().next().unwrap().len_utf8();
    }
    if matches!(
        state,
        State::Tag | State::Quoted(_) | State::Comment | State::Declaration | State::Cdata
    ) {
        return Err(Diagnostic::new(path, source, i, "unterminated HTML token"));
    }
    if !controls.is_empty() {
        return Err(Diagnostic::new(
            path,
            source,
            i,
            "unterminated control directive",
        ));
    }
    parts.push(Part::Literal(source[start..].into()));
    for tag in &tags {
        if parts.iter().any(|part| {
            matches!(part, Part::Control { offset, attribute: true, .. } if tag.range.contains(offset))
        }) {
            replacements.push((
                tag.range.start..tag.range.start,
                format!("<!--{expression_marker}{}_-->", tag.range.start),
            ));
        }
    }
    for range in text_ranges {
        // Whitespace must not acquire a marker that triggers table foster parenting.
        if text_has_non_whitespace(&source[range.clone()]) {
            replacements.push((
                range.start..range.start,
                format!("{expression_marker}{}_", range.start),
            ));
        }
    }
    let (elements, content_parents) = structure(path, source, &starts, replacements)?;
    validate_attributes(path, source, &parts, &tags, &elements, &content_parents)?;
    validate_control_parents(path, source, &parts, &elements, &content_parents)?;
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
    html_integration: bool,
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
        .filter(|(_, marker)| !marker.trim().is_empty())
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
                let html_integration = match namespace.as_str() {
                    "http://www.w3.org/2000/svg" => {
                        matches!(local.as_str(), "foreignObject" | "desc" | "title")
                    }
                    "http://www.w3.org/1998/Math/MathML" => {
                        matches!(local.as_str(), "mi" | "mo" | "mn" | "ms" | "mtext")
                            || (local == "annotation-xml"
                                && attrs.borrow().iter().any(|attr| {
                                    attr.name.local.as_ref() == "encoding"
                                        && (attr.value.eq_ignore_ascii_case("text/html")
                                            || attr
                                                .value
                                                .eq_ignore_ascii_case("application/xhtml+xml"))
                                }))
                    }
                    _ => false,
                };
                let index = elements.len();
                elements.push(Element {
                    namespace,
                    name: local,
                    parent,
                    source: range,
                    html_integration,
                });
                parent = Some(index);
                if let Some(contents) = template_contents.borrow().as_ref() {
                    pending.push((contents.clone(), parent, false));
                }
            }
            NodeData::Comment { contents } => {
                for (offset, expression) in &expressions {
                    if expression
                        .strip_prefix("<!--")
                        .and_then(|s| s.strip_suffix("-->"))
                        == Some(contents.as_ref())
                    {
                        if raw {
                            return Err(Diagnostic::new(
                                path,
                                source,
                                *offset,
                                "directives are not supported in raw text",
                            ));
                        }
                        found.insert(*offset);
                        content_parents.insert(*offset, parent);
                    }
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
        // The parse copy contains all attribute alternatives. HTML drops later
        // duplicate names, but the attribute validator proves mutual exclusion.
        let alternative_attribute = starts
            .iter()
            .any(|(range, _)| range.contains(&offset) && source[range.clone()].contains("{%"));
        if !found.contains(&offset) && !alternative_attribute {
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

fn strip_keyword<'a>(source: &'a str, keyword: &str) -> Option<&'a str> {
    source
        .strip_prefix(keyword)
        .filter(|rest| rest.starts_with(char::is_whitespace))
        .map(str::trim_start)
}

fn parse_control(source: &str) -> syn::Result<Control> {
    use syn::parse::Parser;
    match source {
        "else" => return Ok(Control::Else),
        "endif" => return Ok(Control::EndIf),
        "endfor" => return Ok(Control::EndFor),
        _ => {}
    }
    if let Some(condition) =
        strip_keyword(source, "else").and_then(|rest| strip_keyword(rest, "if"))
    {
        return syn::parse_str(condition).map(|e| Control::ElseIf(Box::new(e)));
    }
    if let Some(condition) = strip_keyword(source, "if") {
        return syn::parse_str(condition).map(|e| Control::If(Box::new(e)));
    }
    let parser = |input: syn::parse::ParseStream<'_>| {
        input.parse::<syn::Token![for]>()?;
        let pattern = syn::Pat::parse_multi_with_leading_vert(input)?;
        input.parse::<syn::Token![in]>()?;
        let expression = input.parse::<syn::Expr>()?;
        let keyword = input
            .parse::<syn::Ident>()
            .map_err(|_| input.error("every loop requires key(expression)"))?;
        if keyword != "key" {
            return Err(input.error("expected key(expression)"));
        }
        let content;
        syn::parenthesized!(content in input);
        let key = content.parse::<syn::Expr>()?;
        if !content.is_empty() {
            return Err(content.error("unexpected key tokens"));
        }
        Ok(Control::For {
            pattern: Box::new(pattern),
            expression: Box::new(expression),
            key: Box::new(key),
        })
    };
    parser.parse_str(source)
}

fn validate_control_parents(
    path: &str,
    source: &str,
    parts: &[Part],
    elements: &[Element],
    parents: &ContentParents,
) -> Result<(), Diagnostic> {
    let mut stack = Vec::new();
    for part in parts {
        let Part::Control {
            control,
            offset,
            end,
            attribute: false,
        } = part
        else {
            continue;
        };
        let parent = parents[offset];
        match control {
            Control::If(_) | Control::For { .. } => stack.push((parent, *end)),
            _ => {
                let (expected, start) = *stack.last().unwrap();
                let belongs_to_body = |mut parent| {
                    while parent != expected {
                        let Some(index) = parent else {
                            return false;
                        };
                        let element = &elements[index];
                        if let Some(range) = &element.source {
                            return range.start >= start && range.start < *offset;
                        }
                        parent = element.parent;
                    }
                    true
                };
                if parent != expected
                    || elements.iter().any(|element| {
                        element
                            .source
                            .as_ref()
                            .is_some_and(|r| r.start >= start && r.start < *offset)
                            && !belongs_to_body(element.parent)
                    })
                    || parents.iter().any(|(position, parent)| {
                        *position >= start && *position < *offset && !belongs_to_body(*parent)
                    })
                {
                    return Err(Diagnostic::new(
                        path,
                        source,
                        *offset,
                        "control body must preserve its HTML parent boundary",
                    ));
                }
                if matches!(control, Control::EndIf | Control::EndFor) {
                    stack.pop();
                } else {
                    stack.last_mut().unwrap().1 = *end;
                }
            }
        }
    }
    Ok(())
}

fn validate_attributes(
    path: &str,
    source: &str,
    parts: &[Part],
    tags: &[TagOutput],
    elements: &[Element],
    parents: &ContentParents,
) -> Result<(), Diagnostic> {
    for tag in tags {
        let parent = parents
            .get(&tag.range.start)
            .and_then(|parent| parent.map(|index| &elements[index]));
        let name = source[tag.range.start + 1..tag.insertion].to_ascii_lowercase();
        // These attributes alter tree construction, not only element presentation.
        let structural_attributes: &[&str] = match (name.as_str(), parent) {
            ("input", Some(parent))
                if parent.namespace == "http://www.w3.org/1999/xhtml"
                    && matches!(
                        parent.name.as_str(),
                        "table" | "tbody" | "thead" | "tfoot" | "tr"
                    ) =>
            {
                &["type"]
            }
            ("annotation-xml", _)
                if elements.iter().any(|element| {
                    element.source.as_ref() == Some(&tag.range)
                        && element.namespace == "http://www.w3.org/1998/Math/MathML"
                }) =>
            {
                &["encoding"]
            }
            ("font", Some(parent))
                if parent.namespace != "http://www.w3.org/1999/xhtml"
                    && !parent.html_integration =>
            {
                &["color", "face", "size"]
            }
            _ => &[],
        };
        let mut branches = Vec::<(usize, usize)>::new();
        let mut boundaries = Vec::<AttributeBoundary>::new();
        let mut needs_separator = true;
        let mut declarations = Vec::<(String, Vec<(usize, usize)>)>::new();
        let mut cursor = tag.insertion;
        for part in parts {
            let Part::Control {
                control,
                offset,
                end,
                attribute: true,
            } = part
            else {
                continue;
            };
            if *offset < tag.range.start || *offset >= tag.range.end {
                continue;
            }
            let segment = &source[cursor..*offset];
            if segment.trim_end().ends_with('=')
                || (cursor == tag.insertion && !segment.starts_with(char::is_whitespace))
            {
                return Err(Diagnostic::new(
                    path,
                    source,
                    *offset,
                    "control directives require complete attribute boundaries",
                ));
            }
            let mut literal = segment.to_owned();
            for part in parts.iter().rev() {
                if let Part::Expression { offset, end, .. } = part
                    && *offset >= cursor
                    && *end <= cursor + segment.len()
                {
                    literal.replace_range(offset - cursor..end - cursor, "value");
                }
            }
            validate_attribute_spacing(path, source, cursor, &literal, &mut needs_separator)?;
            record_attributes(
                path,
                source,
                cursor,
                &literal,
                &branches,
                structural_attributes,
                &mut declarations,
            )?;
            match control {
                Control::If(_) => {
                    branches.push((*offset, 0));
                    boundaries.push(AttributeBoundary {
                        entry: needs_separator,
                        completed: false,
                        exhaustive: false,
                    });
                }
                Control::Else | Control::ElseIf(_) => {
                    branches.last_mut().unwrap().1 += 1;
                    let boundary = boundaries.last_mut().unwrap();
                    boundary.completed |= needs_separator;
                    boundary.exhaustive = matches!(control, Control::Else);
                    needs_separator = boundary.entry;
                }
                Control::EndIf => {
                    branches.pop();
                    let boundary = boundaries.pop().unwrap();
                    needs_separator |=
                        boundary.completed || (!boundary.exhaustive && boundary.entry);
                }
                _ => {}
            }
            cursor = *end;
        }
        if cursor != tag.insertion {
            let mut literal = source[cursor..tag.range.end - 1]
                .trim_end_matches('/')
                .to_owned();
            for part in parts.iter().rev() {
                if let Part::Expression { offset, end, .. } = part
                    && *offset >= cursor
                    && *end < tag.range.end
                {
                    literal.replace_range(offset - cursor..end - cursor, "value");
                }
            }
            validate_attribute_spacing(path, source, cursor, &literal, &mut needs_separator)?;
            record_attributes(
                path,
                source,
                cursor,
                &literal,
                &branches,
                structural_attributes,
                &mut declarations,
            )?;
        }
    }
    Ok(())
}

struct AttributeBoundary {
    entry: bool,
    completed: bool,
    exhaustive: bool,
}

fn validate_attribute_spacing(
    path: &str,
    source: &str,
    offset: usize,
    literal: &str,
    needs_separator: &mut bool,
) -> Result<(), Diagnostic> {
    if !literal.is_empty() {
        if *needs_separator && !literal.starts_with(char::is_whitespace) {
            return Err(Diagnostic::new(
                path,
                source,
                offset,
                "attribute declarations require literal whitespace on every control path",
            ));
        }
        *needs_separator = !literal.ends_with(char::is_whitespace);
    }
    Ok(())
}

type AttributeDeclarations = Vec<(String, Vec<(usize, usize)>)>;

fn record_attributes(
    path: &str,
    source: &str,
    offset: usize,
    literal: &str,
    branches: &[(usize, usize)],
    structural_attributes: &[&str],
    declarations: &mut AttributeDeclarations,
) -> Result<(), Diagnostic> {
    let error = || {
        Diagnostic::new(
            path,
            source,
            offset,
            "control directives require complete attributes",
        )
    };
    let mut rest = literal.trim();
    while !rest.is_empty() {
        let length = rest
            .find(|c: char| c.is_ascii_whitespace() || c == '=')
            .unwrap_or(rest.len());
        if length == 0 {
            return Err(error());
        }
        let name = rest[..length].to_ascii_lowercase();
        if name.contains(['\'', '"', '<', '>', '/']) {
            return Err(error());
        }
        rest = rest[length..].trim_start();
        if let Some(value) = rest.strip_prefix('=') {
            rest = value.trim_start();
            if let Some(quote @ (b'\'' | b'"')) = rest.as_bytes().first().copied() {
                let end = rest[1..].find(char::from(quote)).ok_or_else(error)? + 1;
                rest = &rest[end + 1..];
            } else {
                let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
                if end == 0 || rest[..end].contains(['\'', '"', '<', '>', '=', '`']) {
                    return Err(error());
                }
                rest = &rest[end..];
            }
            if !rest.is_empty() && !rest.starts_with(char::is_whitespace) {
                return Err(error());
            }
            rest = rest.trim_start();
        }
        if !branches.is_empty() && matches!(name.as_str(), "id" | "data-graft-key") {
            return Err(Diagnostic::new(
                path,
                source,
                offset,
                "identity attributes must be unconditional",
            ));
        }
        if !branches.is_empty() && structural_attributes.contains(&name.as_str()) {
            return Err(Diagnostic::new(
                path,
                source,
                offset,
                "attributes that control HTML tree construction must be unconditional",
            ));
        }
        if declarations.iter().any(|(previous, alternatives)| {
            previous == &name
                && !alternatives.iter().any(|(id, branch)| {
                    branches
                        .iter()
                        .any(|(other, alternative)| id == other && branch != alternative)
                })
        }) {
            return Err(Diagnostic::new(
                path,
                source,
                offset,
                "duplicate attributes on one control path",
            ));
        }
        declarations.push((name, branches.to_vec()));
    }
    Ok(())
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

fn text_has_non_whitespace(source: &str) -> bool {
    use html5ever::tokenizer::{BufferQueue, Token, TokenSink, TokenSinkResult, Tokenizer};
    use std::cell::Cell;
    struct Sink(Cell<bool>);
    impl TokenSink for Sink {
        type Handle = ();
        fn process_token(&self, token: Token, _: u64) -> TokenSinkResult<()> {
            if let Token::CharacterTokens(text) = token
                && text.chars().any(|c| !c.is_ascii_whitespace())
            {
                self.0.set(true);
            }
            TokenSinkResult::Continue
        }
    }
    let tokenizer = Tokenizer::new(Sink(Cell::new(false)), Default::default());
    let queue = BufferQueue::default();
    queue.push_back(source.into());
    let _ = tokenizer.feed(&queue);
    tokenizer.end();
    tokenizer.sink.0.get()
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
