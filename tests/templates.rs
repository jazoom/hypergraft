use hypergraft::GraftTemplate;

fn annotation(name: &str, slot: usize) -> String {
    let path = format!("tests/templates/{name}.graft.html");
    let source =
        std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(&path))
            .unwrap();
    let namespace =
        hypergraft_template_core::identity::namespace("hypergraft", &path, &source).unwrap();
    format!(" data-graft-key=\"g1:{namespace}:{slot}:\"")
}

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
    assert_eq!(Literal.render().unwrap(), {
        let mut expected = include_str!("templates/literal.graft.html").to_owned();
        let mut cursor = 0;
        for (slot, name) in [
            "style",
            "script",
            "ul",
            "li",
            "li",
            "svg",
            "foreignObject",
            "style",
        ]
        .iter()
        .enumerate()
        {
            let insertion =
                cursor + expected[cursor..].find(&format!("<{name}")).unwrap() + name.len() + 1;
            let marker = annotation("literal", slot);
            expected.insert_str(insertion, &marker);
            cursor = insertion + marker.len();
        }
        expected
    });
}

#[derive(GraftTemplate)]
#[graft(path = "tests/templates/composition.graft.html")]
struct Composition<'a, T: GraftTemplate + ?Sized> {
    text: &'a str,
    body: &'a T,
}

#[test]
fn typed_composition_preserves_html_and_propagates_nested_errors() {
    let mut child = Formatted::<_, ()> {
        value: FallibleDisplay(false),
        marker: std::marker::PhantomData,
    };
    let html = child.render().unwrap();
    let shell = Composition {
        text: "<b>data</b>",
        body: &child as &dyn GraftTemplate,
    };
    assert_eq!(
        shell.render().unwrap(),
        format!(
            "<main{}>&lt;b&gt;data&lt;/b&gt;{html}{html}</main>",
            annotation("composition", 0)
        )
    );
    child.value.0 = true;
    let shell = Composition {
        text: "prefix",
        body: &child,
    };
    assert_eq!(
        shell.render().unwrap_err(),
        hypergraft::TemplateError::Rendering
    );
    let error = hypergraft::PatchSet::new()
        .children("main", &shell)
        .unwrap_err();
    assert_eq!(error.kind(), hypergraft::PatchBuildErrorKind::Rendering);
    assert!(!error.to_string().contains("secret"));
}

#[derive(GraftTemplate)]
#[graft(path = "tests/templates/card.graft.html")]
struct Card;

#[derive(GraftTemplate)]
#[graft(path = "tests/templates/./card.graft.html")]
struct SameCard;

#[derive(GraftTemplate)]
#[graft(path = "tests/templates/scoped-composition.graft.html")]
struct ScopedComposition {
    card: Card,
}

#[derive(GraftTemplate)]
#[graft(path = "tests/templates/scoped-equivalence.graft.html")]
struct ScopedEquivalence<'a, T: GraftTemplate + ?Sized> {
    card: &'a T,
}

#[derive(GraftTemplate)]
#[graft(path = "tests/templates/authored-identity.graft.html")]
struct AuthoredIdentity<'a> {
    id: &'a str,
    marker: &'a str,
}

#[derive(GraftTemplate)]
#[graft(path = "tests/templates/entity-marker.graft.html")]
struct EntityMarker<'a> {
    value: &'a str,
    entity: &'a str,
}

#[derive(GraftTemplate)]
#[graft(path = "tests/templates/implied-scope.graft.html")]
struct ImpliedScope;

#[derive(GraftTemplate)]
#[graft(path = "tests/templates/generated-limit.graft.html")]
struct GeneratedLimit<'a> {
    value: &'a str,
}

fn markers(html: &str) -> Vec<&str> {
    html.split("data-graft-key=\"")
        .skip(1)
        .map(|part| part.split('"').next().unwrap())
        .collect()
}

fn scopes(html: &str) -> Vec<&str> {
    markers(html)
        .into_iter()
        .map(|key| key.rsplit(':').next().unwrap())
        .collect()
}

