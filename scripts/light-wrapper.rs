// light.exe wrapper for the WiX 3.14 toolset.
//
// WHY THIS EXISTS:
// tauri-bundler clears the process environment before spawning light.exe and
// keeps only { SYSTEMROOT, TEMP, TMP, TAURI_CLI_VERBOSITY }. WiX 3.14's native
// MSI-binding code (Binder::CreateInstanceTransforms) requires APPDATA /
// LOCALAPPDATA in the environment; without them it crashes with
// System.AccessViolationException / System.InvalidProgramException
// (0xC0000005), surfacing as "failed to run light.exe" in `tauri build`.
//
// We derive those variables from TEMP (C:\Users\<user>\AppData\Local\Temp)
// and delegate to the real light.exe (light-real.exe, same directory).
use std::env;
use std::path::{Path, PathBuf};
use std::process::{exit, Command};

fn parent_string(path: &Path) -> Option<String> {
    path.parent()
        .map(|p| p.to_string_lossy().into_owned())
}

fn main() {
    let self_dir = env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from(r"C:\Users\jieok\AppData\Local\tauri\WixTools314"));

    // The bundler always passes TEMP/TMP (real session values), e.g.
    // C:\Users\jieok\AppData\Local\Temp. Derive the user-profile variables
    // from it; only set what is not already present.
    let temp = env::var("TEMP")
        .or_else(|_| env::var("TMP"))
        .map(PathBuf::from)
        .ok();

    if let Some(temp_path) = temp.as_deref() {
        // TEMP -> ...\AppData\Local\Temp ; LOCALAPPDATA = parent
        if let Some(local_appdata) = parent_string(temp_path) {
            if env::var_os("LOCALAPPDATA").is_none() {
                env::set_var("LOCALAPPDATA", &local_appdata);
            }
            let local_appdata_path = Path::new(&local_appdata);
            // LOCALAPPDATA -> ...\AppData\Local ; USERPROFILE = parent
            if let Some(user_profile) = parent_string(local_appdata_path) {
                if env::var_os("USERPROFILE").is_none() {
                    env::set_var("USERPROFILE", &user_profile);
                }
                if env::var_os("USERNAME").is_none() {
                    if let Some(name) = Path::new(&user_profile).file_name() {
                        env::set_var("USERNAME", name.to_string_lossy().into_owned());
                    }
                }
                // APPDATA = USERPROFILE\AppData\Roaming
                if env::var_os("APPDATA").is_none() {
                    let roaming = Path::new(&user_profile).join("AppData").join("Roaming");
                    env::set_var("APPDATA", roaming.to_string_lossy().into_owned());
                }
            }
        }
    }

    let real = self_dir.join("light-real.exe");
    let args: Vec<String> = env::args().skip(1).collect();

    let status = Command::new(&real).args(&args).status();

    match status {
        Ok(s) => exit(s.code().unwrap_or(1)),
        Err(e) => {
            eprintln!("[light-wrapper] failed to launch {}: {e}", real.display());
            exit(1);
        }
    }
}
