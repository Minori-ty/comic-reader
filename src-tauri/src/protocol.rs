use rusqlite::Connection;
use std::fs;
use std::io::Read;
use std::path::Path;

use crate::db;

/// Parse a custom protocol URI to extract path segments.
///
/// On **Windows (WebView2)**, Tauri v2 maps custom schemes to:
///   `https://{scheme}.localhost/{path}`
///   e.g. `https://comic.localhost/123/0`
///
/// On **macOS/Linux**, the format is:
///   `{scheme}://localhost/{path}`
///   e.g. `comic://localhost/123/0`
///
/// This function handles both formats.
fn parse_protocol_uri<'a>(uri: &'a str, scheme: &str) -> Option<Vec<&'a str>> {
    // Try Windows format first: https://{scheme}.localhost/{path}
    let windows_prefix = format!("https://{}.localhost/", scheme);
    if let Some(path) = uri.strip_prefix(&windows_prefix) {
        return Some(path.split('/').filter(|s| !s.is_empty()).collect());
    }

    // Try macOS/Linux format: {scheme}://localhost/{path}
    let unix_prefix = format!("{}://localhost/", scheme);
    if let Some(path) = uri.strip_prefix(&unix_prefix) {
        return Some(path.split('/').filter(|s| !s.is_empty()).collect());
    }

    // Try bare format: {scheme}://{path}
    let bare_prefix = format!("{}://", scheme);
    if let Some(path) = uri.strip_prefix(&bare_prefix) {
        return Some(path.split('/').filter(|s| !s.is_empty()).collect());
    }

    None
}

/// Handle a comic page request via the `comic` protocol.
///
/// URI formats accepted:
///   - `https://comic.localhost/<comic_id>/<page_idx>`  (Windows)
///   - `comic://localhost/<comic_id>/<page_idx>`         (macOS/Linux)
///
/// Returns the raw image bytes with appropriate MIME type.
pub fn handle_comic_protocol(
    uri: &str,
    conn: &Connection,
) -> Result<(Vec<u8>, String), Box<dyn std::error::Error>> {
    let parts = parse_protocol_uri(uri, "comic")
        .ok_or_else(|| format!("Invalid comic URI: {}", uri))?;

    if parts.len() < 2 {
        return Err(format!("Invalid comic URI (need comic_id/page_idx): {}", uri).into());
    }

    let comic_id: i64 = parts[0]
        .parse()
        .map_err(|_| format!("Invalid comic id: {}", parts[0]))?;
    let page_idx: i64 = parts[1]
        .parse()
        .map_err(|_| format!("Invalid page idx: {}", parts[1]))?;

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

    let mime = mime_from_path(&page.file_name);

    Ok((buf, mime.to_string()))
}

/// Handle a cover thumbnail request via the `cover` protocol.
///
/// URI formats accepted:
///   - `https://cover.localhost/<comic_id>`  (Windows)
///   - `cover://localhost/<comic_id>`         (macOS/Linux)
///
/// Returns the WebP thumbnail bytes.
pub fn handle_cover_protocol(
    uri: &str,
    thumbnail_dir: &Path,
) -> Result<(Vec<u8>, String), Box<dyn std::error::Error>> {
    let parts = parse_protocol_uri(uri, "cover")
        .ok_or_else(|| format!("Invalid cover URI: {}", uri))?;

    if parts.is_empty() {
        return Err(format!("Invalid cover URI (need comic_id): {}", uri).into());
    }

    let comic_id: i64 = parts[0]
        .parse()
        .map_err(|_| format!("Invalid comic id: {}", parts[0]))?;

    let thumb_path = thumbnail_dir.join(format!("{}.webp", comic_id));
    let data = fs::read(&thumb_path)
        .map_err(|e| format!("Thumbnail not found for comic {}: {}", comic_id, e))?;

    Ok((data, "image/webp".to_string()))
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
