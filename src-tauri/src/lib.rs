mod commands;
mod db;
mod models;
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

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            std::fs::create_dir_all(&app_data_dir)
                .expect("Failed to create app data directory");
            std::fs::create_dir_all(&cache_dir).expect("Failed to create cache directory");
            std::fs::create_dir_all(&thumbnail_dir)
                .expect("Failed to create thumbnail directory");

            let conn = db::init_db(&db_path).expect("Failed to initialize database");

            app.manage(AppState {
                db: Mutex::new(conn),
                cache_dir,
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_library_path,
            commands::set_library_path,
            commands::scan_library,
            commands::get_comics,
            commands::get_comic_pages,
            commands::get_cover_file_path,
            commands::get_page_file_path,
            commands::open_file_location,
            commands::delete_comic,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
