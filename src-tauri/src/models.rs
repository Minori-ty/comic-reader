use serde::{Deserialize, Serialize};

/// Represents a single comic (ZIP file) in the library.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComicInfo {
    pub id: i64,
    pub file_path: String,
    pub file_name: String,
    pub file_hash: String,
    pub file_size: i64,
    pub page_count: i64,
    pub cover_path: Option<String>,
    /// Absolute filesystem path to the cover thumbnail (for convertFileSrc).
    pub cover_file_path: Option<String>,
    pub added_at: String,
    pub updated_at: String,
}

/// Represents a single page within a comic.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageInfo {
    pub id: i64,
    pub comic_id: i64,
    pub page_idx: i64,
    pub file_name: String,
    pub file_size: i64,
}

/// Result of a scan operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub total_files: usize,
    pub new_comics: usize,
    pub updated_comics: usize,
    pub removed_comics: usize,
    pub skipped_comics: usize,
    pub errors: Vec<String>,
}

/// Progress event emitted during scanning.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub current: usize,
    pub total: usize,
    pub file_name: String,
    pub status: String, // "scanning", "indexing", "thumbnail", "done"
}

/// Application directory paths exposed to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppPaths {
    pub app_data_dir: String,
    pub db_path: String,
    pub thumbnails_dir: String,
    pub pages_cache_dir: String,
}

/// Result of a cache-clearing operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearCacheResult {
    pub cleared_path: String,
}

/// Cache directory sizes (human-readable strings + raw bytes).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheSizes {
    pub thumbnails_size: String,
    pub thumbnails_bytes: u64,
    pub pages_size: String,
    pub pages_bytes: u64,
    pub total_size: String,
    pub total_bytes: u64,
}
