use rayon::prelude::*;
use rusqlite::Connection;
use std::collections::HashSet;
use std::fs;
use std::io::{Read, Seek};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::Emitter;
use walkdir::WalkDir;

use crate::db;
use crate::models::ComicInfo;
use crate::models::ScanResult;
use crate::thumbnail::{self, IMAGE_EXTENSIONS};

/// File extensions to scan for.
const COMIC_EXTENSIONS: &[&str] = &["zip", "cbz"];

/// A discovered file ready for indexing.
struct FileEntry {
    path: PathBuf,
    file_name: String,
    file_size: i64,
}

/// Scan a library directory, index comics into SQLite, and generate thumbnails.
///
/// This function acquires and releases the DB lock **per comic** so that other
/// commands (`get_comics`, `get_page_file_path`, etc.) can interleave during
/// a scan. After each comic is indexed, a `comic-indexed` event is emitted
/// so the frontend can update the grid in real time without waiting for the
/// full scan to complete.
pub fn scan_library(
    base_dir: &Path,
    db: &Mutex<Connection>,
    cache_dir: &Path,
    app: &tauri::AppHandle,
) -> Result<ScanResult, String> {
    let now = chrono::Utc::now().to_rfc3339();
    let thumbnail_dir = cache_dir.join("thumbnails");
    fs::create_dir_all(&thumbnail_dir)
        .map_err(|e| format!("Failed to create thumbnail dir: {}", e))?;

    // ── Phase 1: Discover files + compute hashes (no DB lock) ──

    let file_entries = discover_files(base_dir);
    let total_files = file_entries.len();

    let file_hashes: Vec<(FileEntry, String)> = file_entries
        .into_par_iter()
        .filter_map(|entry| match compute_file_hash(&entry.path) {
            Ok(hash) => Some((entry, hash)),
            Err(e) => {
                eprintln!("Hash error: {}", e);
                None
            }
        })
        .collect();

    // ── Phase 2: Get current DB state (lock briefly) ──

    let db_paths: HashSet<String> = {
        let conn = db.lock().map_err(|e| format!("DB lock: {}", e))?;
        db::get_all_file_paths(&conn)
            .map_err(|e| format!("DB error: {}", e))?
            .into_iter()
            .collect()
    };

    let mut scanned_paths: HashSet<String> = HashSet::with_capacity(file_hashes.len());
    let mut new_comics = 0usize;
    let mut updated_comics = 0usize;
    let mut skipped_comics = 0usize;
    let mut errors: Vec<String> = Vec::new();

    // ── Phase 3: Process each comic (lock DB only briefly per comic) ──

    for (entry, hash) in &file_hashes {
        let path_str = entry.path.to_string_lossy().to_string();
        scanned_paths.insert(path_str.clone());

        // Step 3a: Check whether this file needs (re-)indexing (lock briefly)
        let needs_processing = {
            let conn = db.lock().map_err(|e| format!("DB lock: {}", e))?;
            let existing = db::get_comic_hash(&conn, &path_str)
                .map_err(|e| format!("DB error: {}", e))?;
            existing.as_ref().map_or(true, |h| h != hash)
        };

        if !needs_processing {
            skipped_comics += 1;
            continue;
        }

        let is_update = db_paths.contains(&path_str);

        // Step 3b: Insert/update comic record, get an ID (lock briefly)
        let comic_id = {
            let conn = db.lock().map_err(|e| format!("DB lock: {}", e))?;
            if is_update {
                let id = db::get_comic_id(&conn, &path_str)
                    .map_err(|e| format!("DB error: {}", e))?
                    .ok_or_else(|| format!("Comic vanished during scan: {}", path_str))?;
                db::update_comic(&conn, id, hash, entry.file_size, 0, &now)
                    .map_err(|e| format!("DB update: {}", e))?;
                db::delete_pages(&conn, id)
                    .map_err(|e| format!("DB delete pages: {}", e))?;
                id
            } else {
                db::insert_comic(
                    &conn,
                    &path_str,
                    &entry.file_name,
                    hash,
                    entry.file_size,
                    0, // page_count placeholder — updated after extraction
                    &now,
                )
                .map_err(|e| format!("DB insert: {}", e))?
            }
        }; // DB lock released — other commands can now run

        // Step 3c: Extract pages + generate thumbnail (no DB lock — this is the slow part)
        match process_comic_assets(&entry.path, &thumbnail_dir, comic_id) {
            Ok((pages, cover_filename)) => {
                let page_count = pages.len() as i64;

                // Step 3d: Save pages and finalise metadata (lock briefly)
                {
                    let conn =
                        db.lock().map_err(|e| format!("DB lock: {}", e))?;
                    db::insert_pages(&conn, comic_id, &pages)
                        .map_err(|e| format!("DB insert pages: {}", e))?;
                    // Update page_count from placeholder to actual
                    conn.execute(
                        "UPDATE comics SET page_count = ?1 WHERE id = ?2",
                        rusqlite::params![page_count, comic_id],
                    )
                    .map_err(|e| format!("DB update page_count: {}", e))?;
                    if let Some(ref cover) = cover_filename {
                        db::set_cover_path(&conn, comic_id, cover)
                            .map_err(|e| format!("DB set cover: {}", e))?;
                    }
                } // DB lock released

                // Build ComicInfo for the real-time event
                let comic_info = ComicInfo {
                    id: comic_id,
                    file_path: path_str.clone(),
                    file_name: entry.file_name.clone(),
                    file_hash: hash.clone(),
                    file_size: entry.file_size,
                    page_count,
                    cover_path: cover_filename.clone(),
                    cover_file_path: cover_filename.as_ref().map(|_| {
                        thumbnail_dir
                            .join(format!("{}.webp", comic_id))
                            .to_string_lossy()
                            .to_string()
                    }),
                    added_at: now.clone(),
                    updated_at: now.clone(),
                };

                // Emit event so the frontend adds this comic to the grid immediately
                let _ = app.emit("comic-indexed", &comic_info);

                if is_update {
                    updated_comics += 1;
                } else {
                    new_comics += 1;
                }
            }
            Err(e) => {
                errors.push(format!("{}: {}", entry.file_name, e));
            }
        }
    }

    // ── Phase 4: Remove stale entries (lock briefly) ──

    let mut removed_comics = 0usize;
    {
        let conn = db.lock().map_err(|e| format!("DB lock: {}", e))?;
        for db_path in &db_paths {
            if !scanned_paths.contains(db_path) {
                if let Ok(Some(comic_id)) = db::get_comic_id(&conn, db_path) {
                    let thumb_path =
                        thumbnail_dir.join(format!("{}.webp", comic_id));
                    let _ = fs::remove_file(&thumb_path);
                    let _ = db::delete_comic(&conn, comic_id);
                    removed_comics += 1;
                }
            }
        }
    }

    let result = ScanResult {
        total_files,
        new_comics,
        updated_comics,
        removed_comics,
        skipped_comics,
        errors,
    };

    // Emit final event
    let _ = app.emit("scan-complete", &result);

    Ok(result)
}

