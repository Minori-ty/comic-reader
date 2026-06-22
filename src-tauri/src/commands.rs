use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, State};

use crate::db;
use crate::models::{AppPaths, CacheSizes, ClearCacheResult, ComicInfo, PageInfo, ScanResult};
use crate::scanner;

/// r2d2 connection pool type specialised for SQLite.
pub type DbPool = r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>;

/// Shared application state.
pub struct AppState {
    pub db: DbPool,
    /// Root cache directory: `{app_data}/cache/`.
    /// Scoped per-library subdirectories are created inside this.
    pub cache_root: PathBuf,
}

/// Compute a library-scoped cache directory from the library path.
/// Uses a blake3 hash so the directory name is filesystem-safe and stable.
fn library_cache_dir(cache_root: &Path, library_path: &str) -> PathBuf {
    let hash = blake3::hash(library_path.as_bytes()).to_hex();
    // First 16 hex chars (64 bits) are more than enough to avoid collisions
    cache_root.join(&hash[..16])
}

/// Get the current library path from config.
#[tauri::command]
pub async fn get_library_path(
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let conn = state.db.get().map_err(|e| format!("Pool error: {}", e))?;
    db::get_config(&conn, "library_path").map_err(|e| format!("DB error: {}", e))
}

/// Return all application directory paths for the currently-selected library.
#[tauri::command]
pub async fn get_app_paths(
    state: State<'_, AppState>,
) -> Result<AppPaths, String> {
    let library_path = {
        let conn = state.db.get().map_err(|e| format!("Pool error: {}", e))?;
        db::get_config(&conn, "library_path")
            .map_err(|e| format!("DB error: {}", e))?
            .unwrap_or_default()
    };

    let app_data_dir = state
        .cache_root
        .parent()
        .ok_or_else(|| "Cannot determine app data dir".to_string())?
        .to_path_buf();

    let scoped = library_cache_dir(&state.cache_root, &library_path);

    Ok(AppPaths {
        app_data_dir: app_data_dir.to_string_lossy().to_string(),
        db_path: app_data_dir.join("comics.db").to_string_lossy().to_string(),
        thumbnails_dir: scoped.join("thumbnails").to_string_lossy().to_string(),
        pages_cache_dir: scoped.join("pages").to_string_lossy().to_string(),
    })
}

/// Return the disk usage of the current library's cache directories.
#[tauri::command]
pub async fn get_cache_sizes(
    state: State<'_, AppState>,
) -> Result<CacheSizes, String> {
    let library_path = {
        let conn = state.db.get().map_err(|e| format!("Pool error: {}", e))?;
        db::get_config(&conn, "library_path")
            .map_err(|e| format!("DB error: {}", e))?
            .unwrap_or_default()
    };

    let scoped = library_cache_dir(&state.cache_root, &library_path);
    let thumb_dir = scoped.join("thumbnails");
    let pages_dir = scoped.join("pages");

    let (thumb_bytes, thumb_display) = dir_size(&thumb_dir);
    let (pages_bytes, pages_display) = dir_size(&pages_dir);
    let total_bytes = thumb_bytes + pages_bytes;

    Ok(CacheSizes {
        thumbnails_size: thumb_display,
        thumbnails_bytes: thumb_bytes,
        pages_size: pages_display,
        pages_bytes,
        total_size: format_bytes(total_bytes),
        total_bytes,
    })
}

