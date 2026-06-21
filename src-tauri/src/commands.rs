use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

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
pub async fn get_library_path(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let conn = state.db.lock().map_err(|e| format!("Lock error: {}", e))?;
    db::get_config(&conn, "library_path").map_err(|e| format!("DB error: {}", e))
}

/// Set the library path and trigger a scan.
#[tauri::command]
pub async fn set_library_path(
    path: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ScanResult, String> {
    let conn = state.db.lock().map_err(|e| format!("Lock error: {}", e))?;
    db::set_config(&conn, "library_path", &path).map_err(|e| format!("DB error: {}", e))?;

    let base_dir = PathBuf::from(&path);
    if !base_dir.exists() {
        return Err(format!("Directory does not exist: {}", path));
    }
    if !base_dir.is_dir() {
        return Err(format!("Path is not a directory: {}", path));
    }

    let result = scanner::scan_library(&base_dir, &conn, &state.cache_dir)?;

    // Emit scan-complete event so frontend can refresh
    let _ = app.emit("scan-complete", &result);

    Ok(result)
}

/// Scan the library directory (re-scan).
#[tauri::command]
pub async fn scan_library(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ScanResult, String> {
    let conn = state.db.lock().map_err(|e| format!("Lock error: {}", e))?;

    let library_path: Option<String> = db::get_config(&conn, "library_path")
        .map_err(|e| format!("DB error: {}", e))?;

    let Some(path) = library_path else {
        return Err("No library path set. Please select a directory first.".to_string());
    };

    let base_dir = PathBuf::from(&path);
    if !base_dir.exists() {
        return Err(format!("Directory does not exist: {}", path));
    }

    let result = scanner::scan_library(&base_dir, &conn, &state.cache_dir)?;

    let _ = app.emit("scan-complete", &result);

    Ok(result)
}

/// Get all comics from the database.
#[tauri::command]
pub async fn get_comics(state: State<'_, AppState>) -> Result<Vec<ComicInfo>, String> {
    let conn = state.db.lock().map_err(|e| format!("Lock error: {}", e))?;
    db::get_all_comics(&conn).map_err(|e| format!("DB error: {}", e))
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

/// Get the path to a cached thumbnail.
#[tauri::command]
pub async fn get_thumbnail_path(
    comic_id: i64,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let conn = state.db.lock().map_err(|e| format!("Lock error: {}", e))?;
    let comic = db::get_comic_by_id(&conn, comic_id).map_err(|e| format!("DB error: {}", e))?;
    Ok(comic.and_then(|c| c.cover_path))
}
