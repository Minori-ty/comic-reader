mod commands;
mod db;
mod models;
mod scanner;
mod server;
mod thumbnail;

use commands::{AppState, DbPool};
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;

/// Get the app data directory based on OS conventions.
fn get_app_data_dir() -> PathBuf {
    let identifier = env!("APP_IDENTIFIER");

    #[cfg(target_os = "windows")]
    {
        let appdata = std::env::var("APPDATA").unwrap_or_else(|_| ".".to_string());
        return PathBuf::from(appdata).join(identifier);
    }

    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
        return PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join(identifier);
    }

    #[cfg(target_os = "linux")]
    {
        let xdg_data = std::env::var("XDG_DATA_HOME").unwrap_or_else(|_| {
            let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
            format!("{home}/.local/share")
        });
        return PathBuf::from(xdg_data).join(identifier);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_data_dir = get_app_data_dir();
    let db_path = app_data_dir.join("comics.db");
    let cache_root = app_data_dir.join("cache");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            std::fs::create_dir_all(&app_data_dir).expect("Failed to create app data directory");
            std::fs::create_dir_all(&cache_root).expect("Failed to create cache directory");

            // Initialize the database schema with a temporary connection.
            db::init_db(&db_path).expect("Failed to initialize database");

            // Create a connection pool so multiple readers (e.g. frontend queries)
            // don't block each other on a single Mutex.
            let manager = SqliteConnectionManager::file(&db_path).with_init(|conn| {
                // Per-connection pragmas: foreign_keys enforcement and busy timeout
                // so concurrent writers wait instead of failing with SQLITE_BUSY.
                conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;")
            });

            let num_cpus = std::thread::available_parallelism()
                .map(|n| n.get())
                .unwrap_or(4);
            // Floor at 8 so low-core machines still get decent parallelism;
            // no upper cap — high-core machines scale naturally.
            let pool_size = num_cpus.max(8) as u32;
            let pool: DbPool = Pool::builder()
                .max_size(pool_size)
                .build(manager)
                .expect("Failed to create database pool");

            app.manage(AppState {
                db: pool,
                cache_root,
                server_shutdown: Mutex::new(None),
                server_port: Mutex::new(0),
                local_ip: Mutex::new(String::new()),
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_language,
            commands::set_language,
            commands::get_library_path,
            commands::set_library_path,
            commands::scan_library,
            commands::get_comics,
            commands::get_comic_pages,
            commands::get_cover_file_path,
            commands::get_page_file_path,
            commands::open_file_location,
            commands::delete_comic,
            commands::get_app_paths,
            commands::clear_thumbnails_cache,
            commands::clear_pages_cache,
            commands::clear_current_cache,
            commands::clear_all_cache,
            commands::get_cache_sizes,
            commands::start_server,
            commands::stop_server,
            commands::get_server_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
