use hypergraft_template_core::{compile_selected, source::Diagnostic};
use proc_macro2::{Ident, Span, TokenStream};

fn compile(source: &str, selected: Option<&str>) -> Result<TokenStream, Diagnostic> {
    compile_selected(
        "fixture",
        "blocks.graft.html",
        source,
        &quote::quote!(::hypergraft),
        &Ident::new("output", Span::call_site()),
        &Ident::new("scope", Span::call_site()),
        selected,
    )
}

#[test]
fn block_diagnostics_own_selection_boundaries_and_captures() {
    for (source, selector, message) in [
        (
            "{% block body %}{% endblock %}",
            Some("absent"),
            "unknown block",
        ),
        (
            "{% block body %}{% block body %}{% endblock %}{% endblock %}",
            None,
            "duplicate block",
        ),
        (
            "{% block body %}{% endblock %}{% block r#body %}{% endblock %}",
            None,
            "duplicate block",
        ),
        (
            "{% block body(x = 1, r#x = 2) %}{% endblock %}",
            None,
            "duplicate block input",
        ),
        (
            "{% block body(x = 1, x = 2) %}{% endblock %}",
            None,
            "duplicate block input",
        ),
        (
            "{% for row in self.rows key(row.id) %}{% block body %}{{ row.label }}{% endblock %}{% endfor %}",
            Some("body"),
            "unavailable surrounding local",
        ),
        (
            "{% if let Some(row) = self.row %}{% block body %}{{ row.label }}{% endblock %}{% endif %}",
            None,
            "unavailable surrounding local",
        ),
        (
            "{% block outer(row = self.row) %}{% block inner %}{{ row.label }}{% endblock %}{% endblock %}",
            None,
            "unavailable surrounding local",
        ),
        (
            "{% block outer(row = self.row) %}{% block inner %}{% render row %}{% endblock %}{% endblock %}",
            None,
            "unavailable surrounding local",
        ),
        (
            "{% for row in self.rows key(row.id) %}{% block body %}{{ r#row.label }}{% endblock %}{% endfor %}",
            Some("body"),
            "unavailable surrounding local",
        ),
        (
            "{% for row in self.rows key(row.id) %}{% block body %}{{ format!(\"{row:?}\") }}{% endblock %}{% endfor %}",
            Some("body"),
            "unavailable surrounding local",
        ),
        (
            "{% for row in self.rows key(row.id) %}{% block body %}{{ vec![row; 2].len() }}{% endblock %}{% endfor %}",
            Some("body"),
            "unavailable surrounding local",
        ),
        (
            "{% for row in self.rows key(row.id) %}{% block body %}{{ format!(\"{:0row$}\", 1) }}{% endblock %}{% endfor %}",
            Some("body"),
            "unavailable surrounding local",
        ),
        (
            "{% for row in self.rows key(row.id) %}{% block body %}{{ format!(\"{:.*}\", row, 1) }}{% endblock %}{% endfor %}",
            Some("body"),
            "unavailable surrounding local",
        ),
        (
            "{% for row in self.rows key(row.id) %}{% block body %}{{ custom!(row => self.value) }}{% endblock %}{% endfor %}",
            Some("body"),
            "unavailable surrounding local",
        ),
        (
            "<p>{% block body %}</p>{% endblock %}",
            None,
            "parent boundary",
        ),
        (
            "<p {% block body %}title=\"x\"{% endblock %}></p>",
            None,
            "ordinary node content",
        ),
        ("{% block body %}{% endif %}", None, "malformed control"),
        (
            "<textarea>{% block body %}x{% endblock %}</textarea>",
            None,
            "ordinary node content",
        ),
    ] {
        let error = compile(source, selector).unwrap_err();
        assert!(error.message.contains(message), "{source}: {error}");
        assert_eq!(error.path, "blocks.graft.html");
        assert_eq!(error.line, 1);
    }
}

#[test]
fn explicit_inputs_and_expression_local_shadowing_remain_available() {
    for (source, selector) in [
        (
            "{% for row in self.rows key(row.id) %}{% block body(row = row) %}{{ row.label }}{% endblock %}{% endfor %}",
            "body",
        ),
        (
            "{% if let Some(row) = self.row %}{% block body(row = row) %}{{ row.label }}{% endblock %}{% endif %}",
            "body",
        ),
        (
            "{% for row in self.rows key(row.id) %}{% block body %}{{ { let row = 1; row } }}{% endblock %}{% endfor %}",
            "body",
        ),
        (
            "{% for row in self.rows key(row.id) %}{% block body %}{{ { let r#row = 1; row } }}{% endblock %}{% endfor %}",
            "body",
        ),
        (
            "{% for row in self.rows key(row.id) %}{% block body %}{{ format!(\"{row}\", row = self.label) }}{% endblock %}{% endfor %}",
            "body",
        ),
        (
            "{% for row in self.rows key(row.id) %}{% block body %}{{ format!(\"{{row}}\") }}{% endblock %}{% endfor %}",
            "body",
        ),
        (
            "{% block outer(row = self.row) %}{% block inner(row = row) %}{{ row.label }}{% endblock %}{% endblock %}",
            "inner",
        ),
        (
            "{% for row in self.rows key(row.id) %}{% block body %}{{ stringify!(row) }}{% endblock %}{% endfor %}",
            "body",
        ),
        (
            "{% for row in self.rows key(row.id) %}{% block body %}{{ format!(\"{:row$.row$}\", 1, row = 2) }}{% endblock %}{% endfor %}",
            "body",
        ),
        (
            "{% for row in self.rows key(row.id) %}{% block body %}{{ format!(\"{}\", { let row = 1; row }) }}{% endblock %}{% endfor %}",
            "body",
        ),
        ("{% block r#body %}<p>Body</p>{% endblock %}", "body"),
        ("{% block body %}<p>Body</p>{% endblock %}", "r#body"),
    ] {
        compile(source, Some(selector)).unwrap_or_else(|error| panic!("{source}: {error}"));
    }
}
