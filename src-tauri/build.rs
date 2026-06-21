use std::fs;

fn main() {
    // Extract the app identifier from tauri.conf.json so it stays single-source
    let config: serde_json::Value =
        serde_json::from_str(&fs::read_to_string("tauri.conf.json").unwrap()).unwrap();
    let identifier = config["identifier"].as_str().unwrap();
    println!("cargo:rustc-env=APP_IDENTIFIER={identifier}");

    tauri_build::build()
}
