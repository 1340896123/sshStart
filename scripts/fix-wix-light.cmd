@echo off
REM ============================================================================
REM  Fix "failed to run light.exe" during `tauri build` (MSI bundling on Windows)
REM ============================================================================
REM  Root cause:
REM    tauri-bundler (>= 2.11.x) clears the process environment before spawning
REM    light.exe and keeps only { SYSTEMROOT, TEMP, TMP, TAURI_CLI_VERBOSITY }.
REM    WiX 3.14.1's native MSI-binding code (Binder::CreateInstanceTransforms)
REM    requires APPDATA / LOCALAPPDATA to be set; without them light.exe crashes
REM    with System.AccessViolationException / System.InvalidProgramException
REM    (0xC0000005) and tauri reports the unhelpful "failed to run light.exe".
REM
REM  Fix:
REM    Replace light.exe with a small launcher (light-wrapper.rs) that derives
REM    APPDATA / LOCALAPPDATA / USERPROFILE / USERNAME from TEMP and then
REM    delegates to the original binary (light-real.exe). A copied
REM    light-real.exe.config is also required because .NET resolves
REM    <exename>.exe.config by executable name and WiX extensions
REM    (mixed-mode assemblies) need loadFromRemoteSources enabled.
REM
REM  Re-apply this script whenever tauri re-downloads the WiX toolset
REM  (e.g. after a WiX version bump refreshes WixTools314).
REM ============================================================================
setlocal
set "TOOLS=%LOCALAPPDATA%\tauri\WixTools314"
set "SRC=%~dp0light-wrapper.rs"

if not exist "%TOOLS%\light.exe" (
    echo WixTools314 not found at %TOOLS% - nothing to fix.
    exit /b 1
)

REM Wrapper already installed?
if exist "%TOOLS%\light-real.exe" (
    echo light.exe wrapper already installed.
    exit /b 0
)

where rustc >nul 2>nul || (
    echo rustc not found on PATH - cannot build the wrapper.
    exit /b 1
)

REM 1. Preserve the original binary first (it is light.exe right now)
move /y "%TOOLS%\light.exe" "%TOOLS%\light-real.exe" >nul

REM 2. Compile the wrapper into its place
rustc -O "%SRC%" -o "%TOOLS%\light.exe" || (
    echo Failed to compile wrapper - restoring original...
    move /y "%TOOLS%\light-real.exe" "%TOOLS%\light.exe" >nul
    exit /b 1
)

REM 3. .NET resolves <exename>.exe.config by executable name; the config is
REM    required for WiX extension (mixed-mode assembly) loading.
copy /y "%TOOLS%\light.exe.config" "%TOOLS%\light-real.exe.config" >nul

echo Done. light.exe wrapper installed; light-real.exe is the original binary.
echo Next `tauri build` should produce the MSI bundle successfully.
endlocal
