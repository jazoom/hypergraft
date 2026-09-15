use crate::parser::{Control, Document, Part};
use crate::source::Diagnostic;
use std::collections::HashSet;
use syn::ext::IdentExt;
use syn::visit::{self, Visit};

type Names = HashSet<String>;

#[derive(Default, Clone)]
struct Context {
    visible: Names,
    forbidden: Names,
}

struct Patterns(Names);
impl<'ast> Visit<'ast> for Patterns {
    fn visit_pat_ident(&mut self, pattern: &'ast syn::PatIdent) {
        self.0.insert(pattern.ident.unraw().to_string());
        visit::visit_pat_ident(self, pattern);
    }
}

fn bindings(pattern: &syn::Pat) -> Names {
    let mut visitor = Patterns(Names::new());
    visitor.visit_pat(pattern);
    visitor.0
}

struct References<'a> {
    forbidden: &'a Names,
    locals: Names,
    invalid: bool,
}
impl References<'_> {
    fn reference(&mut self, name: &syn::Ident) {
        let name = name.unraw().to_string();
        self.invalid |= self.forbidden.contains(&name) && !self.locals.contains(&name);
    }

    fn format_captures(&mut self, format: &str, named: &Names) {
        let mut chars = format.chars().peekable();
        while let Some(character) = chars.next() {
            if character != '{' {
                continue;
            }
            if chars.peek() == Some(&'{') {
                chars.next();
                continue;
            }
            let field: String = chars
                .by_ref()
                .take_while(|character| *character != '}')
                .collect();
            let (argument, spec) = field.split_once(':').unwrap_or((&field, ""));
            let mut capture = |name: &str| {
                if let Ok(name) = syn::parse_str::<syn::Ident>(name)
                    && !named.contains(&name.unraw().to_string())
                {
                    self.reference(&name);
                }
            };
            capture(argument.trim());
            let mut counts = spec.split('$').peekable();
            while let Some(prefix) = counts.next() {
                if counts.peek().is_some() {
                    capture(
                        prefix
                            .rsplit(|c: char| !rustc_lexer::is_id_continue(c))
                            .next()
                            .unwrap_or("")
                            .trim_start_matches(|c: char| c.is_ascii_digit()),
                    );
                }
            }
        }
    }

    fn opaque_tokens(&mut self, tokens: proc_macro2::TokenStream) {
        // Unknown macro grammars cannot establish provable local bindings.
        for token in tokens {
            match token {
                proc_macro2::TokenTree::Ident(name) => self.reference(&name),
                proc_macro2::TokenTree::Group(group) => self.opaque_tokens(group.stream()),
                _ => {}
            }
        }
    }

    fn condition(&mut self, expression: &syn::Expr) {
        match expression {
            syn::Expr::Let(expression) => {
                self.visit_expr(&expression.expr);
                self.locals.extend(bindings(&expression.pat));
            }
            syn::Expr::Binary(expression) if matches!(expression.op, syn::BinOp::And(_)) => {
                self.condition(&expression.left);
                self.condition(&expression.right);
            }
            _ => self.visit_expr(expression),
        }
    }
}

