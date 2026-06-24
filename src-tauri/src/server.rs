use std::path::PathBuf;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use tower_http::services::{ServeDir, ServeFile};

use crate::commands::DbPool;
use crate::db;

// ── Shared state for the HTTP server ──

struct ShareState {
    db: DbPool,
    cache_root: PathBuf,
}

// ── JSON response types ──

#[derive(Serialize)]
struct ComicEntry {
    id: i64,
    #[serde(rename = "fileName")]
    file_name: String,
    #[serde(rename = "pageCount")]
    page_count: i64,
    #[serde(rename = "coverUrl")]
    cover_url: String,
}

#[derive(Serialize)]
struct PageEntry {
    #[serde(rename = "pageIdx")]
    page_idx: i64,
    #[serde(rename = "fileName")]
    file_name: String,
}

// ── Path params for multi-segment routes ──

#[derive(Deserialize)]
struct PagePath {
    comic_id: i64,
    page_idx: i64,
}

// ── Public entry point ──

pub async fn run(
    db: DbPool,
    cache_root: PathBuf,
    port: u16,
    shutdown: tokio::sync::oneshot::Receiver<()>,
) -> Result<(), String> {
    let state = Arc::new(ShareState { db, cache_root });

    // React build output directory (relative to src-tauri/Cargo.toml)
    let web_dist =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("web-dist");

    // ── Main router ──
    let app = Router::new()
        // API — explicit routes with typed extractors
        .route("/api/comics", get(list_comics))
        .route("/api/comics/{id}/pages", get(list_pages))
        .route("/api/image/cover/{comic_id}", get(serve_cover))
        .route("/api/image/page/{comic_id}/{page_idx}", get(serve_page))
        .route("/api/config/language", get(get_language).post(set_language))
        // Static assets from the React build
        .nest_service("/assets", ServeDir::new(web_dist.join("assets")))
        // favicon / other root-level files
        .route("/vite.svg", get({
            let dist = web_dist.clone();
            move || async move {
                let path = dist.join("vite.svg");
                match tokio::fs::read(&path).await {
                    Ok(bytes) => Response::builder()
                        .header(header::CONTENT_TYPE, "image/svg+xml")
                        .body(Body::from(bytes))
                        .unwrap(),
                    Err(_) => StatusCode::NOT_FOUND.into_response(),
                }
            }
        }))
        // SPA fallback: everything else → index.html
        .fallback_service(ServeFile::new(web_dist.join("index.html")))
        .with_state(state);

    let addr = format!("0.0.0.0:{}", port);
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .map_err(|e| format!("端口 {} 绑定失败: {}", port, e))?;

    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            let _ = shutdown.await;
        })
        .await
        .map_err(|e| format!("HTTP server error: {}", e))?;

    Ok(())
}

// ── Handler Implementations ──

async fn list_comics(
    State(state): State<Arc<ShareState>>,
) -> Result<Response, AppError> {
    let (library_path, comics) = {
        let conn = state.db.get()?;
        let path = db::get_config(&conn, "library_path")
            .map_err(|e| format!("DB error: {}", e))?
            .unwrap_or_default();
        let comics = db::get_all_comics(&conn).map_err(|e| format!("DB error: {}", e))?;
        (path, comics)
    };

    let scoped = crate::commands::library_cache_dir(&state.cache_root, &library_path);

    let entries: Vec<ComicEntry> = comics
        .into_iter()
        .map(|c| ComicEntry {
            id: c.id,
            file_name: c.file_name,
            page_count: c.page_count,
            cover_url: if c.cover_path.is_some() || {
                let thumb_path = scoped
                    .join("thumbnails")
                    .join(format!("{}.webp", c.id));
                thumb_path.exists()
            } {
                format!("/api/image/cover/{}", c.id)
            } else {
                String::new()
            },
        })
        .collect();

    Ok(Json(entries).into_response())
}

async fn list_pages(
    State(state): State<Arc<ShareState>>,
    Path(id): Path<i64>,
) -> Result<Response, AppError> {
    let conn = state.db.get()?;
    let pages = db::get_pages(&conn, id)
        .map_err(|e| format!("DB error: {}", e))?;

    let entries: Vec<PageEntry> = pages
        .into_iter()
        .map(|p| PageEntry {
            page_idx: p.page_idx,
            file_name: p.file_name,
        })
        .collect();

    Ok(Json(entries).into_response())
}

async fn serve_cover(
    State(state): State<Arc<ShareState>>,
    Path(comic_id): Path<i64>,
) -> Result<Response, AppError> {
    let library_path = {
        let conn = state.db.get()?;
        db::get_config(&conn, "library_path")
            .map_err(|e| format!("DB error: {}", e))?
            .unwrap_or_default()
    };

    if library_path.is_empty() {
        return Err(AppError::NotFoundWithDetail(
            "未设置漫画库目录".to_string(),
        ));
    }

    let scoped = crate::commands::library_cache_dir(&state.cache_root, &library_path);
    let thumb_dir = scoped.join("thumbnails");
    let thumb_path = thumb_dir.join(format!("{}.webp", comic_id));

    match tokio::fs::read(&thumb_path).await {
        Ok(bytes) => {
            Ok(Response::builder()
                .header(header::CONTENT_TYPE, "image/webp")
                .header(header::CACHE_CONTROL, "public, max-age=3600")
                .body(Body::from(bytes))
                .unwrap())
        }
        Err(_e) => {
            Err(AppError::NotFoundWithDetail(format!(
                "Cover file not found: {}",
                thumb_path.display()
            )))
        }
    }
}