#[test]
fn source_identity_ignores_rust_types_and_scope_resets_at_each_parent() {
    assert_eq!(Card.render().unwrap(), SameCard.render().unwrap());
    let html = Card.scoped(7).render().unwrap();
    assert_eq!(
        scopes(&html),
        ["00000006690000000137", "", "", "00000006690000000137"]
    );
    assert!(!html.contains(" id="));
    assert_eq!(
        markers(&html)
            .iter()
            .map(|key| key.split(':').nth(2).unwrap())
            .collect::<Vec<_>>(),
        ["0", "1", "2", "3"]
    );

    let html = ScopedComposition { card: Card }.scoped(7).render().unwrap();
    let keys = markers(&html);
    let scope = scopes(&html);
    assert_eq!(scope[0], "000000066900000001370000000973000000046c656674");
    assert_eq!(scope[4], "000000066900000001370000000a73000000057269676874");
    assert_ne!(keys[0], keys[4]);
    assert_eq!(keys[1], keys[5]);
    assert_eq!(keys[2], keys[6]);
    // Both the generated section and the authored-ID section reset composition scope.
    assert_eq!(scope[8], "00000006690000000137");
    assert!(scope[9..].iter().all(|value| value.is_empty()));
    assert_eq!(&keys[9..13], &keys[13..17]);

    let html = ImpliedScope.scoped(7).render().unwrap();
    assert_eq!(
        scopes(&html),
        [
            "00000006690000000137",
            "",
            "",
            "00000006690000000137",
            "",
            "00000006690000000137",
            ""
        ]
    );
    assert!(!html.contains("<tbody"));
}

#[test]
fn borrowed_and_composed_scopes_preserve_chain_order() {
    let card = Card.scoped(2);
    let expected = Card.scoped(2).scoped(7).render().unwrap();
    assert_eq!((&card).scoped(7).render().unwrap(), expected);
    let erased: &dyn GraftTemplate = &card;
    assert_eq!(erased.scoped(7).render().unwrap(), expected);
    let composed = ScopedEquivalence { card: erased };
    assert_eq!(composed.render().unwrap(), expected);
    let html = composed.scoped(1).render().unwrap();
    assert_eq!(
        scopes(&html),
        [
            "000000066900000001310000000669000000013200000006690000000137",
            "",
            "",
            "000000066900000001310000000669000000013200000006690000000137"
        ]
    );
}

#[test]
fn authored_identity_precedes_generated_keys_and_fails_without_secret_data() {
    let html = AuthoredIdentity {
        id: "public",
        marker: "u:61",
    }
    .scoped(7)
    .render()
    .unwrap();
    assert_eq!(
        html,
        format!(
            "<p id=\"public\" data-graft-key=\"u:61\">Text</p><p id=\"public-other\">ID</p><p{}>Generated</p>",
            annotation("authored-identity", 2).replace(":2:\"", ":2:00000006690000000137\"")
        )
    );
    for marker in [
        "",
        "u:",
        "u:a",
        "u:AA",
        "g1:secret:0:",
        "u:secret",
        &format!("u:{}", "aa".repeat(512)),
    ] {
        let template = AuthoredIdentity {
            id: "valid",
            marker,
        };
        assert_eq!(
            template.render(),
            Err(hypergraft::TemplateError::InvalidKey)
        );
        let error = hypergraft::PatchSet::new()
            .children("target", &template)
            .unwrap_err();
        assert_eq!(error.kind(), hypergraft::PatchBuildErrorKind::Rendering);
        assert!(!format!("{error:?} {error}").contains("secret"));
    }
    let exact = format!("u:{}", "aa".repeat(511));
    assert!(
        AuthoredIdentity {
            id: "valid",
            marker: &exact
        }
        .render()
        .is_ok()
    );
    let decoded = EntityMarker {
        value: "61",
        entity: "54",
    }
    .render()
    .unwrap();
    assert!(decoded.contains("u&#58;61"));
    assert!(decoded.contains("u:&#54;1"));
    // Escaped ampersands cannot introduce another character reference.
    assert_eq!(
        EntityMarker {
            value: "61",
            entity: "54;1&#49"
        }
        .render(),
        Err(hypergraft::TemplateError::InvalidKey)
    );
}

