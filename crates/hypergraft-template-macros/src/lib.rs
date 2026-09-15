use proc_macro::TokenStream;
use quote::quote;

#[proc_macro_derive(GraftTemplate, attributes(graft))]
pub fn derive(input: TokenStream) -> TokenStream {
    let input = syn::parse_macro_input!(input as syn::DeriveInput);
    expand(&input)
        .unwrap_or_else(syn::Error::into_compile_error)
        .into()
}

fn expand(input: &syn::DeriveInput) -> syn::Result<proc_macro2::TokenStream> {
    let mut path = None;
    for attr in &input.attrs {
        if attr.path().is_ident("graft") {
            attr.parse_nested_meta(|meta| {
                if !meta.path.is_ident("path") {
                    return Err(meta.error("unsupported graft option"));
                }
                if path.is_some() {
                    return Err(meta.error("duplicate template path"));
                }
                path = Some(meta.value()?.parse::<syn::LitStr>()?);
                Ok(())
            })?;
        }
    }
    let path = path.ok_or_else(|| syn::Error::new_spanned(input, "missing graft path"))?;
    let error = |message: &str| syn::Error::new(path.span(), message);
    let logical = hypergraft_template_core::normalise_path(&path.value())
        .map_err(|message| error(&format!("{}:1:1: {message}", path.value())))?;
    let manifest =
        std::env::var("CARGO_MANIFEST_DIR").map_err(|_| error("missing CARGO_MANIFEST_DIR"))?;
    let absolute = std::path::Path::new(&manifest).join(&logical);
    let source =
        std::fs::read_to_string(&absolute).map_err(|e| error(&format!("{logical}:1:1: {e}")))?;
    let runtime =
        match proc_macro_crate::crate_name("hypergraft").map_err(|e| error(&e.to_string()))? {
            proc_macro_crate::FoundCrate::Itself => quote!(::hypergraft),
            proc_macro_crate::FoundCrate::Name(name) => {
                let path = syn::parse_str::<syn::Path>(&format!("::{name}"))
                    .or_else(|_| syn::parse_str::<syn::Path>(&format!("::r#{name}")))?;
                quote!(#path)
            }
        };
    let output = syn::Ident::new("__hypergraft_output", proc_macro2::Span::mixed_site());
    let scope = syn::Ident::new("__hypergraft_scope", proc_macro2::Span::mixed_site());
    let package = std::env::var("CARGO_PKG_NAME").map_err(|_| error("missing CARGO_PKG_NAME"))?;
    let body =
        hypergraft_template_core::compile(&package, &logical, &source, &runtime, &output, &scope)
            .map_err(|e| error(&e.to_string()))?;
    let name = &input.ident;
    let (implementation, types, constraints) = input.generics.split_for_impl();
    Ok(quote! {
        const _: &str = ::core::include_str!(::core::concat!(::core::env!("CARGO_MANIFEST_DIR"), "/", #logical));
        impl #implementation #runtime::GraftTemplate for #name #types #constraints {
            fn render_into(&self, #output: &mut ::std::string::String, #scope: &#runtime::template::Scope) -> ::std::result::Result<(), #runtime::TemplateError> { #body }
        }
    })
}
