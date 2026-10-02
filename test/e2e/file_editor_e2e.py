"""Native WebView2 -> Tauri IPC -> Rust -> SSH/SFTP regression suite.

Run npm run test:e2e:files. Requires Rust 1.97.1, tauri-driver, Edge WebDriver,
and the Python packages listed in requirements.txt. No production server is used.
"""
import argparse
import copy
import errno
import json
import logging
import os
from pathlib import Path
import shlex
import socket
import stat
import subprocess
import threading
import time
import unittest
import urllib.request

import paramiko
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.common.selenium_manager import SeleniumManager
from selenium.webdriver.support.ui import WebDriverWait

ROOT = Path(__file__).resolve().parents[2]
ARTIFACTS = ROOT / "output" / "file-editor-e2e"


class Filesystem:
    """Deterministic Unix metadata and fault injection on a real SSH transport."""
    def __init__(self, label):
        self.label = label
        self.lock = threading.RLock()
        self.started = threading.Event()
        self.release = threading.Event()
        self.reset()

    def reset(self):
        with self.lock:
            self.files = {
                "/config.txt": self.file(f"original-{self.label}"),
                "/target.conf": self.file("target-original", 0o750, 503, 504),
                "/link.conf": {"link": "/target.conf"},
                "/nonutf8.txt": self.file(bytes([0xD6, 0xD0, 0xCE, 0xC4])),
                "/bom.txt": self.file(b"\xef\xbb\xbforiginal"),
                "/quoted ' #?.txt": self.file("quoted-original"),
            }
            self.pause = self.fail_write = self.fail_rename = self.fail_setstat = False
            self.change_before_commit = False
            self.temp_modes = []
            self.reads = 0
            self.writes = 0
            self.started.clear()
            self.release.set()

    @staticmethod
    def file(content, mode=0o600, uid=501, gid=501):
        return {"content": bytearray(content.encode() if isinstance(content, str) else content), "mode": stat.S_IFREG | mode, "uid": uid, "gid": gid, "mtime": 100}

    def canonical(self, path):
        seen = set()
        while path in self.files and "link" in self.files[path]:
            if path in seen:
                raise OSError(errno.ELOOP, "link loop")
            seen.add(path)
            path = self.files[path]["link"]
        return path

    def attributes(self, path, follow=True):
        with self.lock:
            if path == "/":
                entry = {"mode": stat.S_IFDIR | 0o755, "uid": 501, "gid": 501, "mtime": 100, "content": b""}
            else:
                entry = self.files[self.canonical(path) if follow else path]
            attr = paramiko.SFTPAttributes()
            attr.st_mode = stat.S_IFLNK | 0o777 if "link" in entry else entry["mode"]
            attr.st_uid, attr.st_gid = entry.get("uid", 501), entry.get("gid", 501)
            attr.st_atime = attr.st_mtime = entry.get("mtime", 100)
            attr.st_size = len(entry.get("content", b""))
            return attr

    def content(self, path):
        with self.lock:
            return bytes(self.files[self.canonical(path)]["content"])

    def replace(self, source, destination):
        with self.lock:
            if self.fail_rename:
                return paramiko.SFTP_PERMISSION_DENIED
            self.files[destination] = self.files.pop(source)
            return paramiko.SFTP_OK


class Handle(paramiko.SFTPHandle):
    def __init__(self, fs, path, flags):
        super().__init__(flags)
        self.fs, self.path = fs, path

    def read(self, offset, length):
        with self.fs.lock:
            self.fs.reads += 1
            return bytes(self.fs.files[self.path]["content"][offset:offset + length])

    def write(self, offset, data):
        self.fs.started.set()
        if self.fs.pause and not self.fs.release.wait(15):
            return paramiko.SFTP_FAILURE
        with self.fs.lock:
            self.fs.writes += 1
            entry = self.fs.files[self.path]
            if self.fs.fail_write:
                entry["content"][:] = data[:3]
                return paramiko.SFTP_FAILURE
            entry["content"][offset:offset + len(data)] = data
            entry["mtime"] += 1
            return paramiko.SFTP_OK

    def stat(self):
        return self.fs.attributes(self.path)

    def chattr(self, attr):
        with self.fs.lock:
            if self.fs.fail_setstat:
                return paramiko.SFTP_PERMISSION_DENIED
            entry = self.fs.files[self.path]
            for key, field in (("mode", "st_mode"), ("uid", "st_uid"), ("gid", "st_gid"), ("mtime", "st_mtime")):
                if getattr(attr, field, None) is not None:
                    entry[key] = stat.S_IFREG | getattr(attr, field) if key == "mode" else getattr(attr, field)
            return paramiko.SFTP_OK

    def close(self):
        with self.fs.lock:
            if self.fs.change_before_commit and ".portico-edit-" in self.path:
                self.fs.files["/config.txt"]["content"][:] = b"external-change"
                self.fs.change_before_commit = False
        return paramiko.SFTP_OK


