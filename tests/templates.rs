use hypergraft::GraftTemplate;

#[derive(GraftTemplate)]
#[graft(path = "tests/./templates/escaping.graft.html")]
struct Escaping<'a> {
    value: &'a str,
}

#[derive(GraftTemplate)]
#[graft(path = "tests/templates/delimiters.graft.html")]
struct Delimiters<'a> {
    value: Option<&'a str>,
}

// These type parameters shadow prelude names to expose generated-code name collisions.
#[derive(GraftTemplate)]
#[graft(path = "tests/templates/paragraph.graft.html")]
struct Formatted<String: std::fmt::Display, Result> {
    value: String,
    marker: std::marker::PhantomData<Result>,
}

#[derive(GraftTemplate)]
#[graft(path = "tests/templates/literal.graft.html")]
struct Literal;

#[test]
fn literal_raw_text_and_optional_markup_keep_source_bytes() {
    assert_eq!(
        Literal.render().unwrap(),
        include_str!("templates/literal.graft.html")
    );
}

struct FallibleDisplay(bool);

impl std::fmt::Display for FallibleDisplay {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("<&")?;
        formatter.write_str("secret")?;
        if self.0 { Err(std::fmt::Error) } else { Ok(()) }
    }
}

#[test]
fn generated_output_borrows_display_values_and_bounds_format_failures() {
    let mut template = Formatted::<_, ()> {
        value: FallibleDisplay(false),
        marker: std::marker::PhantomData,
    };
    assert_eq!(
        template.render().unwrap(),
        "<p data-graft-key=\"u:7265616479\">&lt;&amp;secret</p>"
    );
    template.value.0 = true;
    assert_eq!(
        template.render().unwrap_err(),
        hypergraft::TemplateError::Rendering
    );
    let error = hypergraft::PatchSet::new()
        .children("target", &template)
        .unwrap_err();
    assert_eq!(error.kind(), hypergraft::PatchBuildErrorKind::Rendering);
    assert!(!error.to_string().contains("secret"));
}

#[test]
fn escaped_output_preserves_data_in_text_and_both_attribute_quotes() {
    let rendered = Escaping {
        value: "<&>\"'🦀"
    }
    .render()
    .unwrap();
    let escaped = "&lt;&amp;&gt;&quot;&#39;🦀";
    assert_eq!(
        rendered,
        format!(
            "<p title=\"{escaped}\" data-single='{escaped}'>{escaped}</p><title>{escaped}</title><textarea>{escaped}</textarea>"
        )
    );
}

#[test]
fn rust_tokens_keep_template_delimiters_inside_literals_and_comments() {
    assert_eq!(
        Delimiters { value: Some("abc") }.render().unwrap(),
        "a &quot; }} b|a }} b|raw }} and {% text|}|ok|ok|3<i title=\"a }} b\">&lt;</i>\n"
    );
}
