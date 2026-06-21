use std::fs;
use std::io::Read;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, State};

use crate::db;
use crate::models::{ComicInfo, PageInfo, ScanResult};
use crate::scanner;

/// Shared application state.
pub struct AppState {
    pub db: Mutex<rusqlite::Connection>,
    pub cache_dir: PathBuf,
}

/// Get the current library path from config.
#[tauri::command]
pub async fn get_library_path(
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let conn = state.db.lock().map_err(|e| format!("Lock error: {}", e))?;
    db::get_config(&conn, "library_path").map_err(|e| format!("DB error: {}", e))
}

/// Set the library path and trigger a full scan.
#[tauri::command]
pub async fn set_library_path(
    path: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ScanResult, String> {
    // Persist the path (lock briefly)
    {
        let conn =
            state.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        db::set_config(&conn, "library_path", &path)
            .map_err(|e| format!("DB error: {}", e))?;
    }

    let base_dir = PathBuf::from(&path);
    if !base_dir.exists() {
        return Err(format!("Directory does not exist: {}", path));
    }
    if !base_dir.is_dir() {
        return Err(format!("Path is not a directory: {}", path));
    }

    scanner::scan_library(&base_dir, &state.db, &state.cache_dir, &app)
}

/// Re-scan the currently configured library directory.
#[tauri::command]
pub async fn scan_library(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ScanResult, String> {
    let library_path: Option<String> = {
        let conn =
            state.db.lock().map_err(|e| format!("Lock error: {}", e))?;
        db::get_config(&conn, "library_path")
            .map_err(|e| format!("DB error: {}", e))?
    };

    let Some(path) = library_path else {
        return Err(
            "No library path set. Please select a directory first."
                .to_string(),
        );
    };

    let base_dir = PathBuf::from(&path);
    if !base_dir.exists() {
        return Err(format!("Directory does not exist: {}", path));
    }

    scanner::scan_library(&base_dir, &state.db, &state.cache_dir, &app)
}

/// Get all comics from the database.
/// Populates `cover_file_path` with the absolute path to the WebP thumbnail.
#[tauri::command]
pub async fn get_comics(
    state: State<'_, AppState>,
) -> Result<Vec<ComicInfo>, String> {
    let conn = state.db.lock().map_err(|e| format!("Lock error: {}", e))?;
    let mut comics =
        db::get_all_comics(&conn).map_err(|e| format!("DB error: {}", e))?;
    let thumbnail_dir = state.cache_dir.join("thumbnails");

    for comic in &mut comics {
        if comic.cover_path.is_some() {
            comic.cover_file_path = Some(
                thumbnail_dir
                    .join(format!("{}.webp", comic.id))
                    .to_string_lossy()
                    .to_string(),
            );
        }
    }

    Ok(comics)
}

/// Get pages for a specific comic.
#[tauri::command]
pub async fn get_comic_pages(
    comic_id: i64,
    state: State<'_, AppState>,
) -> Result<Vec<PageInfo>, String> {
    let conn = state.db.lock().map_err(|e| format!("Lock error: {}", e))?;
    db::get_pages(&conn, comic_id).map_err(|e| format!("DB error: {}", e))
}

// ── File Path Commands (for convertFileSrc on frontend) ──

/// Get the absolute filesystem path to a cached cover thumbnail.
/// The frontend uses `convertFileSrc()` from `@tauri-apps/api/core` to
/// convert this into a webview-loadable asset:// URL.
#[tauri::command]
pub async fn get_cover_file_path(
    comic_id: i64,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let cache_dir = state.cache_dir.clone();
    let thumb_path = cache_dir
        .join("thumbnails")
        .join(format!("{}.webp", comic_id));

    if thumb_path.exists() {
        Ok(thumb_path.to_string_lossy().to_string())
    } else {
        Err(format!("Cover thumbnail not found for comic {}", comic_id))
    }
}

/// Get the absolute filesystem path to a comic page, extracting it from the
/// ZIP to a cache directory on first access. Subsequent calls return the
/// cached file path directly.
#[tauri::command]
pub async fn get_page_file_path(
    comic_id: i64,
    page_idx: i64,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let conn = state.db.lock().map_err(|e| format!("Lock error: {}", e))?;
    let pages_cache_dir = state
        .cache_dir
        .join("pages")
        .join(comic_id.to_string());

    // Check if already extracted
    let cached_path = pages_cache_dir.join(format!("{}.jpg", page_idx));
    if cached_path.exists() {
        return Ok(cached_path.to_string_lossy().to_string());
    }

    // Look up the comic and page
    let comic = db::get_comic_by_id(&conn, comic_id)
        .map_err(|e| format!("DB error: {}", e))?
        .ok_or_else(|| format!("Comic not found: {}", comic_id))?;

    let pages =
        db::get_pages(&conn, comic_id).map_err(|e| format!("DB error: {}", e))?;
    let page = pages
        .get(page_idx as usize)
        .ok_or_else(|| {
            format!("Page {} not found in comic {}", page_idx, comic_id)
        })?;

    // Extract the image from the ZIP
    let zip_file = fs::File::open(&comic.file_path)
        .map_err(|e| format!("Cannot open zip: {}", e))?;
    let mut archive = zip::read::ZipArchive::new(zip_file)
        .map_err(|e| format!("Bad zip: {}", e))?;
    let mut entry = archive
        .by_name(&page.file_name)
        .map_err(|e| {
            format!("Entry '{}' not found: {}", page.file_name, e)
        })?;

    let mut buf = Vec::with_capacity(entry.size() as usize);
    entry
        .read_to_end(&mut buf)
        .map_err(|e| format!("Failed to decompress: {}", e))?;

    // Determine extension from the original filename
    let ext = std::path::Path::new(&page.file_name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("jpg");

    // Write to cache
    fs::create_dir_all(&pages_cache_dir)
        .map_err(|e| format!("Failed to create page cache dir: {}", e))?;
    let cached_path =
        pages_cache_dir.join(format!("{}.{}", page_idx, ext));
    fs::write(&cached_path, &buf)
        .map_err(|e| format!("Failed to write cached page: {}", e))?;

    Ok(cached_path.to_string_lossy().to_string())
}