class Sftp(paramiko.SFTPServerInterface):
    def __init__(self, server, *args, fs, **kwargs):
        super().__init__(server, *args, **kwargs)
        self.fs = fs

    def canonicalize(self, path):
        return self.fs.canonical(path)

    def stat(self, path):
        try:
            return self.fs.attributes(path)
        except KeyError:
            return paramiko.SFTP_NO_SUCH_FILE

    def lstat(self, path):
        try:
            return self.fs.attributes(path, False)
        except KeyError:
            return paramiko.SFTP_NO_SUCH_FILE

    def list_folder(self, path):
        if path != "/":
            return paramiko.SFTP_NO_SUCH_FILE
        result = []
        for name in sorted(self.fs.files):
            attr = self.fs.attributes(name, False)
            attr.filename = name[1:]
            result.append(attr)
        return result

    def open(self, path, flags, attr):
        with self.fs.lock:
            path = self.fs.canonical(path)
            if flags & os.O_CREAT:
                if flags & os.O_EXCL and path in self.fs.files:
                    return paramiko.SFTP_FAILURE
                mode = getattr(attr, "st_mode", 0o644)
                self.fs.files[path] = self.fs.file(b"", mode)
                self.fs.temp_modes.append(mode & 0o7777)
            if path not in self.fs.files:
                return paramiko.SFTP_NO_SUCH_FILE
            if flags & os.O_TRUNC:
                self.fs.files[path]["content"].clear()
            return Handle(self.fs, path, flags)

    def remove(self, path):
        with self.fs.lock:
            if path not in self.fs.files:
                return paramiko.SFTP_NO_SUCH_FILE
            del self.fs.files[path]
            return paramiko.SFTP_OK

    def rename(self, source, destination):
        # Standard SFTP v3 rejects replacing an existing destination.
        if destination in self.fs.files:
            return paramiko.SFTP_FAILURE
        return self.fs.replace(source, destination)


class Ssh(paramiko.ServerInterface):
    def __init__(self, fs):
        self.fs = fs

    def check_auth_password(self, username, password):
        return paramiko.AUTH_SUCCESSFUL if username == "e2e" and password == "local-fixture-only" else paramiko.AUTH_FAILED

    def get_allowed_auths(self, username):
        return "password"

    def check_channel_request(self, kind, channel_id):
        return paramiko.OPEN_SUCCEEDED if kind == "session" else paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED

    def check_channel_exec_request(self, channel, command):
        def execute():
            args = shlex.split(command.decode())
            ok = len(args) == 5 and args[:3] == ["mv", "-f", "--"] and self.fs.replace(args[3], args[4]) == paramiko.SFTP_OK
            if not ok:
                channel.send_stderr(b"injected commit failure")
            channel.send_exit_status(0 if ok else 1)
            channel.close()
        threading.Timer(0.02, execute).start()
        return True


class SshFixture:
    def __init__(self, label, key):
        self.fs, self.key = Filesystem(label), key
        self.host = "127.0.0.2" if label == "A" else "127.0.0.3"
        self.socket = socket.socket()
        self.socket.bind((self.host, 0))
        self.port = self.socket.getsockname()[1]
        self.socket.listen()
        self.transports = []
        self.stopped = False
        threading.Thread(target=self.accept, daemon=True).start()

    def accept(self):
        while not self.stopped:
            try:
                connection, _ = self.socket.accept()
            except OSError:
                break
            def start(connection=connection):
                transport = paramiko.Transport(connection, strict_kex=False)
                # libssh2 and Paramiko 5 disagree on GEX packet ordering. This
                # loopback fixture offers a fixed group to exercise SFTP reliably.
                transport.get_security_options().kex = ("diffie-hellman-group14-sha256",)
                self.transports.append(transport)
                transport.add_server_key(self.key)
                transport.set_subsystem_handler("sftp", paramiko.SFTPServer, Sftp, fs=self.fs)
                try:
                    transport.start_server(server=Ssh(self.fs))
                except (EOFError, OSError, paramiko.SSHException):
                    transport.close()
            threading.Thread(target=start, daemon=True).start()

    def close(self):
        self.stopped = True
        self.fs.release.set()
        self.socket.close()
        for transport in self.transports:
            transport.close()

    def profile(self, label):
        return {"id": label, "name": label, "group": "E2E", "host": self.host, "port": self.port, "username": "e2e", "password": "local-fixture-only", "authType": "password", "color": "#2f7d68"}


