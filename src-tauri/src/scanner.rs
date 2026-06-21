use rayon::prelude::*;
use rusqlite::Connection;
use std::collections::HashSet;
use std::fs;
use std::io::{Read, Seek};
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

use crate::db;
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
/// This is the main incremental scan function. It:
/// 1. Walks the directory for ZIP/CBZ files (in parallel with rayon)
/// 2. Computes a blake3 hash for each file
/// 3. Compares against the DB to determine new/updated/skipped
/// 4. Extracts page lists and generates cover thumbnails for new/updated comics
/// 5. Removes DB entries for files that no longer exist
pub fn scan_library(base_dir: &Path, conn: &Connection, cache_dir: &Path) -> Result<ScanResult, String> {
    let now = chrono::Utc::now().to_rfc3339();
    let thumbnail_dir = cache_dir.join("thumbnails");

    // Step 1: Discover all comic files
    let file_entries = discover_files(base_dir);

    let total_files = file_entries.len();
    let mut errors: Vec<String> = Vec::new();

    // Step 2: Compute hashes in parallel
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

    // Step 3: Get current DB state
    let db_paths: HashSet<String> = db::get_all_file_paths(conn)
        .map_err(|e| format!("DB error: {}", e))?
        .into_iter()
        .collect();

    let mut scanned_paths: HashSet<String> = HashSet::new();
    let mut new_comics = 0usize;
    let mut updated_comics = 0usize;
    let mut skipped_comics = 0usize;

    // Step 4: Process each file (single-threaded — SQLite is not Send)
    for (entry, hash) in &file_hashes {
        let path_str = entry.path.to_string_lossy().to_string();
        scanned_paths.insert(path_str.clone());

        let existing_hash = db::get_comic_hash(conn, &path_str)
            .map_err(|e| format!("DB error: {}", e))?;

        if let Some(ref existing) = existing_hash {
            if existing == hash {
                skipped_comics += 1;
                continue;
            }
            // File updated
            match index_comic(conn, &entry.path, &entry.file_name, hash, entry.file_size, &now, &thumbnail_dir) {
                Ok(_) => updated_comics += 1,
                Err(e) => errors.push(format!("{}: {}", entry.file_name, e)),
            }
        } else {
            // New file
            match index_comic(conn, &entry.path, &entry.file_name, hash, entry.file_size, &now, &thumbnail_dir) {
                Ok(_) => new_comics += 1,
                Err(e) => errors.push(format!("{}: {}", entry.file_name, e)),
            }
        }
    }

    // Step 5: Remove comics that no longer exist on disk
    let mut removed_comics = 0usize;
    for db_path in &db_paths {
        if !scanned_paths.contains(db_path) {
            if let Some(comic_id) = db::get_comic_id(conn, db_path).unwrap_or(None) {
                let thumb_path = thumbnail_dir.join(format!("{}.webp", comic_id));
                let _ = fs::remove_file(&thumb_path);
                db::delete_comic(conn, comic_id).ok();
                removed_comics += 1;
            }
        }
    }

    Ok(ScanResult {
        total_files,
        new_comics,
        updated_comics,
        removed_comics,
        skipped_comics,
        errors,
    })
}

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
    let mut file = fs::File::open(path).map_err(|e| format!("Cannot open: {}", e))?;
    let metadata = file.metadata().map_err(|e| format!("Cannot stat: {}", e))?;
    let file_size = metadata.len();

    let mut hasher = blake3::Hasher::new();
    hasher.update(&file_size.to_le_bytes());

    // Hash the first 64KB
    let mut buf = vec![0u8; 65536];
    let n = file.read(&mut buf).map_err(|e| format!("Cannot read: {}", e))?;
    hasher.update(&buf[..n]);

    // For larger files, also sample the last 64KB
    if file_size > 65536 {
        let seek_pos = file_size.saturating_sub(65536);
        file.seek(std::io::SeekFrom::Start(seek_pos))
            .map_err(|e| format!("Cannot seek: {}", e))?;
        let mut tail_buf = vec![0u8; 65536];
        let n2 = file.read(&mut tail_buf).map_err(|e| format!("Cannot read tail: {}", e))?;
        hasher.update(&tail_buf[..n2]);
    }

    Ok(hasher.finalize().to_hex().to_string())
}

/// Index a single comic: extract page list, generate cover thumbnail, insert into DB.
fn index_comic(
    conn: &Connection,
    zip_path: &Path,
    file_name: &str,
    hash: &str,
    file_size: i64,
    now: &str,
    thumbnail_dir: &Path,
) -> Result<(), String> {
    let file = fs::File::open(zip_path).map_err(|e| format!("Cannot open: {}", e))?;
    let mut archive =
        zip::read::ZipArchive::new(file).map_err(|e| format!("Bad zip: {}", e))?;

    let pages = extract_page_list(&mut archive)?;
    let page_count = pages.len() as i64;

    let path_str = zip_path.to_string_lossy().to_string();
    let comic_id = if let Some(id) = db::get_comic_id(conn, &path_str)
        .map_err(|e| format!("DB: {}", e))?
    {
        db::update_comic(conn, id, hash, file_size, page_count, now)
            .map_err(|e| format!("DB update: {}", e))?;
        db::delete_pages(conn, id).map_err(|e| format!("DB delete pages: {}", e))?;
        id
    } else {
        db::insert_comic(conn, &path_str, file_name, hash, file_size, page_count, now)
            .map_err(|e| format!("DB insert: {}", e))?
    };

    db::insert_pages(conn, comic_id, &pages)
        .map_err(|e| format!("DB insert pages: {}", e))?;

    match thumbnail::generate_cover_thumbnail(zip_path, thumbnail_dir, comic_id) {
        Ok(Some(cover_filename)) => {
            db::set_cover_path(conn, comic_id, &cover_filename)
                .map_err(|e| format!("DB set cover: {}", e))?;
        }
        Ok(None) => {}
        Err(e) => {
            eprintln!("Thumbnail failed for {}: {}", file_name, e);
        }
    }

    Ok(())
}

/// Extract the list of image pages from a ZIP archive, sorted by name.
fn extract_page_list<R: Read + Seek>(
    archive: &mut zip::read::ZipArchive<R>,
) -> Result<Vec<(i64, String, i64)>, String> {
    let mut pages: Vec<(String, i64)> = Vec::new();

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
            pages.push((name, entry.size() as i64));
        }
    }

    // Case-insensitive sort by filename
    pages.sort_by(|a, b| {
        a.0.to_lowercase().cmp(&b.0.to_lowercase())
    });

    Ok(pages
        .into_iter()
        .enumerate()
        .map(|(idx, (name, size))| (idx as i64, name, size))
        .collect())
}
