mod commands;
mod live;
mod pages;
mod security;
mod state;

use std::path::PathBuf;

use axum::{
    Router,
    body::Bytes,
    extract::State,
    http::{HeaderValue, header},
    middleware,
    response::{IntoResponse, Redirect, Response},
    routing::{get, post},
};
use tokio::net::TcpListener;

use crate::{
    security::{BIND_ADDR, PUBLIC_ORIGIN},
    state::Store,
};

#[derive(Clone)]
struct Assets {
    js: Bytes,
    css: Bytes,
}

#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) store: Store,
    assets: Assets,
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    tracing_subscriber::fmt().init();
    let assets = match load_assets() {
        Ok(assets) => assets,
        Err(error) => {
            eprintln!(
                "Failed to load built assets from dist/. Run `pnpm example:build` first. {error}"
            );
            std::process::exit(1);
        }
    };
    let state = AppState {
        store: Store::seeded(),
        assets,
    };
    let browser = Router::new()
        .route("/tasks", get(pages::tasks).post(commands::create))
        .route("/tasks/{id}", get(pages::task))
        .route("/tasks/{id}/status", post(commands::status))
        .layer(commands::command_body_limit())
        .layer(middleware::from_fn(security::enforce_origin))
        .layer(middleware::from_fn(hypergraft::middleware::classify));
    let assets = Router::new()
        .route("/assets/main.js", get(javascript))
        .route("/assets/style.css", get(stylesheet));
    let app = Router::new()
        .merge(browser)
        .merge(assets)
        .merge(live::service())
        .route("/", get(home))
        .fallback(security::not_found)
        .layer(middleware::from_fn(security::security_headers))
        .with_state(state);
    let listener = TcpListener::bind(BIND_ADDR)
        .await
        .unwrap_or_else(|error| panic!("failed to bind {BIND_ADDR}: {error}"));
    println!("Listening on {PUBLIC_ORIGIN}/tasks");
    axum::serve(listener, app).await.expect("server error");
}

async fn home() -> Redirect {
    Redirect::to("/tasks")
}

async fn javascript(State(state): State<AppState>) -> Response {
    asset_response("text/javascript; charset=utf-8", state.assets.js)
}

async fn stylesheet(State(state): State<AppState>) -> Response {
    asset_response("text/css; charset=utf-8", state.assets.css)
}

fn asset_response(content_type: &'static str, body: Bytes) -> Response {
    let mut response = body.into_response();
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    response
}

fn load_assets() -> std::io::Result<Assets> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("dist");
    Ok(Assets {
        js: Bytes::from(std::fs::read(dir.join("main.js"))?),
        css: Bytes::from(std::fs::read(dir.join("style.css"))?),
    })
}
