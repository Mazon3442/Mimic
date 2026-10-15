fn main() {
    // Distro packages (packaging/arch) set MIMIC_PACKAGE, read with option_env! in main.rs.
    println!("cargo:rerun-if-env-changed=MIMIC_PACKAGE");
    tauri_build::build()
}
