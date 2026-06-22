use rusqlite::{params, Connection, Result as SqliteResult};
use std::path::Path;

use crate::models::{ComicInfo, PageInfo};

/// Initialize the SQLite database: create tables and indexes if they don't exist.
///
/// This runs once at startup. The returned connection closes after initialisation;
/// all subsequent access goes through the r2d2 connection pool.
pub fn init_db(db_path: &Path) -> SqliteResult<()> {
    let conn = Connection::open(db_path)?;

    // Enable WAL mode for better concurrent read performance (persistent setting).
    conn.execute_batch("PRAGMA journal_mode=WAL;")?;

    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS config (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS comics (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            file_path  TEXT NOT NULL UNIQUE,
            file_name  TEXT NOT NULL,
            file_hash  TEXT NOT NULL,
            file_size  INTEGER NOT NULL,
            page_count INTEGER NOT NULL DEFAULT 0,
            cover_path TEXT,
            added_at   TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS comic_pages (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            comic_id  INTEGER NOT NULL,
            page_idx  INTEGER NOT NULL,
            file_name TEXT NOT NULL,
            file_size INTEGER NOT NULL,
            FOREIGN KEY (comic_id) REFERENCES comics(id) ON DELETE CASCADE,
            UNIQUE(comic_id, page_idx)
        );

        CREATE INDEX IF NOT EXISTS idx_comics_file_path ON comics(file_path);
        CREATE INDEX IF NOT EXISTS idx_pages_comic_id ON comic_pages(comic_id);
        ",
    )?;

    Ok(())
}

// ── Config ───────────────────────────────────────────

pub fn get_config(conn: &Connection, key: &str) -> SqliteResult<Option<String>> {
    let mut stmt = conn.prepare("SELECT value FROM config WHERE key = ?1")?;
    stmt.query_row(params![key], |row| row.get(0))
        .optional()
}

pub fn set_config(conn: &Connection, key: &str, value: &str) -> SqliteResult<()> {
    conn.execute(
        "INSERT INTO config (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

// ── Comics ───────────────────────────────────────────

/// Get all comics ordered by file_name.
pub fn get_all_comics(conn: &Connection) -> SqliteResult<Vec<ComicInfo>> {
    let mut stmt = conn.prepare(
        "SELECT id, file_path, file_name, file_hash, file_size, page_count, cover_path, added_at, updated_at
         FROM comics ORDER BY file_name",
    )?;
    let comics = stmt
        .query_map([], |row| {
            Ok(ComicInfo {
                id: row.get(0)?,
                file_path: row.get(1)?,
                file_name: row.get(2)?,
                file_hash: row.get(3)?,
                file_size: row.get(4)?,
                page_count: row.get(5)?,
                cover_path: row.get(6)?,
                cover_file_path: None, // populated by caller
                added_at: row.get(7)?,
                updated_at: row.get(8)?,
            })
        })?
        .collect::<SqliteResult<Vec<_>>>()?;
    Ok(comics)
}

/// Get a single comic by id.
pub fn get_comic_by_id(conn: &Connection, comic_id: i64) -> SqliteResult<Option<ComicInfo>> {
    let mut stmt = conn.prepare(
        "SELECT id, file_path, file_name, file_hash, file_size, page_count, cover_path, added_at, updated_at
         FROM comics WHERE id = ?1",
    )?;
    stmt.query_row(params![comic_id], |row| {
        Ok(ComicInfo {
            id: row.get(0)?,
            file_path: row.get(1)?,
            file_name: row.get(2)?,
            file_hash: row.get(3)?,
            file_size: row.get(4)?,
            page_count: row.get(5)?,
            cover_path: row.get(6)?,
            cover_file_path: None, // populated by caller
            added_at: row.get(7)?,
            updated_at: row.get(8)?,
        })
    })
    .optional()
}

/// Get both the stored hash and page_count — used to detect interrupted scans
/// (page_count == 0 means extraction never completed, so re-process even if hash matches).
pub fn get_comic_hash_and_page_count(
    conn: &Connection,
    file_path: &str,
) -> SqliteResult<Option<(String, i64)>> {
    let mut stmt =
        conn.prepare("SELECT file_hash, page_count FROM comics WHERE file_path = ?1")?;
    stmt.query_row(params![file_path], |row| Ok((row.get(0)?, row.get(1)?)))
        .optional()
}

/// Insert a new comic.
pub fn insert_comic(
    conn: &Connection,
    file_path: &str,
    file_name: &str,
    file_hash: &str,
    file_size: i64,
    page_count: i64,
    added_at: &str,
) -> SqliteResult<i64> {
    conn.execute(
        "INSERT INTO comics (file_path, file_name, file_hash, file_size, page_count, added_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
        params![file_path, file_name, file_hash, file_size, page_count, added_at],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Update an existing comic (hash changed, etc.).
pub fn update_comic(
    conn: &Connection,
    comic_id: i64,
    file_hash: &str,
    file_size: i64,
    page_count: i64,
    updated_at: &str,
) -> SqliteResult<()> {
    conn.execute(
        "UPDATE comics SET file_hash = ?1, file_size = ?2, page_count = ?3, updated_at = ?4 WHERE id = ?5",
        params![file_hash, file_size, page_count, updated_at, comic_id],
    )?;
    Ok(())
}

/// Set the cover_path for a comic.
pub fn set_cover_path(conn: &Connection, comic_id: i64, cover_path: &str) -> SqliteResult<()> {
    conn.execute(
        "UPDATE comics SET cover_path = ?1 WHERE id = ?2",
        params![cover_path, comic_id],
    )?;
    Ok(())
}

/// Get comic id by file_path.
pub fn get_comic_id(conn: &Connection, file_path: &str) -> SqliteResult<Option<i64>> {
    let mut stmt = conn.prepare("SELECT id FROM comics WHERE file_path = ?1")?;
    stmt.query_row(params![file_path], |row| row.get(0))
        .optional()
}

/// Delete a comic and its pages (CASCADE).
pub fn delete_comic(conn: &Connection, comic_id: i64) -> SqliteResult<()> {
    conn.execute("DELETE FROM comics WHERE id = ?1", params![comic_id])?;
    Ok(())
}

/// Get all file paths in the database (for detecting removed files).
pub fn get_all_file_paths(conn: &Connection) -> SqliteResult<Vec<String>> {
    let mut stmt = conn.prepare("SELECT file_path FROM comics")?;
    let paths = stmt
        .query_map([], |row| row.get(0))?
        .collect::<SqliteResult<Vec<_>>>()?;
    Ok(paths)
}

/// Delete comics whose file_path starts with the given prefix.
pub fn delete_comics_by_prefix(conn: &Connection, prefix: &str) -> SqliteResult<usize> {
    let count = conn.execute(
        "DELETE FROM comics WHERE file_path LIKE ?1",
        params![format!("{}%", prefix)],
    )?;
    Ok(count)
}

// ── Pages ────────────────────────────────────────────

/// Get all pages for a comic, ordered by page_idx.
pub fn get_pages(conn: &Connection, comic_id: i64) -> SqliteResult<Vec<PageInfo>> {
    let mut stmt = conn.prepare(
        "SELECT id, comic_id, page_idx, file_name, file_size
         FROM comic_pages WHERE comic_id = ?1 ORDER BY page_idx",
    )?;
    let pages = stmt
        .query_map(params![comic_id], |row| {
            Ok(PageInfo {
                id: row.get(0)?,
                comic_id: row.get(1)?,
                page_idx: row.get(2)?,
                file_name: row.get(3)?,
                file_size: row.get(4)?,
            })
        })?
        .collect::<SqliteResult<Vec<_>>>()?;
    Ok(pages)
}

/// Insert pages for a comic. Uses a transaction for performance.
pub fn insert_pages(conn: &Connection, comic_id: i64, pages: &[(i64, String, i64)]) -> SqliteResult<()> {
    let mut stmt =
        conn.prepare("INSERT INTO comic_pages (comic_id, page_idx, file_name, file_size) VALUES (?1, ?2, ?3, ?4)")?;
    for (page_idx, file_name, file_size) in pages {
        stmt.execute(params![comic_id, page_idx, file_name, file_size])?;
    }
    Ok(())
}

/// Delete all pages for a comic.
pub fn delete_pages(conn: &Connection, comic_id: i64) -> SqliteResult<()> {
    conn.execute("DELETE FROM comic_pages WHERE comic_id = ?1", params![comic_id])?;
    Ok(())
}

/// Set cover_path to NULL for all comics whose file_path starts with the given prefix.
pub fn clear_cover_paths_by_prefix(conn: &Connection, prefix: &str) -> SqliteResult<usize> {
    let count = conn.execute(
        "UPDATE comics SET cover_path = NULL WHERE file_path LIKE ?1",
        params![format!("{}%", prefix)],
    )?;
    Ok(count)
}

// Helper: turn a rusqlite Optional extension into something we can use
trait OptionalExt<T> {
    fn optional(self) -> SqliteResult<Option<T>>;
}

impl<T> OptionalExt<T> for SqliteResult<T> {
    fn optional(self) -> SqliteResult<Option<T>> {
        match self {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
    }
}
