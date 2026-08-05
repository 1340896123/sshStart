## Build and Packaging

- **Frontend build:** `npm run build` runs TypeScript checking followed by the Vite production build.
- **Windows installer build:** `npm run tauri build` builds the frontend, compiles the Rust/Tauri application, and creates both MSI and NSIS installers.
- **Required Rust toolchain:** use the installed `1.97.1-x86_64-pc-windows-msvc` toolchain. The default `1.91.0` toolchain can fail while compiling `tokio 1.53.1` with `E0080` layout errors.
- **Recommended PowerShell environment:**

  ```powershell
  $env:RUSTUP_TOOLCHAIN = "1.97.1"
  $env:CARGO_INCREMENTAL = "0"
  $env:RUSTFLAGS = "-C lto=off -C embed-bitcode=no"
  npm run tauri build
  ```

- **Build artifacts:** `src-tauri/target/release/bundle/msi/Portico SSH_0.1.0_x64_en-US.msi` and `src-tauri/target/release/bundle/nsis/Portico SSH_0.1.0_x64-setup.exe`. The `target` directory is generated output and is not committed.
