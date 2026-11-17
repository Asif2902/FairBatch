use std::net::SocketAddr;

use fairbatch_backend::{
    api::{build_router, build_shared_engine_with_manifest},
    chain::load_dotenv_if_present,
};
use tracing_subscriber::EnvFilter;

fn main() {
    // Load `.env` on the single main thread before initializing the multi-threaded Tokio runtime.
    let loaded_env_path = load_dotenv_if_present();

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    if let Some(path) = loaded_env_path {
        tracing::info!("Loaded environment configuration from {}", path.display());
    }

    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("failed to build Tokio runtime");

    rt.block_on(run_server());
}

async fn run_server() {
    let host = std::env::var("HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(3001);

    let addr: SocketAddr = format!("{host}:{port}")
        .parse()
        .unwrap_or_else(|_| SocketAddr::from(([127, 0, 0, 1], port)));

    let shared_engine = build_shared_engine_with_manifest();
    {
        let guard = shared_engine.read().await;
        let health = guard.chain.build_health_response();
        tracing::info!(
            "FairBatch Solver Engine starting on http://{} [mode={}, chain_id={}, fe_artifacts={}]",
            addr,
            health.execution_mode,
            health.chain_id,
            health.fe_artifacts.len()
        );
    }

    let app = build_router(shared_engine);
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("failed to bind TCP listener");

    axum::serve(listener, app)
        .await
        .expect("axum server terminated unexpectedly");
}
