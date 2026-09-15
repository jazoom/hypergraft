use crate::parser::{Control, Document, Part};
use proc_macro2::{Ident, Span, TokenStream};
use quote::quote;

pub fn generate(
    document: &Document,
    namespace: &str,
    runtime: &TokenStream,
    output: &Ident,
    scope: &Ident,
) -> TokenStream {
    let generator = Generator {
        document,
        namespace,
        runtime,
        output,
        scope,
    };
    let body = generator.sequence(0..document.source.len(), &[], None);
    quote! { #body ::std::result::Result::Ok(()) }
}

struct Generator<'a> {
    document: &'a Document,
    namespace: &'a str,
    runtime: &'a TokenStream,
    output: &'a Ident,
    scope: &'a Ident,
}

type Loops = [(Option<usize>, Ident)];

impl Generator<'_> {
    fn active(&self, parent: Option<usize>, loops: &Loops) -> TokenStream {
        if let Some((_, scope)) = loops.iter().rev().find(|(p, _)| *p == parent) {
            return quote! { &#scope };
        }
        let Self { runtime, scope, .. } = self;
        if parent.is_some() {
            quote! { &#runtime::template::Scope::default() }
        } else {
            quote! { #scope }
        }
    }

    fn sequence(
        &self,
        range: std::ops::Range<usize>,
        loops: &Loops,
        inside_tag: Option<usize>,
    ) -> TokenStream {
        let Self {
            document,
            runtime,
            output,
            namespace,
            ..
        } = self;
        let mut result = TokenStream::new();
        let mut cursor = range.start;
        while cursor < range.end {
            if let Some((slot, tag)) = document.tags.iter().enumerate().find(|(slot, tag)| {
                Some(*slot) != inside_tag && tag.range.start == cursor && tag.range.end <= range.end
            }) {
                let body = self.sequence(tag.range.clone(), loops, Some(slot));
                if tag.dynamic_marker {
                    let buffer = Ident::new("__hypergraft_tag", Span::mixed_site());
                    result.extend(quote! {{
                        let mut #buffer = ::std::string::String::new();
                        { let #output = &mut #buffer; #body }
                        #runtime::template::validate_authored_tag(&#buffer)?;
                        #output.push_str(&#buffer);
                    }});
                } else {
                    result.extend(body);
                }
                cursor = tag.range.end;
                continue;
            }
            if let Some(slot) = inside_tag
                && document.tags[slot].insertion == cursor
                && document.tags[slot].generated
            {
                let tag = &document.tags[slot];
                let parent = document
                    .elements
                    .iter()
                    .find(|e| e.source.as_ref() == Some(&tag.range))
                    .and_then(|e| e.parent);
                let active = self.active(parent, loops);
                let slot = slot as u64;
                result.extend(
                    quote! { #runtime::template::write_key(#output, #namespace, #slot, #active)?; },
                );
            }
            if let Some(part) = document
                .parts
                .iter()
                .find(|p| bounds(p).is_some_and(|(start, _)| start == cursor))
            {
                let (_, end) = bounds(part).unwrap();
                match part {
                    Part::Expression { expression, .. } => result.extend(
                        quote! { #runtime::template::write_escaped(#output, &(#expression))?; },
                    ),
                    Part::Render {
                        expression,
                        scope,
                        offset,
                        ..
                    } => {
                        let active = self.active(document.content_parents[offset], loops);
                        if let Some(key) = scope {
                            result.extend(quote! { #runtime::GraftTemplate::render_scoped_into(&(#expression), #output, #active, &#runtime::template::Scope::default().extended(&(#key))?)?; });
                        } else {
                            result.extend(quote! { #runtime::GraftTemplate::render_into(&(#expression), #output, #active)?; });
                        }
                    }
                    Part::Control {
                        control, offset, ..
                    } => {
                        let mut depth = 0usize;
                        let mut separators = Vec::new();
                        for candidate in &document.parts {
                            let Part::Control {
                                control,
                                offset: next,
                                ..
                            } = candidate
                            else {
                                continue;
                            };
                            if next <= offset {
                                continue;
                            }
                            match control {
                                Control::If(_) | Control::For { .. } => depth += 1,
                                Control::EndIf | Control::EndFor if depth > 0 => depth -= 1,
                                _ if depth == 0 => {
                                    separators.push(candidate);
                                    if matches!(control, Control::EndIf | Control::EndFor) {
                                        break;
                                    }
                                }
                                _ => {}
                            }
                        }
                        let last = *separators.last().unwrap();
                        if let Control::For {
                            pattern,
                            expression,
                            key,
                        } = control
                        {
                            let parent = document.content_parents[offset];
                            let active = self.active(parent, loops);
                            let loop_scope = Ident::new(
                                &format!("__hypergraft_loop_{offset}"),
                                Span::mixed_site(),
                            );
                            let seen = Ident::new(
                                &format!("__hypergraft_seen_{offset}"),
                                Span::mixed_site(),
                            );
                            let mut nested = loops.to_vec();
                            nested.push((parent, loop_scope.clone()));
                            let body =
                                self.sequence(end..bounds(last).unwrap().0, &nested, inside_tag);
                            result.extend(quote! {{
                                let mut #seen = #runtime::template::LoopKeys::default();
                                for #pattern in #expression {
                                    let #loop_scope = #seen.enter(#active, &(#key))?;
                                    #body
                                }
                            }});
                        } else {
                            let mut branch = part;
                            for next in &separators {
                                let body = self.sequence(
                                    bounds(branch).unwrap().1..bounds(next).unwrap().0,
                                    loops,
                                    inside_tag,
                                );
                                match branch {
                                    Part::Control {
                                        control: Control::If(condition),
                                        ..
                                    } => result.extend(quote! { if #condition { #body } }),
                                    Part::Control {
                                        control: Control::ElseIf(condition),
                                        ..
                                    } => result.extend(quote! { else if #condition { #body } }),
                                    Part::Control {
                                        control: Control::Else,
                                        ..
                                    } => result.extend(quote! { else { #body } }),
                                    _ => unreachable!(),
                                }
                                branch = next;
                            }
                        }
                        cursor = bounds(last).unwrap().1;
                        continue;
                    }
                    Part::Literal(_) => unreachable!(),
                }
                cursor = end;
                continue;
            }
            let next = document
                .parts
                .iter()
                .filter_map(bounds)
                .map(|(start, _)| start)
                .chain(
                    document
                        .tags
                        .iter()
                        .enumerate()
                        .filter(|(slot, _)| Some(*slot) != inside_tag)
                        .map(|(_, t)| t.range.start),
                )
                .chain(inside_tag.map(|slot| document.tags[slot].insertion))
                .filter(|offset| *offset > cursor && *offset < range.end)
                .min()
                .unwrap_or(range.end);
            let literal = &document.source[cursor..next];
            result.extend(quote! { #output.push_str(#literal); });
            cursor = next;
        }
        result
    }
}

fn bounds(part: &Part) -> Option<(usize, usize)> {
    match part {
        Part::Expression { offset, end, .. }
        | Part::Render { offset, end, .. }
        | Part::Control { offset, end, .. } => Some((*offset, *end)),
        Part::Literal(_) => None,
    }
}
