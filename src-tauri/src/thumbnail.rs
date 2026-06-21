use image::codecs::webp::WebPEncoder;
use image::imageops::FilterType;
use image::ImageReader;
use std::fs;
use std::io::{BufWriter, Cursor};
use std::path::Path;

/// Image file extensions we recognize as comic pages (case-insensitive).
pub const IMAGE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "webp", "bmp", "gif"];

/// Maximum thumbnail width in pixels.
const THUMBNAIL_WIDTH: u32 = 200;

/// Generate a WebP thumbnail directly from decompressed image bytes.
///
/// Callers that already have the ZIP open (e.g. the scanner extracting page lists)
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
