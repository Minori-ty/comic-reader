use std::path::PathBuf;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::State;
use axum::http::{header, Request, StatusCode};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::get;
use axum::Router;
use serde::Serialize;
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

// ── Public entry point ──

pub async fn run(
    db: DbPool,
    cache_root: PathBuf,
    port: u16,
    shutdown: tokio::sync::oneshot::Receiver<()>,
) -> Result<(), String> {
    let state = Arc::new(ShareState { db, cache_root });

    // React build output directory (relative to src-tauri/Cargo.toml)
    let mobile_dist =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("mobile-dist");

    eprintln!(
        "[server] mobile-dist path: {} (exists: {})",
        mobile_dist.display(),
        mobile_dist.exists()
    );

    // ── API router: all /api/* requests are handled by the dispatcher ──
    let api_router = Router::new()
        .fallback(api_dispatcher)
        .with_state(state);

    // ── Main router ──
    let app = Router::new()
        // API routes take priority
        .nest("/api", api_router)
        // Static assets from the React build
        .nest_service("/assets", ServeDir::new(mobile_dist.join("assets")))
        // favicon / other root-level files
        .route("/vite.svg", get({
            let dist = mobile_dist.clone();
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
        .fallback_service(ServeFile::new(mobile_dist.join("index.html")));

    let addr = format!("0.0.0.0:{}", port);
    eprintln!("[server] Attempting to bind to {}", addr);
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .map_err(|e| format!("端口 {} 绑定失败: {}", port, e))?;
    eprintln!("[server] Bound successfully, starting serve on {}", addr);

    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            let _ = shutdown.await;
            eprintln!("[server] Shutdown signal received");
        })
        .await
        .map_err(|e| format!("HTTP server error: {}", e))?;

    Ok(())
}

// ── API Dispatcher ──

/// 通配路由：手动解析路径并分发到对应的处理逻辑。
async fn api_dispatcher(
    State(state): State<Arc<ShareState>>,
    req: Request<Body>,
) -> Result<Response, AppError> {
    let full_path = req.uri().path().to_string();
    let path = full_path
        .strip_prefix("/api/")
        .unwrap_or_else(|| full_path.strip_prefix("/api").unwrap_or(&full_path));
    eprintln!("[server] ==> api_dispatcher path='{}'", path);

    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();

    match segments.as_slice() {
        ["comics"] => list_comics_impl(state).await,
        ["comics", id, "pages"] => list_pages_impl(state, id).await,
        ["image", "cover", comic_id] => serve_cover_impl(state, comic_id).await,
        ["image", "page", comic_id, page_idx] => serve_page_impl(state, comic_id, page_idx).await,
        _ => {
            eprintln!("[server] api_dispatcher: no match for {:?}", segments);
            Err(AppError::NotFoundWithDetail(format!(
                "Unknown API path: /api/{}",
                path
            )))
        }
    }
}

// ── Handler Implementations ──

async fn list_comics_impl(state: Arc<ShareState>) -> Result<Response, AppError> {
    let (library_path, comics) = {
        let conn = state.db.get()?;
        let path = db::get_config(&conn, "library_path")
            .map_err(|e| format!("DB error: {}", e))?
            .unwrap_or_default();
        let comics = db::get_all_comics(&conn).map_err(|e| format!("DB error: {}", e))?;
        (path, comics)
    };

    eprintln!(
        "[server] list_comics: library_path='{}' comics_count={}",
        library_path,
        comics.len()
    );

    let scoped = library_cache_dir(&state.cache_root, &library_path);

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

async fn list_pages_impl(
    state: Arc<ShareState>,
    id_str: &str,
) -> Result<Response, AppError> {
    let comic_id: i64 = id_str
        .parse()
        .map_err(|_| AppError::NotFoundWithDetail(format!("Invalid comic id: {}", id_str)))?;

    let conn = state.db.get()?;
    let pages = db::get_pages(&conn, comic_id)
        .map_err(|e| format!("DB error: {}", e))?;

    let entries: Vec<PageEntry> = pages
        .into_iter()
        .map(|p| PageEntry {
            page_idx: p.page_idx,
            file_name: p.file_name,
        })
        .collect();

    eprintln!("[server] list_pages: returning {} pages", entries.len());
    Ok(Json(entries).into_response())
}

async fn serve_cover_impl(
    state: Arc<ShareState>,
    comic_id_str: &str,
) -> Result<Response, AppError> {
    let comic_id: i64 = comic_id_str
        .parse()
        .map_err(|_| AppError::NotFoundWithDetail(format!("Invalid comic id: {}", comic_id_str)))?;

    let library_path = {
        let conn = state.db.get()?;
        db::get_config(&conn, "library_path")
            .map_err(|e| format!("DB error: {}", e))?
            .unwrap_or_default()
    };

    eprintln!(
        "[server] serve_cover: library_path='{}' comic_id={}",
        library_path, comic_id
    );

    if library_path.is_empty() {
        return Err(AppError::NotFoundWithDetail(
            "未设置漫画库目录".to_string(),
        ));
    }

    let scoped = library_cache_dir(&state.cache_root, &library_path);
    let thumb_dir = scoped.join("thumbnails");
    let thumb_path = thumb_dir.join(format!("{}.webp", comic_id));

    match tokio::fs::read(&thumb_path).await {
        Ok(bytes) => {
            eprintln!("[server] serve_cover: FOUND {} bytes", bytes.len());
            Ok(Response::builder()
                .header(header::CONTENT_TYPE, "image/webp")
                .header(header::CACHE_CONTROL, "public, max-age=3600")
                .body(Body::from(bytes))
                .unwrap())
        }
        Err(e) => {
            eprintln!(
                "[cover] MISS comic_id={} library_path='{}' thumb_path='{}' err={}",
                comic_id,
                library_path,
                thumb_path.display(),
                e
            );
            Err(AppError::NotFoundWithDetail(format!(
                "Cover file not found: {}",
                thumb_path.display()
            )))
        }
    }
}

async fn serve_page_impl(
    state: Arc<ShareState>,
    comic_id_str: &str,
    page_idx_str: &str,
) -> Result<Response, AppError> {
    let comic_id: i64 = comic_id_str
        .parse()
        .map_err(|_| AppError::NotFoundWithDetail(format!("Invalid comic id: {}", comic_id_str)))?;
    let page_idx: i64 = page_idx_str
        .parse()
        .map_err(|_| AppError::NotFoundWithDetail(format!("Invalid page idx: {}", page_idx_str)))?;

    let (library_path, comic_path, page_file_name) = {
        let conn = state.db.get()?;

        let library_path = db::get_config(&conn, "library_path")
            .map_err(|e| format!("DB error: {}", e))?
            .unwrap_or_default();

        let scoped = library_cache_dir(&state.cache_root, &library_path);
        let pages_dir = scoped.join("pages").join(comic_id.to_string());

        for ext in &["jpg", "jpeg", "png", "webp", "bmp", "gif"] {
            let cached = pages_dir.join(format!("{}.{}", page_idx, ext));
            if cached.exists() {
                eprintln!("[server] serve_page: disk cache HIT {}", cached.display());
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

    eprintln!(
        "[server] serve_page: extracting ZIP path='{}' entry='{}'",
        comic_path, page_file_name
    );

    let scoped = library_cache_dir(&state.cache_root, &library_path);
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

    eprintln!(
        "[server] serve_page: extracted {} bytes to {}",
        bytes.len(),
        cached_path.display()
    );

    Ok(Response::builder()
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CACHE_CONTROL, "public, max-age=86400")
        .body(Body::from(bytes))
        .unwrap())
}

// ── Helpers ──

fn library_cache_dir(cache_root: &std::path::Path, library_path: &str) -> PathBuf {
    let hash = blake3::hash(library_path.as_bytes()).to_hex();
    cache_root.join(&hash[..16])
}

fn mime_from_ext(ext: &str) -> &'static str {
    match ext {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "gif" => "image/gif",
        _ => "image/jpeg",
    }
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
                eprintln!("[server] ERROR 500: {}", msg);
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
