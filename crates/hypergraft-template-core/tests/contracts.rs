use hypergraft_template_core::parser::parse;

#[test]
fn control_diagnostics_reject_ambiguous_html_and_invalid_nesting() {
    for source in include_str!("fixtures/invalid-controls.txt").lines() {
        let error = parse("invalid-controls.graft.html", source)
            .err()
            .unwrap_or_else(|| panic!("accepted {source}"));
        assert_eq!(error.path, "invalid-controls.graft.html");
        assert_eq!(error.line, 1);
    }
    for source in [
        "<option {% if let Some(value) = self.value %}selected title=\"{{ value }}\"{% else %}disabled{% endif %}>Value</option>",
        "<p {% if self.ready %}title=\"one\"{% else if self.other %}title=\"two\"{% else %}title=\"three\"{% endif %}></p>",
        "<table><tbody>{% for row in self.rows.iter() key(row.id) %}<tr><td>{{ row.id }}</td></tr>{% endfor %}</tbody></table>",
        "{% if self.ready %}<ul><li>One<li>Two</ul>{% endif %}",
        "{% if self.ready %}<table><tr><td>One</table>{% endif %}",
        "<table>{% if self.ready %} &#32; &Tab; {% endif %}</table>",
        "<input {% if self.ready %}type=\"hidden\"{% else %}type=\"text\"{% endif %}>",
        "<input {% if self.ready %}{% if self.other %}disabled{% endif %}{% endif %}>",
        "<input {% if self.ready %}disabled {% endif %}title=\"Save\">",
        "<input {% if self.ready %}disabled {% endif %}{% if self.other %}required{% endif %}>",
        "<svg><foreignObject><font {% if self.ready %}color=\"red\"{% endif %}></font></foreignObject></svg>",
        "<math><annotation-xml encoding=\"text/html\"><font {% if self.ready %}face=\"serif\"{% endif %}></font></annotation-xml></math>",
        "<svg>{% if self.ready %}<circle />{% else %}<rect />{% endif %}</svg>",
        "<template>{% for row in self.rows.iter() key(row.id) %}<p>{{ row.id }}</p>{% endfor %}</template>",
    ] {
        assert!(
            parse("controls.graft.html", source).is_ok(),
            "rejected {source}"
        );
    }
}

#[test]
fn namespace_pins_framing_normalisation_and_complete_revision() {
    use hypergraft_template_core::identity::namespace;
    let expected = "a5dfbf29613766db56e971452574eea5264736fa390ca94420bb3555c174a99e";
    let source = "<p>Card</p>";
    assert_eq!(
        namespace("example", "templates/card.graft.html", source).unwrap(),
        expected
    );
    assert_eq!(
        namespace("example", "templates/./discard/../card.graft.html", source).unwrap(),
        expected
    );
    for (package, path, revised) in [
        ("other", "templates/card.graft.html", source),
        ("example", "templates/other.graft.html", source),
        ("example", "templates/card.graft.html", "<p>Card</p>\n"),
        ("example", "templates/card.graft.html", "<p>Card</p>\r\n"),
    ] {
        assert_ne!(namespace(package, path, revised).unwrap(), expected);
    }
    assert!(namespace("example", "/checkout/templates/card.graft.html", source).is_err());
}

#[test]
fn authored_markers_reject_reserved_malformed_and_over_bound_literals() {
    for marker in [
        "",
        "u:",
        "u:0",
        "u:AA",
        "u:gg",
        "u:&#32;",
        &format!("g1:{}:0:", "a".repeat(64)),
        &format!("u:{}", "aa".repeat(512)),
    ] {
        let source = format!("<p id=\"valid\" data-graft-key=\"{marker}\"></p>");
        let error = parse("marker.graft.html", &source).err().unwrap();
        assert_eq!(error.offset, 0);
        assert_eq!(error.message, "invalid authored reconciliation marker");
    }
    for marker in ["u:&#54;1", &format!("u:{}", "aa".repeat(511))] {
        assert!(
            parse(
                "marker.graft.html",
                &format!("<p data-graft-key=\"{marker}\"></p>")
            )
            .is_ok()
        );
    }
}

