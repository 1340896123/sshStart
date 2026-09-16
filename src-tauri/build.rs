fn main() {
    // Native dialogs import TaskDialogIndirect, which requires Common Controls v6.
    // Embed the default dependency through the linker for both app and library tests.
    // Disable the resource copy to avoid duplicate manifests in the app executable.
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(
            tauri_build::WindowsAttributes::new_without_app_manifest(),
        ))
        .expect("failed to build Tauri resources");
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'");
    } else {
        tauri_build::build();
    }
}
