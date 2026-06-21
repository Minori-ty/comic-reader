use rusqlite::Connection;
use std::fs;
use std::io::Read;
use std::path::Path;

use crate::db;

/// Handle a `comic://` URI scheme request.
///
/// URI format: `comic://localhost/<comic_id>/<page_idx>`
/// or simply: `comic://<comic_id>/<page_idx>`
///
/// Returns the raw image bytes with appropriate MIME type.
pub fn handle_comic_protocol(
    uri: &str,
    conn: &Connection,
) -> Result<(Vec<u8>, String), Box<dyn std::error::Error>> {
    // Parse the URI to extract comic_id and page_idx
    // URI format: comic://localhost/123/0 or comic://123/0
    let path = uri
        .strip_prefix("comic://localhost/")
        .or_else(|| uri.strip_prefix("comic://"))
        .unwrap_or(uri);

    let parts: Vec<&str> = path.split('/').collect();
    if parts.len() < 2 {
        return Err(format!("Invalid comic URI: {}", uri).into());
    }

    let comic_id: i64 = parts[0].parse().map_err(|_| format!("Invalid comic id: {}", parts[0]))?;
    let page_idx: i64 = parts[1].parse().map_err(|_| format!("Invalid page idx: {}", parts[1]))?;

    // Look up the comic
    let comic = db::get_comic_by_id(conn, comic_id)?
        .ok_or_else(|| format!("Comic not found: {}", comic_id))?;

    // Look up the specific page
    let pages = db::get_pages(conn, comic_id)?;
    let page = pages
        .get(page_idx as usize)
        .ok_or_else(|| format!("Page {} not found in comic {}", page_idx, comic_id))?;

    // Open the ZIP and extract the image bytes
    let zip_file = fs::File::open(&comic.file_path)?;
    let mut archive = zip::read::ZipArchive::new(zip_file)?;
    let mut entry = archive.by_name(&page.file_name)?;

    let mut buf = Vec::with_capacity(entry.size() as usize);
    entry.read_to_end(&mut buf)?;

    // Determine MIME type from extension
    let mime = mime_from_path(&page.file_name);

    Ok((buf, mime.to_string()))
}

/// Guess MIME type from a file extension.
fn mime_from_path(path: &str) -> &'static str {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        _ => "application/octet-stream",
    }
}