class SaveE2E(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        key = paramiko.RSAKey.generate(2048)
        cls.a, cls.b = SshFixture("A", key), SshFixture("B", key)
        options = webdriver.EdgeOptions()
        options.set_capability("tauri:options", {"application": str(ROOT / "src-tauri/target/debug/portico-ssh.exe")})
        cls.driver = webdriver.Remote("http://127.0.0.1:4444", options=options)
        cls.driver.set_script_timeout(30)
        cls.wait = WebDriverWait(cls.driver, 20)
        cls.wait.until(lambda _: cls.driver.execute_script("return typeof window.e2eConfigure === 'function'"))

    @classmethod
    def tearDownClass(cls):
        cls.driver.save_screenshot(str(ARTIFACTS / "native-webview-final.png"))
        cls.driver.quit()
        cls.a.close()
        cls.b.close()
        # Remove only the two generated fixture keys; retain unrelated host entries.
        hosts = Path(os.environ["USERPROFILE"]) / ".ssh/known_hosts"
        if hosts.exists():
            identities = {f"[{cls.a.host}]:{cls.a.port}", f"[{cls.b.host}]:{cls.b.port}"}
            lines = hosts.read_text().splitlines(keepends=True)
            filtered = [line for line in lines if not (len(line.split()) >= 3 and line.split()[0] in identities and line.split()[2] == cls.a.key.get_base64())]
            if filtered != lines:
                hosts.write_text("".join(filtered))

    def setUp(self):
        self.addCleanup(lambda: self.driver.save_screenshot(str(ARTIFACTS / f"{self.id().split('.')[-1]}.png")))
        self.a.fs.reset()
        self.b.fs.reset()
        self.active = "A"
        self.driver.execute_script("window.e2eConfigure(arguments[0])", [self.a.profile("A"), self.b.profile("B")])
        self.wait.until(lambda _: len(self.elements(".file-table tbody tr")) >= 6)

    def tearDown(self):
        self.a.fs.release.set()
        self.b.fs.release.set()
        self.driver.save_screenshot(str(ARTIFACTS / f"{self.id().split('.')[-1]}.png"))

    def elements(self, selector):
        return self.driver.find_elements(By.CSS_SELECTOR, f'[data-e2e-server="{self.active}"] {selector}')

    def click_button(self, text):
        self.driver.find_element(By.XPATH, f"//button[normalize-space()='{text}']").click()

    def open(self, name="config.txt"):
        self.wait.until(lambda _: any(row.find_element(By.CSS_SELECTOR, "td span").text == name for row in self.elements(".file-table tbody tr")))
        row = next(row for row in self.elements(".file-table tbody tr") if row.find_element(By.CSS_SELECTOR, "td span").text == name)
        from selenium.webdriver.common.action_chains import ActionChains
        ActionChains(self.driver).double_click(row).perform()

    def ready(self):
        self.wait.until(lambda _: self.elements(".file-editor.active .monaco-editor .view-lines"))

    def edit(self, text):
        self.ready()
        from selenium.webdriver.common.action_chains import ActionChains
        ActionChains(self.driver).click(self.elements(".file-editor.active .view-lines")[0]).key_down(Keys.CONTROL).send_keys("a").key_up(Keys.CONTROL).send_keys(Keys.BACKSPACE).send_keys(text).perform()

    def save(self, shortcut=False):
        if shortcut:
            from selenium.webdriver.common.action_chains import ActionChains
            ActionChains(self.driver).key_down(Keys.CONTROL).send_keys("s").key_up(Keys.CONTROL).perform()
        else:
            self.elements('.file-editor.active button[title="保存 (Ctrl+S)"]')[0].click()

    def saved(self):
        self.wait.until(lambda _: self.elements(".file-editor.active .file-editor-save-status"))
        errors = self.elements(".file-editor.active .file-editor-save-status.error")
        self.assertFalse(errors, errors[0].text if errors else "")

    def failed(self):
        self.wait.until(lambda _: self.elements(".file-editor.active .file-editor-save-status.error"))

    def assert_clean_temp(self):
        self.assertFalse(any(".portico-edit-" in path for path in self.a.fs.files))

    def test_button_shortcut_and_reopen(self):
        self.open(); self.edit("button-中文"); self.save(); self.saved()
        self.assertEqual(self.a.fs.content("/config.txt"), "button-中文".encode())
        self.edit("shortcut-save"); self.save(True); self.saved()
        self.assertEqual(self.a.fs.content("/config.txt"), b"shortcut-save")
        self.elements('button[aria-label="关闭 config.txt"]')[0].click()
        self.open(); self.ready()
        self.assertIn("shortcut-save", self.elements(".file-editor.active .view-lines")[0].text)
        self.assert_clean_temp()

    def test_servers_and_sessions_are_isolated(self):
        self.open(); self.edit("unsaved-A")
        self.click_button("B"); self.active = "B"; self.open(); self.ready()
        self.assertIn("original-B", self.elements(".file-editor.active .view-lines")[0].text)
        self.edit("saved-B"); self.save(); self.saved()
        self.assertEqual(self.b.fs.content("/config.txt"), b"saved-B")
        self.assertEqual(self.a.fs.content("/config.txt"), b"original-A")
        self.click_button("A"); self.active = "A"
        self.assertIn("unsaved-A", self.elements(".file-editor.active .view-lines")[0].text)
        self.click_button("同服务器新会话"); self.active = "A-same-server"; self.open(); self.ready()
        self.assertIn("original-A", self.elements(".file-editor.active .view-lines")[0].text)
        models = self.driver.execute_script("return window.e2eModels()")
        self.assertEqual(len({model["uri"] for model in models}), 3)
        self.elements('button[aria-label="关闭 config.txt"]')[0].click()
        self.click_button("A"); self.active = "A"
        self.assertIn("unsaved-A", self.elements(".file-editor.active .view-lines")[0].text)
        self.save(); self.saved()
        self.assertEqual(self.a.fs.content("/config.txt"), b"unsaved-A")

    def test_edit_during_save_remains_dirty(self):
        self.open(); self.edit("submitted")
        self.a.fs.pause = True; self.a.fs.release.clear(); self.save()
        self.assertTrue(self.a.fs.started.wait(10))
        self.edit("newer-version"); self.a.fs.release.set(); self.saved()
        self.assertEqual(self.a.fs.content("/config.txt"), b"submitted")
        self.assertTrue(self.elements(".file-editor.active .file-editor-dirty"))
        self.assertTrue(self.elements('.file-editor.active button[title="保存 (Ctrl+S)"]')[0].is_enabled())
        self.a.fs.pause = False; self.save(); self.saved()
        self.assertEqual(self.a.fs.content("/config.txt"), b"newer-version")
        self.assertFalse(self.elements(".file-editor.active .file-editor-dirty"))

    def test_profile_rename_does_not_reload(self):
        self.open(); self.edit("local-buffer")
        reads = self.a.fs.reads
        self.click_button("修改服务器名称")
        self.assertIn("local-buffer", self.elements(".file-editor.active .view-lines")[0].text)
        self.assertEqual(self.a.fs.reads, reads)
        self.save(); self.saved()
        self.assertEqual(self.a.fs.content("/config.txt"), b"local-buffer")

    def test_same_size_same_mtime_conflict_is_rejected(self):
        self.open(); self.edit("my-edit")
        with self.a.fs.lock:
            self.a.fs.files["/config.txt"]["content"][:] = b"external-A"
        self.save(); self.failed()
        self.assertEqual(self.a.fs.content("/config.txt"), b"external-A")
        self.assertTrue(self.elements(".file-editor.active .file-editor-dirty"))
        self.assert_clean_temp()

    def test_conflict_after_upload_is_rejected(self):
        self.open(); self.edit("my-edit")
        self.a.fs.change_before_commit = True
        self.save(); self.failed()
        self.assertEqual(self.a.fs.content("/config.txt"), b"external-change")
        self.assert_clean_temp()

    def test_failed_commit_preserves_original_and_can_retry(self):
        self.open(); self.edit("retry-content")
        self.a.fs.fail_rename = True; self.save(); self.failed()
        self.assertEqual(self.a.fs.content("/config.txt"), b"original-A")
        self.assert_clean_temp()
        self.a.fs.fail_rename = False; self.save(); self.saved()
        self.assertEqual(self.a.fs.content("/config.txt"), b"retry-content")

    def test_partial_write_preserves_original(self):
        self.open(); self.edit("partial-failure")
        self.a.fs.fail_write = True; self.save(); self.failed()
        self.assertEqual(self.a.fs.content("/config.txt"), b"original-A")
        self.assert_clean_temp()

    def test_permission_failure_preserves_original(self):
        self.open("target.conf"); self.edit("permission-failure")
        before = copy.deepcopy(self.a.fs.files["/target.conf"])
        self.a.fs.fail_setstat = True; self.save(); self.failed()
        self.assertEqual(self.a.fs.files["/target.conf"], before)
        self.assert_clean_temp()

    def test_symlink_target_and_metadata_are_preserved(self):
        self.open("link.conf"); self.edit("target-edited"); self.save(); self.saved()
        self.assertEqual(self.a.fs.files["/link.conf"], {"link": "/target.conf"})
        target = self.a.fs.files["/target.conf"]
        self.assertEqual(bytes(target["content"]), b"target-edited")
        self.assertEqual((target["mode"] & 0o7777, target["uid"], target["gid"]), (0o750, 503, 504))
        self.assertEqual(self.a.fs.temp_modes, [0o600])
        self.assert_clean_temp()

    def test_non_utf8_is_rejected_without_writing(self):
        original = self.a.fs.content("/nonutf8.txt")
        self.open("nonutf8.txt")
        self.wait.until(lambda _: self.elements(".file-editor-message-error"))
        self.assertIn("UTF-8", self.elements(".file-editor-message-error")[0].text)
        self.assertEqual(self.a.fs.content("/nonutf8.txt"), original)
        self.assertEqual(self.a.fs.writes, 0)

    def test_bom_and_quoted_path(self):
        self.open("bom.txt"); self.edit("bom-edited"); self.save(); self.saved()
        self.assertEqual(self.a.fs.content("/bom.txt"), b"\xef\xbb\xbfbom-edited")
        self.elements('button[aria-label="关闭 bom.txt"]')[0].click()
        self.open("quoted ' #?.txt"); self.edit("quoted-edited"); self.save(); self.saved()
        self.assertEqual(self.a.fs.content("/quoted ' #?.txt"), b"quoted-edited")


def wait_http(url, process):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"Service exited with code {process.returncode}")
        try:
            urllib.request.urlopen(url, timeout=1).close()
            return
        except Exception:
            time.sleep(0.2)
    raise RuntimeError(f"Service did not start: {url}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--skip-build", action="store_true")
    parser.add_argument("--failfast", action="store_true")
    args = parser.parse_args()
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    paramiko.util.log_to_file(str(ARTIFACTS / "ssh.log"), level=logging.ERROR)
    if not args.skip_build:
        env = {**os.environ, "RUSTUP_TOOLCHAIN": "1.97.1", "CARGO_INCREMENTAL": "0", "RUSTFLAGS": "-C lto=off -C embed-bitcode=no", "TAURI_CONFIG": (ROOT / "test/e2e/tauri.conf.json").read_text()}
        subprocess.run(["cargo", "build", "--manifest-path", "src-tauri/Cargo.toml"], cwd=ROOT, env=env, check=True)
    driver_path = SeleniumManager().binary_paths(["--browser", "edge", "--avoid-browser-download"])["driver_path"]
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    processes, logs = [], []
    try:
        for name, command in (("vite", ["node", "node_modules/vite/bin/vite.js"]), ("webdriver", ["tauri-driver", "--native-driver", driver_path])):
            if name == "vite":
                try:
                    urllib.request.urlopen("http://127.0.0.1:1420/test/e2e/file-editor.html", timeout=1).close()
                    continue
                except Exception:
                    pass
            log = (ARTIFACTS / f"{name}.log").open("w")
            logs.append(log)
            process = subprocess.Popen(command, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, creationflags=flags)
            processes.append(process)
            wait_http("http://127.0.0.1:1420" if name == "vite" else "http://127.0.0.1:4444/status", process)
        result = unittest.TextTestRunner(verbosity=2, failfast=args.failfast).run(unittest.defaultTestLoader.loadTestsFromTestCase(SaveE2E))
        (ARTIFACTS / "result.json").write_text(json.dumps({"tests": result.testsRun, "failures": len(result.failures), "errors": len(result.errors), "successful": result.wasSuccessful()}, indent=2))
        return 0 if result.wasSuccessful() else 1
    finally:
        for process in reversed(processes):
            process.terminate()
            try:
                process.wait(10)
            except subprocess.TimeoutExpired:
                process.kill()
        for log in logs:
            log.close()


if __name__ == "__main__":
    raise SystemExit(main())