// ── Helpers ────────────────────────────────────────────────────────────

/// Walk the directory tree and find all comic files.
fn discover_files(base_dir: &Path) -> Vec<FileEntry> {
    WalkDir::new(base_dir)
        .follow_links(true)
        .into_iter()
        .filter_map(|entry| {
            let entry = entry.ok()?;
            if !entry.file_type().is_file() {
                return None;
            }
            let path = entry.path();
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_lowercase();
            if !COMIC_EXTENSIONS.contains(&ext.as_str()) {
                return None;
            }
            let file_name = path
                .file_stem()
                .and_then(|n| n.to_str())
                .unwrap_or("unknown")
                .to_string();
            let file_size = entry.metadata().ok()?.len() as i64;
            Some(FileEntry {
                path: path.to_path_buf(),
                file_name,
                file_size,
            })
        })
        .collect()
}

/// Compute a blake3 hash of the first 64KB + last 64KB + file size for fast dedup.
fn compute_file_hash(path: &Path) -> Result<String, String> {
    let mut file =
        fs::File::open(path).map_err(|e| format!("Cannot open: {}", e))?;
    let metadata =
        file.metadata().map_err(|e| format!("Cannot stat: {}", e))?;
    let file_size = metadata.len();

    let mut hasher = blake3::Hasher::new();
    hasher.update(&file_size.to_le_bytes());

    // Hash the first 64KB
    let mut buf = vec![0u8; 65536];
    let n = file
        .read(&mut buf)
        .map_err(|e| format!("Cannot read: {}", e))?;
    hasher.update(&buf[..n]);

    // For larger files, also sample the last 64KB
    if file_size > 65536 {
        let seek_pos = file_size.saturating_sub(65536);
        file.seek(std::io::SeekFrom::Start(seek_pos))
            .map_err(|e| format!("Cannot seek: {}", e))?;
        let mut tail_buf = vec![0u8; 65536];
        let n2 = file
            .read(&mut tail_buf)
            .map_err(|e| format!("Cannot read tail: {}", e))?;
        hasher.update(&tail_buf[..n2]);
    }

    Ok(hasher.finalize().to_hex().to_string())
}

/// Extract the page list and generate a cover thumbnail from a comic ZIP.
///
/// Opens the ZIP once, extracts all image entries (sorted by name) and
/// decompresses the first image for thumbnail generation.
///
/// Returns `(pages, optional_cover_filename)`.
fn process_comic_assets(
    zip_path: &Path,
    thumbnail_dir: &Path,
    comic_id: i64,
) -> Result<(Vec<(i64, String, i64)>, Option<String>), String> {
    let file =
        fs::File::open(zip_path).map_err(|e| format!("Cannot open: {}", e))?;
    let mut archive = zip::read::ZipArchive::new(file)
        .map_err(|e| format!("Bad zip: {}", e))?;

    // Collect image entries sorted by filename (case-insensitive)
    let mut image_entries: Vec<(String, u64)> = Vec::new();
    for i in 0..archive.len() {
        let entry = archive
            .by_index(i)
            .map_err(|e| format!("ZIP entry error: {}", e))?;
        if entry.is_dir() {
            continue;
        }
        let name = entry.name().to_string();
        let ext = Path::new(&name)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        if IMAGE_EXTENSIONS.contains(&ext.as_str()) {
            image_entries.push((name, entry.size()));
        }
    }
    image_entries.sort_by(|a, b| {
        a.0.to_lowercase().cmp(&b.0.to_lowercase())
    });

    // Generate cover thumbnail from the first image
    let cover_filename = if let Some((first_name, _)) = image_entries.first()
    {
        let mut entry = archive
            .by_name(first_name)
            .map_err(|e| format!("Entry '{}': {}", first_name, e))?;
        let mut buf = Vec::with_capacity(entry.size() as usize);
        entry
            .read_to_end(&mut buf)
            .map_err(|e| format!("Decompress: {}", e))?;
        Some(thumbnail::generate_thumbnail_from_bytes(
            &buf,
            thumbnail_dir,
            comic_id,
        )?)
    } else {
        None
    };

    // Build page list
    let pages: Vec<(i64, String, i64)> = image_entries
        .into_iter()
        .enumerate()
        .map(|(idx, (name, size))| (idx as i64, name, size as i64))
        .collect();

    Ok((pages, cover_filename))
}