#[test]
fn semantic_encoder_matches_the_fixture_and_scoped_append_is_cumulative() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../protocol-v1.json")).unwrap();
    let contract = &fixture["reconciliation"];
    assert_eq!(
        contract["maximumBytes"],
        hypergraft::template::KEY_MAXIMUM_BYTES
    );
    assert_eq!(
        contract["semanticMaximumBytes"],
        hypergraft::template::KEY_MAXIMUM_BYTES
    );
    assert_eq!(contract["generatedPrefix"], "g1:");
    assert_eq!(contract["authoredPrefix"], "u:");
    assert_eq!(contract["namespaceHexDigits"], 64);
    assert_eq!(contract["format"], 1);
    assert_eq!(contract["slotMaximum"], u64::MAX.to_string());
    let root_scope = |html: String| scopes(&html)[0].to_owned();
    assert_eq!(
        root_scope(Card.scoped(7u8).render().unwrap()),
        root_scope(Card.scoped(7i128).render().unwrap())
    );
    assert_eq!(
        root_scope(Card.scoped(false).render().unwrap()),
        "000000026200"
    );
    assert_eq!(
        root_scope(Card.scoped("").render().unwrap()),
        "000000057300000000"
    );
    assert_eq!(
        root_scope(Card.scoped(("ab", "c")).render().unwrap()),
        "0000001a7400000002000000077300000002616200000006730000000163"
    );
    assert_ne!(
        Card.scoped(("ab", "c")).render().unwrap(),
        Card.scoped(("a", "bc")).render().unwrap()
    );
    assert_ne!(
        Card.scoped("1").render().unwrap(),
        Card.scoped(1).render().unwrap()
    );
    assert_eq!(
        root_scope(Card.scoped(2).scoped(7).render().unwrap()),
        "0000000669000000013200000006690000000137"
    );
    assert_ne!(
        Card.scoped(2).scoped(7).render().unwrap(),
        Card.scoped((2, 7)).render().unwrap()
    );
    assert!(Card.scoped(u128::MAX).render().is_ok());
    assert!(Card.scoped(i128::MIN).render().is_ok());
    assert!(
        Card.scoped((1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12))
            .render()
            .is_ok()
    );
    let mut previous = None;
    for instance in [41, 42] {
        let fragment = Card.scoped(instance);
        let expected = fragment.render().unwrap();
        let mut patches = hypergraft::PatchSet::new();
        patches.append("cards", &fragment).unwrap();
        let envelope = patches.encode_live().unwrap();
        assert_eq!(
            envelope,
            format!(
                "<graft-patch-set version=\"1\"><graft-patch operation=\"append\" target=\"cards\"><template>{expected}</template></graft-patch></graft-patch-set>"
            )
        );
        let html = &expected;
        if let Some(previous) = previous {
            assert_ne!(markers(html)[0], previous);
        }
        previous = Some(markers(html)[0].to_owned());
    }
    let exact = Card.scoped("a".repeat(468)).render().unwrap();
    assert_eq!(markers(&exact)[0].len(), 1024);
    for length in [469, 1024, 1025] {
        assert_eq!(
            Card.scoped("a".repeat(length)).render(),
            Err(hypergraft::TemplateError::InvalidKey)
        );
    }
    assert_eq!(
        Card.scoped("a".repeat(600))
            .scoped("b".repeat(600))
            .render(),
        Err(hypergraft::TemplateError::InvalidKey)
    );
}

#[test]
fn generated_metadata_counts_against_the_existing_response_byte_limit() {
    let encode = |value: &str| {
        let mut patches = hypergraft::PatchSet::new();
        patches
            .children("target", &GeneratedLimit { value })
            .unwrap();
        patches.encode_live()
    };
    let overhead = encode("").unwrap().len();
    let exact = "a".repeat(hypergraft::MAX_RESPONSE_BYTES - overhead);
    assert_eq!(
        encode(&exact).unwrap().len(),
        hypergraft::MAX_RESPONSE_BYTES
    );
    let over = format!("{exact}a");
    let hypothetical = format!(
        "<graft-patch-set version=\"1\"><graft-patch operation=\"children\" target=\"target\"><template><p>{over}</p></template></graft-patch></graft-patch-set>"
    );
    assert!(hypothetical.len() < hypergraft::MAX_RESPONSE_BYTES);
    assert_eq!(
        encode(&over).unwrap_err().kind(),
        hypergraft::PatchBuildErrorKind::ResponseLimit
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
            "<p{} title=\"{escaped}\" data-single='{escaped}'>{escaped}</p><title{}>{escaped}</title><textarea{}>{escaped}</textarea>",
            annotation("escaping", 0),
            annotation("escaping", 1),
            annotation("escaping", 2)
        )
    );
}

#[test]
fn rust_tokens_keep_template_delimiters_inside_literals_and_comments() {
    assert_eq!(
        Delimiters { value: Some("abc") }.render().unwrap(),
        format!(
            "a &quot; }}}} b|a }}}} b|raw }}}} and {{% text|}}|ok|ok|3<i{} title=\"a }}}} b\">&lt;</i>\n",
            annotation("delimiters", 0)
        )
    );
}