#[test]
fn html_tree_distinguishes_authored_tags_from_browser_elements() {
    let source = include_str!("fixtures/structure.graft.html");
    let document = parse("structure.graft.html", source).unwrap();
    let tbody = document
        .elements
        .iter()
        .find(|element| element.name == "tbody")
        .unwrap();
    assert!(tbody.source.is_none());
    let row = document
        .elements
        .iter()
        .find(|element| element.name == "tr")
        .unwrap();
    assert_eq!(document.elements[row.parent.unwrap()].name, "tbody");
    assert_eq!(&source[row.source.clone().unwrap()], "<tr>");
    for (name, namespace) in [
        ("title", "http://www.w3.org/2000/svg"),
        ("input", "http://www.w3.org/1999/xhtml"),
        ("mi", "http://www.w3.org/1998/Math/MathML"),
    ] {
        let element = document
            .elements
            .iter()
            .find(|element| element.name == name)
            .unwrap();
        assert_eq!(element.namespace, namespace);
        assert!(element.source.is_some());
    }
    assert!(
        document
            .elements
            .iter()
            .any(|element| element.name == "b" && element.source.is_some())
    );
}

#[test]
fn unsupported_contexts_fail_at_the_external_source_position() {
    let cases = [
        "<p value={{ self.value }}>",
        "<{{ self.value }}>",
        "<p {{ self.value }}='x'>",
        "</p{{ self.value }}>",
        "<!-- {{ self.value }} -->",
        "<!DOCTYPE {{ self.value }}>",
        "<?{{ self.value }}>",
        "<svg><![CDATA[x > {{ self.value }}]]></svg>",
        "<script>{{ self.value }}</script>",
        "<style>{{ self.value }}</style>",
        "<svg><script>{{ self.value }}</script></svg>",
        "<svg><style>{{ self.value }}</style></svg>",
        "<textarea>{% render self.value %}</textarea>",
        "<title>{% render self.value %}</title>",
        "<p title='{% render self.value %}'>",
        "<p {% render self.value %}>",
        "<{% render self.value %}>",
        "<!-- {% render self.value %} -->",
        "<script>{% render self.value %}</script>",
        "<style>{% render self.value %}</style>",
        "<svg><script>{% render self.value %}</script></svg>",
        include_str!("fixtures/raw-integration.graft.html"),
    ];
    for source in cases {
        let error = match parse("tests/bad.graft.html", source) {
            Err(error) => error,
            Ok(_) => panic!("accepted {source}"),
        };
        assert_eq!(error.path, "tests/bad.graft.html");
        assert_eq!(error.line, 1);
        let offset = source.find("{{").or_else(|| source.find("{%")).unwrap();
        assert_eq!(error.offset, offset, "{source}");
        assert_eq!(
            error.column,
            source[..offset].chars().count() + 1,
            "{source}"
        );
    }
}

#[test]
fn diagnostics_count_unicode_columns_and_source_lines() {
    let error = match parse("broken.graft.html", "<p>\n🦀 {% unknown self.value %}") {
        Err(error) => error,
        Ok(_) => panic!("accepted unsupported directive"),
    };
    assert_eq!((error.line, error.column, error.offset), (2, 3, 9));
}

#[test]
fn table_fragments_keep_authored_elements_and_dynamic_attributes() {
    for (source, name) in [
        ("<tr title=\"{{ self.value }}\"><td>Cell</td></tr>", "tr"),
        ("<td title=\"{{ self.value }}\">Cell</td>", "td"),
        ("<col title=\"{{ self.value }}\">", "col"),
    ] {
        let document = parse("fragment.graft.html", source).unwrap();
        let element = document
            .elements
            .iter()
            .find(|element| element.name == name)
            .unwrap();
        let end = source.find('>').unwrap() + 1;
        assert_eq!(element.source.clone().unwrap(), 0..end);
    }
}

#[test]
fn rcdata_end_tags_accept_the_html_self_closing_flag() {
    let source = "<textarea>Text</textarea/><input value=\"{{ self.value }}\">";
    let document = parse("rcdata.graft.html", source).unwrap();
    let input = document
        .elements
        .iter()
        .find(|element| element.name == "input")
        .unwrap();
    assert_eq!(
        input.source.clone().unwrap(),
        source.find("<input").unwrap()..source.len()
    );
}
