mod commands;
mod db;
mod models;
mod protocol;
mod scanner;
mod thumbnail;

use commands::AppState;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;

/// Get the app data directory based on OS conventions.
fn get_app_data_dir() -> PathBuf {
    let identifier = "com.tauri-app.comic-dev";

    #[cfg(target_os = "windows")]
    {
        let appdata = std::env::var("APPDATA").unwrap_or_else(|_| ".".to_string());
        PathBuf::from(appdata).join(identifier)
    }

    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
        PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join(identifier)
    }

    #[cfg(target_os = "linux")]
    {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
        PathBuf::from(home).join(".local").join("share").join(identifier)
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_data_dir = get_app_data_dir();
    let db_path = app_data_dir.join("comics.db");
    let cache_dir = app_data_dir.join("cache");
    let thumbnail_dir = cache_dir.join("thumbnails");

    // Clone before the setup closure takes ownership
    let db_path_setup = db_path.clone();
    let cache_dir_setup = cache_dir.clone();
    let thumbnail_dir_setup = thumbnail_dir.clone();

    // Clone for the protocol closures (which are registered after setup)
    let db_path_comic = db_path.clone();
    let thumbnail_dir_cover = thumbnail_dir.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            std::fs::create_dir_all(&app_data_dir)
                .expect("Failed to create app data directory");
            std::fs::create_dir_all(&cache_dir_setup).expect("Failed to create cache directory");
            std::fs::create_dir_all(&thumbnail_dir_setup)
                .expect("Failed to create thumbnail directory");

            let conn = db::init_db(&db_path_setup).expect("Failed to initialize database");

            app.manage(AppState {
                db: Mutex::new(conn),
                cache_dir: cache_dir_setup,
            });

            Ok(())
        })
        .register_uri_scheme_protocol("comic", move |_ctx, request| {
            let uri = request.uri().to_string();

            let conn = match rusqlite::Connection::open(&db_path_comic) {
                Ok(c) => c,
                Err(_) => {
                    return tauri::http::Response::builder()
                        .status(500)
                        .body(Vec::new())
                        .unwrap();
                }
            };

            match protocol::handle_comic_protocol(&uri, &conn) {
                Ok((data, mime)) => tauri::http::Response::builder()
                    .status(200)
                    .header("Content-Type", mime)
                    .header("Cache-Control", "public, max-age=31536000, immutable")
                    .body(data)
                    .unwrap(),
                Err(e) => {
                    eprintln!("comic:// error: {}", e);
                    tauri::http::Response::builder()
                        .status(404)
                        .body(Vec::new())
                        .unwrap()
                }
            }
        })
        .register_uri_scheme_protocol("cover", move |_ctx, request| {
            let uri = request.uri().to_string();
            let path = uri
                .strip_prefix("cover://localhost/")
                .or_else(|| uri.strip_prefix("cover://"))
                .unwrap_or("");

            let comic_id: i64 = match path.trim_end_matches('/').parse() {
                Ok(id) => id,
                Err(_) => {
                    return tauri::http::Response::builder()
                        .status(400)
                        .body(Vec::new())
                        .unwrap();
                }
            };

            let thumb_path = thumbnail_dir_cover.join(format!("{}.webp", comic_id));

            match std::fs::read(&thumb_path) {
                Ok(data) => tauri::http::Response::builder()
                    .status(200)
                    .header("Content-Type", "image/webp")
                    .header("Cache-Control", "public, max-age=31536000, immutable")
                    .body(data)
                    .unwrap(),
                Err(_) => tauri::http::Response::builder()
                    .status(404)
                    .body(Vec::new())
                    .unwrap(),
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_library_path,
            commands::set_library_path,
            commands::scan_library,
            commands::get_comics,
            commands::get_comic_pages,
            commands::get_thumbnail_path,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