async fn serve_page(
    State(state): State<Arc<ShareState>>,
    Path(p): Path<PagePath>,
) -> Result<Response, AppError> {
    let comic_id = p.comic_id;
    let page_idx = p.page_idx;
    let (library_path, comic_path, page_file_name) = {
        let conn = state.db.get()?;

        let library_path = db::get_config(&conn, "library_path")
            .map_err(|e| format!("DB error: {}", e))?
            .unwrap_or_default();

        let scoped = crate::commands::library_cache_dir(&state.cache_root, &library_path);
        let pages_dir = scoped.join("pages").join(comic_id.to_string());

        for ext in crate::thumbnail::IMAGE_EXTENSIONS {
            let cached = pages_dir.join(format!("{}.{}", page_idx, ext));
            if cached.exists() {
                let content_type = mime_from_ext(ext);
                let bytes = tokio::fs::read(&cached)
                    .await
                    .map_err(|e| format!("IO error: {}", e))?;
                return Ok(Response::builder()
                    .header(header::CONTENT_TYPE, content_type)
                    .header(header::CACHE_CONTROL, "public, max-age=86400")
                    .body(Body::from(bytes))
                    .unwrap());
            }
        }

        let comic = db::get_comic_by_id(&conn, comic_id)
            .map_err(|e| format!("DB error: {}", e))?
            .ok_or_else(|| format!("Comic {} not found", comic_id))?;

        let pages = db::get_pages(&conn, comic_id)
            .map_err(|e| format!("DB error: {}", e))?;

        let page = pages
            .get(page_idx as usize)
            .ok_or_else(|| {
                format!(
                    "Page {} not found in comic {} ({} pages total)",
                    page_idx,
                    comic_id,
                    pages.len()
                )
            })?;

        (library_path, comic.file_path, page.file_name.clone())
    };

    let scoped = crate::commands::library_cache_dir(&state.cache_root, &library_path);
    let pages_dir = scoped.join("pages").join(comic_id.to_string());

    let (cached_path, content_type) = tokio::task::spawn_blocking(move || {
        use std::fs;
        use std::io::Read;
        use std::path::Path;

        let zip_file = fs::File::open(&comic_path)
            .map_err(|e| format!("Cannot open zip: {}", e))?;
        let mut archive = zip::read::ZipArchive::new(zip_file)
            .map_err(|e| format!("Bad zip: {}", e))?;
        let mut entry = archive
            .by_name(&page_file_name)
            .map_err(|e| format!("Entry '{}' not found: {}", page_file_name, e))?;

        let mut buf = Vec::with_capacity(entry.size() as usize);
        entry
            .read_to_end(&mut buf)
            .map_err(|e| format!("Decompress: {}", e))?;

        let ext = Path::new(&page_file_name)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("jpg");

        fs::create_dir_all(&pages_dir).map_err(|e| format!("Mkdir: {}", e))?;
        let cached = pages_dir.join(format!("{}.{}", page_idx, ext));
        fs::write(&cached, &buf).map_err(|e| format!("Write: {}", e))?;

        Ok::<_, String>((cached, mime_from_ext(ext)))
    })
    .await
    .map_err(|e| format!("Join error: {}", e))??;

    let bytes = tokio::fs::read(&cached_path)
        .await
        .map_err(|e| format!("IO error: {}", e))?;

    Ok(Response::builder()
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CACHE_CONTROL, "public, max-age=86400")
        .body(Body::from(bytes))
        .unwrap())
}

// ── Language Config API ──

#[derive(Deserialize)]
struct SetLanguageRequest {
    language: String,
}

#[derive(Serialize)]
struct LanguageResponse {
    language: String,
}

async fn get_language(
    State(state): State<Arc<ShareState>>,
) -> Result<Response, AppError> {
    let conn = state.db.get()?;
    let lang = db::get_config(&conn, "language")
        .map_err(|e| format!("DB error: {}", e))?
        .unwrap_or_else(|| "zh".to_string());
    Ok(Json(LanguageResponse { language: lang }).into_response())
}

async fn set_language(
    State(state): State<Arc<ShareState>>,
    Json(body): Json<SetLanguageRequest>,
) -> Result<Response, AppError> {
    if body.language != "zh" && body.language != "en" {
        return Err(AppError::Message(format!(
            "Unsupported language: {}. Supported: zh, en",
            body.language
        )));
    }

    let conn = state.db.get()?;
    db::set_config(&conn, "language", &body.language)
        .map_err(|e| format!("DB error: {}", e))?;

    Ok(Json(serde_json::json!({"ok": true})).into_response())
}

// ── Helpers ──

fn mime_from_ext(ext: &str) -> String {
    mime_guess::from_ext(ext)
        .first_or_octet_stream()
        .essence_str()
        .to_string()
}

// ── Error type ──

enum AppError {
    NotFoundWithDetail(String),
    Message(String),
}

impl From<String> for AppError {
    fn from(s: String) -> Self {
        AppError::Message(s)
    }
}

impl From<r2d2::Error> for AppError {
    fn from(e: r2d2::Error) -> Self {
        AppError::Message(format!("Pool error: {}", e))
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        match self {
            AppError::NotFoundWithDetail(detail) => {
                let body = serde_json::json!({
                    "error": "Not Found",
                    "detail": detail,
                });
                (
                    StatusCode::NOT_FOUND,
                    [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
                    body.to_string(),
                )
                    .into_response()
            }
            AppError::Message(msg) => {
                let body = serde_json::json!({
                    "error": "Internal Server Error",
                    "detail": msg,
                });
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
                    body.to_string(),
                )
                    .into_response()
            }
        }
    }
}
