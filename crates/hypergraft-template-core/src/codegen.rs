use crate::parser::{Document, Part};
use proc_macro2::TokenStream;
use quote::quote;

pub fn generate(
    document: &Document,
    runtime: &TokenStream,
    output: &proc_macro2::Ident,
) -> TokenStream {
    let statements = document.parts.iter().map(|part| match part {
        Part::Literal(text) => quote! { #output.push_str(#text); },
        Part::Expression { expression, .. } => quote! {
            #runtime::template::write_escaped(#output, &(#expression))?;
        },
    });
    quote! { #(#statements)* ::std::result::Result::Ok(()) }
}
