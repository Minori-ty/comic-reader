use image::codecs::webp::WebPEncoder;
use image::imageops::FilterType;
use image::ImageReader;
use std::fs;
use std::io::{BufWriter, Cursor, Read};
use std::path::Path;
use zip::read::ZipArchive;

/// Image file extensions we recognize as comic pages (case-insensitive).
pub const IMAGE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "webp", "bmp", "gif"];

/// Maximum thumbnail width in pixels.
const THUMBNAIL_WIDTH: u32 = 300;

/// Generate a WebP thumbnail from the first image found in a ZIP file.
///
/// Returns `Ok(Some(relative_path))` on success, `Ok(None)` if no image was found,
/// or `Err` on I/O / image processing errors.
#[allow(dead_code)]
pub fn generate_cover_thumbnail(
    zip_path: &Path,
    thumbnail_dir: &Path,
    comic_id: i64,
) -> Result<Option<String>, String> {
    // Open the ZIP file
    let file = fs::File::open(zip_path).map_err(|e| format!("Failed to open zip: {}", e))?;
    let mut archive =
        ZipArchive::new(file).map_err(|e| format!("Failed to read zip archive: {}", e))?;

    // Find the first image entry
    let first_image_data = find_first_image(&mut archive)?;

    let Some(image_data) = first_image_data else {
        return Ok(None);
    };

    // Decode the image
    let img = ImageReader::new(Cursor::new(&image_data))
        .with_guessed_format()
        .map_err(|e| format!("Failed to detect image format: {}", e))?
        .decode()
        .map_err(|e| format!("Failed to decode image: {}", e))?;

    // Resize to thumbnail width (maintain aspect ratio)
    let thumb = img.resize(THUMBNAIL_WIDTH, u32::MAX, FilterType::Lanczos3);

    // Ensure thumbnail directory exists
    fs::create_dir_all(thumbnail_dir)
        .map_err(|e| format!("Failed to create thumbnail dir: {}", e))?;

    // Save as WebP
    let thumb_filename = format!("{}.webp", comic_id);
    let thumb_path = thumbnail_dir.join(&thumb_filename);

    let output_file =
        fs::File::create(&thumb_path).map_err(|e| format!("Failed to create thumbnail file: {}", e))?;
    let mut writer = BufWriter::new(output_file);

    // Use WebPEncoder with quality 80
    let encoder = WebPEncoder::new_lossless(&mut writer);
    thumb
        .write_with_encoder(encoder)
        .map_err(|e| format!("Failed to encode WebP: {}", e))?;

    Ok(Some(thumb_filename))
}

/// Generate a WebP thumbnail directly from decompressed image bytes.
///
/// This is the post-ZIP-read half of `generate_cover_thumbnail` — callers
/// that already have the ZIP open (e.g. the scanner extracting page lists)
/// can use this to avoid opening the ZIP twice.
pub fn generate_thumbnail_from_bytes(
    image_bytes: &[u8],
    thumbnail_dir: &Path,
    comic_id: i64,
) -> Result<String, String> {
    let img = ImageReader::new(Cursor::new(image_bytes))
        .with_guessed_format()
        .map_err(|e| format!("Failed to detect image format: {}", e))?
        .decode()
        .map_err(|e| format!("Failed to decode image: {}", e))?;

    let thumb = img.resize(THUMBNAIL_WIDTH, u32::MAX, FilterType::Lanczos3);

    fs::create_dir_all(thumbnail_dir)
        .map_err(|e| format!("Failed to create thumbnail dir: {}", e))?;

    let thumb_filename = format!("{}.webp", comic_id);
    let thumb_path = thumbnail_dir.join(&thumb_filename);

    let output_file = fs::File::create(&thumb_path)
        .map_err(|e| format!("Failed to create thumbnail file: {}", e))?;
    let mut writer = BufWriter::new(output_file);
    let encoder = WebPEncoder::new_lossless(&mut writer);
    thumb
        .write_with_encoder(encoder)
        .map_err(|e| format!("Failed to encode WebP: {}", e))?;

    Ok(thumb_filename)
}

/// Find the first image entry in a ZIP archive and return its decompressed bytes.
#[allow(dead_code)]
fn find_first_image<R: Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
) -> Result<Option<Vec<u8>>, String> {
    // Collect and sort entries by name for deterministic ordering
    let mut entries: Vec<String> = (0..archive.len())
        .filter_map(|i| {
            let entry = archive.by_index(i).ok()?;
            let name = entry.name().to_string();
            // Skip directories and non-image files
            if entry.is_dir() {
                return None;
            }
            let ext = Path::new(&name)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_lowercase();
            if IMAGE_EXTENSIONS.contains(&ext.as_str()) {
                Some(name)
            } else {
                None
            }
        })
        .collect();

    entries.sort();

    if let Some(first_entry_name) = entries.first() {
        let mut entry = archive
            .by_name(first_entry_name)
            .map_err(|e| format!("Failed to read entry '{}': {}", first_entry_name, e))?;
        let mut buf = Vec::with_capacity(entry.size() as usize);
        entry
            .read_to_end(&mut buf)
            .map_err(|e| format!("Failed to decompress entry: {}", e))?;
        Ok(Some(buf))
    } else {
        Ok(None)
    }
}
