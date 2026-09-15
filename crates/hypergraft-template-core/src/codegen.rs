use crate::parser::{Document, Part};
use proc_macro2::{Ident, TokenStream};
use quote::quote;

pub fn generate(
    document: &Document,
    namespace: &str,
    runtime: &TokenStream,
    output: &Ident,
    scope: &Ident,
) -> TokenStream {
    let mut statements = TokenStream::new();
    let mut cursor = 0;
    // Slots belong to the complete lexical source, including authored identities.
    for (slot, tag) in document.tags.iter().enumerate() {
        statements.extend(sequence(
            document,
            cursor..tag.range.start,
            runtime,
            output,
            scope,
        ));
        let mut body = sequence(
            document,
            tag.range.start..tag.insertion,
            runtime,
            output,
            scope,
        );
        if tag.generated {
            let parent = document
                .elements
                .iter()
                .find(|e| e.source.as_ref() == Some(&tag.range))
                .and_then(|e| e.parent);
            let active = active_scope(parent, runtime, scope);
            let slot = slot as u64;
            body.extend(
                quote! { #runtime::template::write_key(#output, #namespace, #slot, #active)?; },
            );
        }
        body.extend(sequence(
            document,
            tag.insertion..tag.range.end,
            runtime,
            output,
            scope,
        ));
        if tag.dynamic_marker {
            let tag_buffer = Ident::new("__hypergraft_tag", proc_macro2::Span::mixed_site());
            statements.extend(quote! {
                {
                    let mut #tag_buffer = ::std::string::String::new();
                    { let #output = &mut #tag_buffer; #body }
                    #runtime::template::validate_authored_tag(&#tag_buffer)?;
                    #output.push_str(&#tag_buffer);
                }
            });
        } else {
            statements.extend(body);
        }
        cursor = tag.range.end;
    }
    statements.extend(sequence(
        document,
        cursor..document.source.len(),
        runtime,
        output,
        scope,
    ));
    quote! { #statements ::std::result::Result::Ok(()) }
}

fn active_scope(parent: Option<usize>, runtime: &TokenStream, scope: &Ident) -> TokenStream {
    if parent.is_some() {
        quote! { &#runtime::template::Scope::default() }
    } else {
        quote! { #scope }
    }
}

fn sequence(
    document: &Document,
    range: std::ops::Range<usize>,
    runtime: &TokenStream,
    output: &Ident,
    scope: &Ident,
) -> TokenStream {
    let mut result = TokenStream::new();
    let mut cursor = range.start;
    for part in &document.parts {
        let (offset, end) = match part {
            Part::Expression { offset, end, .. } | Part::Render { offset, end, .. } => {
                (*offset, *end)
            }
            Part::Literal(_) => continue,
        };
        if offset < range.start || offset >= range.end {
            continue;
        }
        let literal = &document.source[cursor..offset];
        result.extend(quote! { #output.push_str(#literal); });
        match part {
            Part::Expression { expression, .. } => result.extend(quote! {
                #runtime::template::write_escaped(#output, &(#expression))?;
            }),
            Part::Render {
                expression,
                scope: explicit,
                ..
            } => {
                let active = active_scope(document.content_parents[&offset], runtime, scope);
                if let Some(key) = explicit {
                    result.extend(quote! {
                        #runtime::GraftTemplate::render_scoped_into(
                            &(#expression),
                            #output,
                            #active,
                            &#runtime::template::Scope::default().extended(&(#key))?,
                        )?;
                    });
                } else {
                    result.extend(quote! {
                        #runtime::GraftTemplate::render_into(&(#expression), #output, #active)?;
                    });
                }
            }
            Part::Literal(_) => unreachable!(),
        }
        cursor = end;
    }
    let literal = &document.source[cursor..range.end];
    result.extend(quote! { #output.push_str(#literal); });
    result
}