/// Set the library path and trigger a full scan.
#[tauri::command]
pub async fn set_library_path(
    path: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ScanResult, String> {
    // Persist the path
    {
        let conn = state.db.get().map_err(|e| format!("Pool error: {}", e))?;
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

    let scoped = library_cache_dir(&state.cache_root, &path);
    scanner::scan_library(&base_dir, &state.db, &scoped, &app)
}

/// Re-scan the currently configured library directory.
#[tauri::command]
pub async fn scan_library(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ScanResult, String> {
    let library_path: Option<String> = {
        let conn = state.db.get().map_err(|e| format!("Pool error: {}", e))?;
        db::get_config(&conn, "library_path").map_err(|e| format!("DB error: {}", e))?
    };

    let Some(path) = library_path else {
        return Err("No library path set. Please select a directory first.".to_string());
    };

    let base_dir = PathBuf::from(&path);
    if !base_dir.exists() {
        return Err(format!("Directory does not exist: {}", path));
    }

    let scoped = library_cache_dir(&state.cache_root, &path);
    scanner::scan_library(&base_dir, &state.db, &scoped, &app)
}

/// Get all comics from the database.
/// Populates `cover_file_path` with the absolute path to the WebP thumbnail
/// within the current library's scoped cache directory.
#[tauri::command]
pub async fn get_comics(
    state: State<'_, AppState>,
) -> Result<Vec<ComicInfo>, String> {
    let (library_path, mut comics) = {
        let conn = state.db.get().map_err(|e| format!("Pool error: {}", e))?;
        let path = db::get_config(&conn, "library_path")
            .map_err(|e| format!("DB error: {}", e))?
            .unwrap_or_default();
        let comics = db::get_all_comics(&conn).map_err(|e| format!("DB error: {}", e))?;
        (path, comics)
    };

    let scoped = library_cache_dir(&state.cache_root, &library_path);
    let thumbnail_dir = scoped.join("thumbnails");

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

/// Open the system file explorer and select the given file.
#[tauri::command]
pub async fn open_file_location(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg("/select,")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open explorer: {}", e))?;
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open Finder: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        let parent = std::path::Path::new(&path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| path.clone());
        std::process::Command::new("xdg-open")
            .arg(&parent)
            .spawn()
            .map_err(|e| format!("Failed to open file manager: {}", e))?;
    }

    Ok(())
}

/// Get pages for a specific comic.
#[tauri::command]
pub async fn get_comic_pages(
    comic_id: i64,
    state: State<'_, AppState>,
) -> Result<Vec<PageInfo>, String> {
    let conn = state.db.get().map_err(|e| format!("Pool error: {}", e))?;
    db::get_pages(&conn, comic_id).map_err(|e| format!("DB error: {}", e))
}

/// Delete a comic from the database and its cached files.
/// When `delete_local_file` is true, also removes the ZIP/CBZ from disk.
#[tauri::command]
pub async fn delete_comic(
    comic_id: i64,
    delete_local_file: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let (file_path, _library_path, cache_thumb_path, cache_pages_dir) = {
        let conn = state.db.get().map_err(|e| format!("Pool error: {}", e))?;

        let comic = db::get_comic_by_id(&conn, comic_id)
            .map_err(|e| format!("DB error: {}", e))?
            .ok_or_else(|| format!("Comic not found: {}", comic_id))?;

        let lib_path = db::get_config(&conn, "library_path")
            .map_err(|e| format!("DB error: {}", e))?
            .unwrap_or_default();

        db::delete_comic(&conn, comic_id)
            .map_err(|e| format!("DB delete error: {}", e))?;

        let scoped = library_cache_dir(&state.cache_root, &lib_path);

        let thumb = scoped
            .join("thumbnails")
            .join(format!("{}.webp", comic_id));
        let pages_dir = scoped.join("pages").join(comic_id.to_string());

        (comic.file_path, lib_path, thumb, pages_dir)
    };

    if cache_thumb_path.exists() {
        let _ = fs::remove_file(&cache_thumb_path);
    }
    if cache_pages_dir.exists() {
        let _ = fs::remove_dir_all(&cache_pages_dir);
    }

    if delete_local_file {
        let zip = PathBuf::from(&file_path);
        if zip.exists() {
            fs::remove_file(&zip)
                .map_err(|e| format!("Failed to delete file '{}': {}", file_path, e))?;
        }
    }

    Ok(())
}

/// Clear only the thumbnail cache for the current library.
/// Resets cover_path in DB so thumbnails will be regenerated on next scan.
#[tauri::command]
pub async fn clear_thumbnails_cache(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ClearCacheResult, String> {
    let library_path = {
        let conn = state.db.get().map_err(|e| format!("Pool error: {}", e))?;
        db::get_config(&conn, "library_path")
            .map_err(|e| format!("DB error: {}", e))?
            .unwrap_or_default()
    };

    let scoped = library_cache_dir(&state.cache_root, &library_path);
    let thumb_dir = scoped.join("thumbnails");

    if thumb_dir.exists() {
        fs::remove_dir_all(&thumb_dir)
            .map_err(|e| format!("Failed to clear thumbnails: {}", e))?;
    }

    // Reset cover_path in DB so covers get regenerated
    if !library_path.is_empty() {
        let conn = state.db.get().map_err(|e| format!("Pool error: {}", e))?;
        let _ = db::clear_cover_paths_by_prefix(&conn, &library_path)
            .map_err(|e| format!("DB error: {}", e))?;
    }

    let result = ClearCacheResult {
        cleared_path: thumb_dir.to_string_lossy().to_string(),
    };
    let _ = app.emit("cache-cleared", &result);
    Ok(result)
}

/// Clear only the page image cache for the current library.
/// DB metadata is kept; pages will be re-extracted on demand.
#[tauri::command]
pub async fn clear_pages_cache(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ClearCacheResult, String> {
    let library_path = {
        let conn = state.db.get().map_err(|e| format!("Pool error: {}", e))?;
        db::get_config(&conn, "library_path")
            .map_err(|e| format!("DB error: {}", e))?
            .unwrap_or_default()
    };

    let scoped = library_cache_dir(&state.cache_root, &library_path);
    let pages_dir = scoped.join("pages");

    if pages_dir.exists() {
        fs::remove_dir_all(&pages_dir)
            .map_err(|e| format!("Failed to clear pages cache: {}", e))?;
    }

    let result = ClearCacheResult {
        cleared_path: pages_dir.to_string_lossy().to_string(),
    };
    let _ = app.emit("cache-cleared", &result);
    Ok(result)
}

/// Clear cached data for the **current** library and remove its comics from DB.
#[tauri::command]
pub async fn clear_current_cache(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ClearCacheResult, String> {
    let library_path = {
        let conn = state.db.get().map_err(|e| format!("Pool error: {}", e))?;
        db::get_config(&conn, "library_path")
            .map_err(|e| format!("DB error: {}", e))?
            .unwrap_or_default()
    };

    let scoped = library_cache_dir(&state.cache_root, &library_path);

    // Delete cache files
    if scoped.exists() {
        fs::remove_dir_all(&scoped)
            .map_err(|e| format!("Failed to clear cache: {}", e))?;
    }

    // Also delete DB records whose file_path starts with the library path
    if !library_path.is_empty() {
        let conn = state.db.get().map_err(|e| format!("Pool error: {}", e))?;
        db::delete_comics_by_prefix(&conn, &library_path)
            .map_err(|e| format!("DB error: {}", e))?;
    }

    let result = ClearCacheResult {
        cleared_path: scoped.to_string_lossy().to_string(),
    };
    let _ = app.emit("cache-cleared", &result);
    Ok(result)
}

/// Clear **all** cached data and wipe the entire database.
#[tauri::command]
pub async fn clear_all_cache(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ClearCacheResult, String> {
    // Delete all cache files
    if state.cache_root.exists() {
        fs::remove_dir_all(&*state.cache_root)
            .map_err(|e| format!("Failed to clear all cache: {}", e))?;
        fs::create_dir_all(&*state.cache_root)
            .map_err(|e| format!("Failed to recreate cache root: {}", e))?;
    }

    // Wipe all comics and pages from the database
    {
        let conn = state.db.get().map_err(|e| format!("Pool error: {}", e))?;
        conn.execute_batch(
            "DELETE FROM comic_pages; DELETE FROM comics;"
        ).map_err(|e| format!("DB error: {}", e))?;
    }

    let result = ClearCacheResult {
        cleared_path: state.cache_root.to_string_lossy().to_string(),
    };
    let _ = app.emit("cache-cleared", &result);
    Ok(result)
}

// ── File Path Commands (for convertFileSrc on frontend) ──

/// Get the absolute filesystem path to a cached cover thumbnail.
#[tauri::command]
pub async fn get_cover_file_path(
    comic_id: i64,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let library_path = {
        let conn = state.db.get().map_err(|e| format!("Pool error: {}", e))?;
        db::get_config(&conn, "library_path")
            .map_err(|e| format!("DB error: {}", e))?
            .unwrap_or_default()
    };

    let scoped = library_cache_dir(&state.cache_root, &library_path);
    let thumb_path = scoped
        .join("thumbnails")
        .join(format!("{}.webp", comic_id));

    if thumb_path.exists() {
        Ok(thumb_path.to_string_lossy().to_string())
    } else {
        Err(format!("Cover thumbnail not found for comic {}", comic_id))
    }
}

/// Get the absolute filesystem path to a comic page, extracting it from the
/// ZIP to a cache directory on first access.
///
/// **IMPORTANT:** DB queries and ZIP extraction are now separated — the pool
/// connection is released *before* the slow ZIP decompression so that other
/// commands (library browsing, search, etc.) are never blocked.
#[tauri::command]
pub async fn get_page_file_path(
    comic_id: i64,
    page_idx: i64,
    state: State<'_, AppState>,
) -> Result<String, String> {
    // ── Phase 1: DB lookups (hold pool connection briefly) ──
    let (library_path, comic_path, page_file_name) = {
        let conn = state.db.get().map_err(|e| format!("Pool error: {}", e))?;

        let library_path = db::get_config(&conn, "library_path")
            .map_err(|e| format!("DB error: {}", e))?
            .unwrap_or_default();

        let scoped = library_cache_dir(&state.cache_root, &library_path);
        let pages_cache_dir = scoped.join("pages").join(comic_id.to_string());

        // Check if already extracted
        for ext in &["jpg", "jpeg", "png", "webp", "bmp", "gif"] {
            let path = pages_cache_dir.join(format!("{}.{}", page_idx, ext));
            if path.exists() {
                return Ok(path.to_string_lossy().to_string());
            }
        }

        // Look up the comic and page
        let comic = db::get_comic_by_id(&conn, comic_id)
            .map_err(|e| format!("DB error: {}", e))?
            .ok_or_else(|| format!("Comic not found: {}", comic_id))?;

        let pages = db::get_pages(&conn, comic_id)
            .map_err(|e| format!("DB error: {}", e))?;

        let page = pages
            .get(page_idx as usize)
            .ok_or_else(|| format!("Page {} not found in comic {}", page_idx, comic_id))?;

        (
            library_path,
            comic.file_path,
            page.file_name.clone(),
        )
    }; // ← pool connection released here, before ZIP I/O

    // ── Phase 2: ZIP extraction (no pool connection held) ──
    let scoped = library_cache_dir(&state.cache_root, &library_path);
    let pages_cache_dir = scoped.join("pages").join(comic_id.to_string());

    let zip_file =
        fs::File::open(&comic_path).map_err(|e| format!("Cannot open zip: {}", e))?;
    let mut archive =
        zip::read::ZipArchive::new(zip_file).map_err(|e| format!("Bad zip: {}", e))?;
    let mut entry = archive
        .by_name(&page_file_name)
        .map_err(|e| format!("Entry '{}' not found: {}", page_file_name, e))?;

    let mut buf = Vec::with_capacity(entry.size() as usize);
    entry
        .read_to_end(&mut buf)
        .map_err(|e| format!("Failed to decompress: {}", e))?;

    let ext = std::path::Path::new(&page_file_name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("jpg");

    fs::create_dir_all(&pages_cache_dir)
        .map_err(|e| format!("Failed to create page cache dir: {}", e))?;
    let cached_path = pages_cache_dir.join(format!("{}.{}", page_idx, ext));
    fs::write(&cached_path, &buf)
        .map_err(|e| format!("Failed to write cached page: {}", e))?;

    Ok(cached_path.to_string_lossy().to_string())
}

// ── Helpers ────────────────────────────────────────────────────────────

/// Recursively compute the total size of a directory in bytes.
/// Returns `(bytes, human_readable_string)`.
fn dir_size(path: &Path) -> (u64, String) {
    if !path.exists() {
        return (0, "0 B".to_string());
    }

    let total: u64 = walkdir::WalkDir::new(path)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .map(|e| e.metadata().map(|m| m.len()).unwrap_or(0))
        .sum();

    (total, format_bytes(total))
}

/// Format a byte count into a human-readable string.
fn format_bytes(bytes: u64) -> String {
    const UNITS: &[&str] = &["B", "KB", "MB", "GB", "TB"];
    let mut size = bytes as f64;
    let mut unit_idx = 0;
    while size >= 1024.0 && unit_idx < UNITS.len() - 1 {
        size /= 1024.0;
        unit_idx += 1;
    }
    if unit_idx == 0 {
        format!("{} B", bytes)
    } else {
        format!("{:.2} {}", size, UNITS[unit_idx])
    }
}
