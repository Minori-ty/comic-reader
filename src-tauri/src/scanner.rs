use rayon::prelude::*;
use std::collections::HashSet;
use std::fs;
use std::io::{Read, Seek};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use tauri::Emitter;
use walkdir::WalkDir;

use crate::commands::DbPool;
use crate::db;
use crate::models::ComicInfo;
use crate::models::ScanProgress;
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
/// **Pipeline (optimised for time-to-first-comic):**
///   1) WalkDir discover files — fast metadata-only scan
///   2) Get current DB paths — single query
///   3) Rayon parallel: hash + DB check + ZIP extract + thumbnail + emit `comic-indexed`
///   4) Remove stale DB entries
///
/// By merging hashing into the per-file phase, `comic-indexed` events fire as soon
/// as the first comic finishes processing — the frontend no longer waits for ALL
/// files to be hashed before seeing anything.
pub fn scan_library(
    base_dir: &Path,
    db: &DbPool,
    cache_dir: &Path,
    app: &tauri::AppHandle,
) -> Result<ScanResult, String> {
    let now = chrono::Utc::now().to_rfc3339();
    let thumbnail_dir = cache_dir.join("thumbnails");
    fs::create_dir_all(&thumbnail_dir)
        .map_err(|e| format!("Failed to create thumbnail dir: {}", e))?;

    // ── Phase 1: Discover files (WalkDir metadata only, fast) ──
    let file_entries = discover_files(base_dir);
    let total_files = file_entries.len();

    // ── Phase 2: Get current DB state (single query) ──
    let db_paths: HashSet<String> = {
        let conn = db.get().map_err(|e| format!("Pool error: {}", e))?;
        db::get_all_file_paths(&conn)
            .map_err(|e| format!("DB error: {}", e))?
            .into_iter()
            .collect()
    };

    // ── Phase 3: Hash + process each comic in parallel ──
    //
    // Each rayon task does everything for one file:
    //   3a) compute_file_hash (128 KB sample I/O)
    //   3b) Pool get → check hash / page_count
    //   3c) Pool get → insert or update → get comic_id
    //   3d) NO pool → open ZIP, list entries, generate thumbnail
    //   3e) Pool get → save pages + update page_count + set cover
    //
    // Because hashing is now per-file instead of a global barrier,
    // the first `comic-indexed` event fires after the first file finishes
    // step 3d — typically within seconds, not minutes.

    let processed = AtomicUsize::new(0);
    let new_comics = AtomicUsize::new(0);
    let updated_comics = AtomicUsize::new(0);
    let skipped_comics = AtomicUsize::new(0);
    let errors: Mutex<Vec<String>> = Mutex::new(Vec::new());
    let scanned_paths: Mutex<HashSet<String>> =
        Mutex::new(HashSet::with_capacity(file_entries.len()));

    file_entries.par_iter().for_each(|entry| {
        let path_str = entry.path.to_string_lossy().to_string();
        scanned_paths.lock().unwrap().insert(path_str.clone());

        // Step 3a: Compute file hash (merged — was its own barrier phase before)
        let hash = match compute_file_hash(&entry.path) {
            Ok(h) => h,
            Err(e) => {
                errors.lock().unwrap().push(format!("Hash error: {}", e));
                let current = processed.fetch_add(1, Ordering::Relaxed) + 1;
                let _ = app.emit(
                    "scan-progress",
                    &ScanProgress {
                        current,
                        total: total_files,
                        file_name: entry.file_name.clone(),
                        status: "error".to_string(),
                    },
                );
                return;
            }
        };

        // Step 3b+c combined: check hash + insert/update in ONE pool get
        // (was 2 pool gets before; merging reduces connection contention by 33%)
        let db_result: Result<Option<(i64, bool)>, String> = (|| {
            let conn = db.get().map_err(|e| format!("Pool: {}", e))?;

            let stored = db::get_comic_hash_and_page_count(&conn, &path_str)
                .map_err(|e| format!("DB: {}", e))?;
            let needs = stored.map_or(true, |(h, pc)| h != hash || pc == 0);

            if !needs {
                return Ok(None); // skip
            }

            let is_update = db_paths.contains(&path_str);
            let id = if is_update {
                let eid = db::get_comic_id(&conn, &path_str)
                    .map_err(|e| format!("DB: {}", e))?
                    .ok_or_else(|| format!("Comic vanished: {}", path_str))?;
                db::update_comic(&conn, eid, &hash, entry.file_size, 0, &now)
                    .map_err(|e| format!("DB update: {}", e))?;
                db::delete_pages(&conn, eid)
                    .map_err(|e| format!("DB delete pages: {}", e))?;
                eid
            } else {
                db::insert_comic(
                    &conn,
                    &path_str,
                    &entry.file_name,
                    &hash,
                    entry.file_size,
                    0,
                    &now,
                )
                .map_err(|e| format!("DB insert: {}", e))?
            };
            Ok(Some((id, is_update)))
        })();

        let (comic_id, is_update) = match db_result {
            Ok(Some(v)) => v,
            Ok(None) => {
                skipped_comics.fetch_add(1, Ordering::Relaxed);
                let current = processed.fetch_add(1, Ordering::Relaxed) + 1;
                let _ = app.emit(
                    "scan-progress",
                    &ScanProgress {
                        current,
                        total: total_files,
                        file_name: entry.file_name.clone(),
                        status: "skipped".to_string(),
                    },
                );
                return;
            }
            Err(e) => {
                errors.lock().unwrap().push(e);
                processed.fetch_add(1, Ordering::Relaxed);
                let _ = app.emit(
                    "scan-progress",
                    &ScanProgress {
                        current: processed.load(Ordering::Relaxed),
                        total: total_files,
                        file_name: entry.file_name.clone(),
                        status: "error".to_string(),
                    },
                );
                return;
            }
        };

        let status: &str;

        // Step 3d: Extract pages + generate thumbnail (no pool held)
        match process_comic_assets(&entry.path, &thumbnail_dir, comic_id) {
            Ok((pages, cover_filename)) => {
                let page_count = pages.len() as i64;

                // Step 3e: Save pages and finalise metadata (single transaction)
                {
                    let conn = db.get().unwrap();
                    let _ = conn.execute_batch("BEGIN;");
                    let _ = db::insert_pages(&conn, comic_id, &pages);
                    let _ = conn.execute(
                        "UPDATE comics SET page_count = ?1 WHERE id = ?2",
                        rusqlite::params![page_count, comic_id],
                    );
                    if let Some(ref cover) = cover_filename {
                        let _ = db::set_cover_path(&conn, comic_id, cover);
                    }
                    let _ = conn.execute_batch("COMMIT;");
                }

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

                let _ = app.emit("comic-indexed", &comic_info);

                if is_update {
                    updated_comics.fetch_add(1, Ordering::Relaxed);
                } else {
                    new_comics.fetch_add(1, Ordering::Relaxed);
                }
                status = "indexed";
            }
            Err(e) => {
                errors
                    .lock()
                    .unwrap()
                    .push(format!("{}: {}", entry.file_name, e));
                status = "error";
            }
        }

        // Emit scan progress after every file
        let current = processed.fetch_add(1, Ordering::Relaxed) + 1;
        let _ = app.emit(
            "scan-progress",
            &ScanProgress {
                current,
                total: total_files,
                file_name: entry.file_name.clone(),
                status: status.to_string(),
            },
        );
    });

    // ── Phase 4: Remove stale entries (brief pool connection) ──

    let mut removed_comics = 0usize;
    let scanned = scanned_paths.into_inner().unwrap();
    {
        let conn = db.get().map_err(|e| format!("Pool error: {}", e))?;
        for db_path in &db_paths {
            if !scanned.contains(db_path) {
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
        new_comics: new_comics.into_inner(),
        updated_comics: updated_comics.into_inner(),
        removed_comics,
        skipped_comics: skipped_comics.into_inner(),
        errors: errors.into_inner().unwrap(),
    };

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
    let mut file = fs::File::open(path).map_err(|e| format!("Cannot open: {}", e))?;
    let metadata = file.metadata().map_err(|e| format!("Cannot stat: {}", e))?;
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

/// A page entry ready for DB insert: `(page_idx, file_name, file_size)`.
type PageEntry = (i64, String, i64);

/// Extract the page list and generate a cover thumbnail from a comic ZIP.
///
/// Uses a **single pass** through the central directory via `by_index()` to
/// collect image names and sizes — avoids the O(N²) behaviour of calling
/// `by_name()` for every page (each `by_name` does its own linear scan).
///
/// Returns `(pages, optional_cover_filename)`.
fn process_comic_assets(
    zip_path: &Path,
    thumbnail_dir: &Path,
    comic_id: i64,
) -> Result<(Vec<PageEntry>, Option<String>), String> {
    let file = fs::File::open(zip_path).map_err(|e| format!("Cannot open: {}", e))?;
    let mut archive =
        zip::read::ZipArchive::new(file).map_err(|e| format!("Bad zip: {}", e))?;

    // Single O(N) pass: collect (name, size) for every image entry
    let mut images: Vec<(String, u64)> = Vec::new();
    for i in 0..archive.len() {
        let entry = archive
            .by_index(i)
            .map_err(|e| format!("Entry {}: {}", i, e))?;
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
            images.push((name, entry.size()));
        }
    }

    images.sort_by(|a, b| natural_cmp(&a.0, &b.0));

    // Generate cover thumbnail from the first image
    let cover_filename = if let Some((first_name, _)) = images.first() {
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

    // Page list: names and sizes already collected above, no extra `by_name` calls
    let pages: Vec<PageEntry> = images
        .into_iter()
        .enumerate()
        .map(|(idx, (name, size))| (idx as i64, name, size as i64))
        .collect();

    Ok((pages, cover_filename))
}

/// Natural sort comparator — treats numeric segments as numbers so that
/// "2.jpg" < "10.jpg" instead of the lexicographic "10.jpg" < "2.jpg".
///
/// Splits each string into alternating non-digit / digit segments and
/// compares them pairwise: non-digit segments are compared case-insensitively,
/// digit segments are compared as `u64`.
fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let a = a.as_bytes();
    let b = b.as_bytes();
    let mut ai = 0;
    let mut bi = 0;

    while ai < a.len() && bi < b.len() {
        let a_is_digit = a[ai].is_ascii_digit();
        let b_is_digit = b[bi].is_ascii_digit();

        if a_is_digit && b_is_digit {
            let a_start = ai;
            while ai < a.len() && a[ai].is_ascii_digit() {
                ai += 1;
            }
            let b_start = bi;
            while bi < b.len() && b[bi].is_ascii_digit() {
                bi += 1;
            }

            let a_num: u64 = std::str::from_utf8(&a[a_start..ai])
                .unwrap_or("0")
                .parse()
                .unwrap_or(0);
            let b_num: u64 = std::str::from_utf8(&b[b_start..bi])
                .unwrap_or("0")
                .parse()
                .unwrap_or(0);

            match a_num.cmp(&b_num) {
                std::cmp::Ordering::Equal => {}
                other => return other,
            }
        } else if !a_is_digit && !b_is_digit {
            let a_start = ai;
            while ai < a.len() && !a[ai].is_ascii_digit() {
                ai += 1;
            }
            let b_start = bi;
            while bi < b.len() && !b[bi].is_ascii_digit() {
                bi += 1;
            }

            let a_seg = &a[a_start..ai];
            let b_seg = &b[b_start..bi];

            let len = a_seg.len().min(b_seg.len());
            for i in 0..len {
                match a_seg[i]
                    .to_ascii_lowercase()
                    .cmp(&b_seg[i].to_ascii_lowercase())
                {
                    std::cmp::Ordering::Equal => {}
                    other => return other,
                }
            }
            match a_seg.len().cmp(&b_seg.len()) {
                std::cmp::Ordering::Equal => {}
                other => return other,
            }
        } else {
            return if a_is_digit {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Greater
            };
        }
    }

    a.len().cmp(&b.len())
}