impl<'ast> Visit<'ast> for References<'_> {
    fn visit_expr_if(&mut self, expression: &'ast syn::ExprIf) {
        let saved = self.locals.clone();
        self.condition(&expression.cond);
        self.visit_block(&expression.then_branch);
        self.locals = saved;
        if let Some((_, branch)) = &expression.else_branch {
            self.visit_expr(branch);
        }
    }

    fn visit_expr_while(&mut self, expression: &'ast syn::ExprWhile) {
        let saved = self.locals.clone();
        self.condition(&expression.cond);
        self.visit_block(&expression.body);
        self.locals = saved;
    }

    fn visit_macro(&mut self, invocation: &'ast syn::Macro) {
        use syn::parse::Parser;
        let name = invocation.path.segments.last().unwrap().ident.to_string();
        if name == "stringify" {
            return;
        }
        let tokens = &invocation.tokens;
        if let Ok(arguments) =
            syn::punctuated::Punctuated::<syn::Expr, syn::Token![,]>::parse_terminated
                .parse2(tokens.clone())
        {
            let format_index = match name.as_str() {
                "format" | "format_args" | "print" | "println" | "eprint" | "eprintln"
                | "panic" => Some(0),
                "write" | "writeln" | "assert" | "debug_assert" => Some(1),
                "assert_eq" | "assert_ne" | "debug_assert_eq" | "debug_assert_ne" => Some(2),
                _ => None,
            };
            let mut named = Names::new();
            for (index, expression) in arguments.iter().enumerate() {
                if format_index.is_some_and(|format| index > format)
                    && let syn::Expr::Assign(assignment) = expression
                    && let syn::Expr::Path(left) = assignment.left.as_ref()
                    && let Some(name) = left.path.get_ident()
                {
                    named.insert(name.unraw().to_string());
                    self.visit_expr(&assignment.right);
                } else {
                    self.visit_expr(expression);
                }
            }
            if let Some(index) = format_index
                && let Some(syn::Expr::Lit(literal)) = arguments.iter().nth(index)
                && let syn::Lit::Str(format) = &literal.lit
            {
                self.format_captures(&format.value(), &named);
            }
        } else if let Ok(expression) = syn::parse2::<syn::ExprRepeat>(quote::quote!([#tokens])) {
            self.visit_expr_repeat(&expression);
        } else if let Ok(block) = syn::parse2::<syn::Block>(quote::quote!({#tokens})) {
            self.visit_block(&block);
        } else {
            self.opaque_tokens(tokens.clone());
        }
    }

    fn visit_expr_path(&mut self, expression: &'ast syn::ExprPath) {
        if expression.qself.is_none()
            && expression.path.leading_colon.is_none()
            && let Some(name) = expression.path.get_ident()
        {
            self.reference(name);
        }
        visit::visit_expr_path(self, expression);
    }

    fn visit_block(&mut self, block: &'ast syn::Block) {
        let saved = self.locals.clone();
        for statement in &block.stmts {
            if let syn::Stmt::Local(local) = statement {
                if let Some(init) = &local.init {
                    self.visit_expr(&init.expr);
                    if let Some((_, diverge)) = &init.diverge {
                        self.visit_expr(diverge);
                    }
                }
                self.locals.extend(bindings(&local.pat));
            } else {
                self.visit_stmt(statement);
            }
        }
        self.locals = saved;
    }

    fn visit_expr_closure(&mut self, expression: &'ast syn::ExprClosure) {
        let saved = self.locals.clone();
        for pattern in &expression.inputs {
            self.locals.extend(bindings(pattern));
        }
        self.visit_expr(&expression.body);
        self.locals = saved;
    }

    fn visit_arm(&mut self, arm: &'ast syn::Arm) {
        let saved = self.locals.clone();
        self.locals.extend(bindings(&arm.pat));
        if let Some((_, guard)) = &arm.guard {
            self.visit_expr(guard);
        }
        self.visit_expr(&arm.body);
        self.locals = saved;
    }

    fn visit_expr_for_loop(&mut self, expression: &'ast syn::ExprForLoop) {
        self.visit_expr(&expression.expr);
        let saved = self.locals.clone();
        self.locals.extend(bindings(&expression.pat));
        self.visit_block(&expression.body);
        self.locals = saved;
    }
}

fn condition_bindings(expression: &syn::Expr) -> Names {
    match expression {
        syn::Expr::Let(expression) => bindings(&expression.pat),
        syn::Expr::Binary(expression) if matches!(expression.op, syn::BinOp::And(_)) => {
            let mut names = condition_bindings(&expression.left);
            names.extend(condition_bindings(&expression.right));
            names
        }
        _ => Names::new(),
    }
}

pub fn validate(path: &str, document: &Document, selected: Option<&str>) -> Result<(), Diagnostic> {
    let mut definitions = Names::new();
    let mut context = Context::default();
    let mut stack = Vec::new();
    for part in &document.parts {
        let (offset, expressions): (_, Vec<&syn::Expr>) = match part {
            Part::Expression {
                offset, expression, ..
            } => (*offset, vec![expression]),
            Part::Render {
                offset,
                expression,
                scope,
                ..
            } => (
                *offset,
                std::iter::once(expression.as_ref())
                    .chain(scope.as_deref())
                    .collect(),
            ),
            Part::Control {
                offset, control, ..
            } => {
                if matches!(control, Control::Else | Control::ElseIf(_)) {
                    context = stack.last().cloned().unwrap();
                }
                (
                    *offset,
                    match control {
                        Control::If(expression) | Control::ElseIf(expression) => vec![expression],
                        Control::For { expression, .. } => vec![expression],
                        Control::Block { inputs, .. } => {
                            inputs.iter().map(|(_, expression)| expression).collect()
                        }
                        _ => vec![],
                    },
                )
            }
            Part::Literal(_) => continue,
        };
        let inspect = |expression: &syn::Expr, context: &Context| {
            let mut references = References {
                forbidden: &context.forbidden,
                locals: Names::new(),
                invalid: false,
            };
            references.condition(expression);
            if references.invalid {
                Err(Diagnostic::new(
                    path,
                    &document.source,
                    offset,
                    "unavailable surrounding local: declare a block input",
                ))
            } else {
                Ok(())
            }
        };
        for expression in expressions {
            inspect(expression, &context)?;
        }
        if let Part::Control { control, .. } = part {
            let introduced = match control {
                Control::If(expression) => {
                    stack.push(context.clone());
                    condition_bindings(expression)
                }
                Control::ElseIf(expression) => condition_bindings(expression),
                Control::For { pattern, .. } => {
                    stack.push(context.clone());
                    bindings(pattern)
                }
                Control::Block { name, inputs } => {
                    if !definitions.insert(name.unraw().to_string()) {
                        return Err(Diagnostic::new(
                            path,
                            &document.source,
                            offset,
                            "duplicate block definition",
                        ));
                    }
                    stack.push(context.clone());
                    context.forbidden.extend(context.visible.drain());
                    inputs
                        .iter()
                        .map(|(name, _)| name.unraw().to_string())
                        .collect()
                }
                Control::EndIf | Control::EndFor | Control::EndBlock => {
                    context = stack.pop().unwrap();
                    Names::new()
                }
                _ => Names::new(),
            };
            for name in introduced {
                context.forbidden.remove(&name);
                context.visible.insert(name);
            }
            if let Control::For { key, .. } = control {
                inspect(key, &context)?;
            }
        }
    }
    if selected.is_some_and(|name| !definitions.contains(name.strip_prefix("r#").unwrap_or(name))) {
        return Err(Diagnostic::new(
            path,
            &document.source,
            0,
            "unknown block selector",
        ));
    }
    Ok(())
}
