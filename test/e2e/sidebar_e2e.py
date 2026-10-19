"""Exercise the production frontend in a browser without SSH or AI requests."""

import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time
import unittest
from urllib.request import urlopen

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "output" / "sidebar-e2e"


class SidebarTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        OUTPUT.mkdir(parents=True, exist_ok=True)
        cls.playwright = sync_playwright().start()
        cls.addClassCleanup(cls.playwright.stop)
        channel = os.environ.get("SSHSTAR_TEST_BROWSER_CHANNEL", "msedge" if sys.platform == "win32" else "chromium")
        cls.browser = cls.playwright.chromium.launch(channel=channel, headless=True)
        cls.addClassCleanup(cls.browser.close)

    def setUp(self):
        self.context = self.browser.new_context(
            viewport={"width": 1440, "height": 900},
            permissions=["clipboard-read", "clipboard-write"],
            reduced_motion="reduce",
        )
        self.addCleanup(self.context.close)
        self.page = self.context.new_page()
        self.errors = []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.goto(BASE_URL)
        expect(self.page.get_by_role("heading", name="选择一台服务器开始")).to_be_visible()

    def tearDown(self):
        self.page.screenshot(path=str(OUTPUT / f"{self._testMethodName}.png"))
        self.assertEqual(self.errors, [])

    def button(self, panel):
        return self.page.locator(f'.activity-button[aria-controls="{panel}"]')

    def check_navigation(self):
        buttons = self.page.locator(".activity-button[aria-controls]")
        for button in buttons.all():
            expanded = button.get_attribute("aria-expanded") == "true"
            self.assertEqual("active" in button.get_attribute("class").split(), expanded)
            target = self.page.locator(f'#{button.get_attribute("aria-controls")}')
            self.assertEqual(target.is_visible(), expanded)

    def open_session(self):
        self.page.get_by_role("button", name="添加第一台服务器").click()
        self.page.get_by_label("显示名称", exact=True).fill("Sidebar preview")
        self.page.get_by_label("主机地址", exact=True).fill("127.0.0.1")
        self.page.get_by_role("button", name="保存并连接").click()
        expect(self.page.locator(".workspace-session.active .terminal-status")).to_contain_text("已连接")

    def test_left_panels_toggle_and_restore(self):
        self.check_navigation()
        for panel in ["server-sidebar", "snippet-sidebar", "transfer-sidebar"]:
            button = self.button(panel)
            if button.get_attribute("aria-expanded") != "true":
                button.click()
            self.check_navigation()
            button.click()
            expect(self.page.locator("aside.server-sidebar")).to_have_count(0)
            self.check_navigation()
            button.focus()
            button.press("Space")
            self.check_navigation()
            expect(button).to_have_attribute("aria-expanded", "true")
        self.page.get_by_role("button", name="收起侧边栏", exact=True).click()
        self.check_navigation()
        self.page.get_by_role("button", name="展开侧边栏", exact=True).click()
        expect(self.page.locator("#transfer-sidebar")).to_be_visible()
        self.check_navigation()

    def test_snippets_search_copy_and_revisit(self):
        self.button("snippet-sidebar").click()
        search = self.page.get_by_role("textbox", name="搜索命令片段")
        search.fill("df")
        expect(self.page.locator(".snippet-card")).to_have_count(1)
        self.page.get_by_role("button", name="复制磁盘空间").click()
        expect(self.page.locator(".snippet-copy-status")).to_have_text("命令已复制")
        self.assertEqual(self.page.evaluate("navigator.clipboard.readText()"), "df -hT")
        self.button("transfer-sidebar").click()
        self.button("snippet-sidebar").click()
        expect(search).to_have_value("df")
        search.fill("no-such-command")
        expect(self.page.get_by_text("没有匹配的命令片段", exact=True)).to_be_visible()
        search.fill("")
        expect(self.page.locator(".snippet-card")).to_have_count(6)
        self.check_navigation()

    def test_ai_without_session_has_visible_feedback(self):
        ai = self.page.get_by_role("button", name="AI 助手", exact=True)
        ai.click()
        self.check_navigation()
        ai.click()
        expect(self.page.get_by_role("heading", name="连接服务器后开始对话")).to_be_visible()
        self.button("snippet-sidebar").click()
        self.page.get_by_role("button", name="选择服务器", exact=True).click()
        expect(self.page.locator("#server-sidebar")).to_be_visible()
        self.check_navigation()
        self.page.get_by_role("button", name="关闭助手", exact=True).click()
        self.check_navigation()

    def test_ai_drafts_and_terminals_survive_switching(self):
        self.open_session()
        ai = self.page.get_by_role("button", name="AI 助手", exact=True)
        pane = self.page.locator(".workspace-session.active .ai-pane")
        draft = pane.get_by_role("textbox")
        draft.fill("draft one\nkeep this text")
        pane.evaluate("element => element.dataset.retained = 'yes'")
        terminal = self.page.locator(".workspace-session.active .xterm")
        terminal.evaluate("element => element.dataset.retained = 'yes'")
        ai.click()
        expect(pane).to_be_hidden()
        self.check_navigation()
        self.page.get_by_role("button", name="打开 AI 助手", exact=True).click()
        expect(draft).to_have_value("draft one\nkeep this text")
        expect(pane).to_have_attribute("data-retained", "yes")
        self.button("snippet-sidebar").click()
        self.button("transfer-sidebar").click()
        self.button("server-sidebar").click()
        expect(terminal).to_have_attribute("data-retained", "yes")
        self.page.get_by_role("button", name="为当前服务器新建会话").click()
        expect(self.page.locator(".session-tab")).to_have_count(2)
        second_draft = self.page.locator(".workspace-session.active .ai-pane textarea")
        expect(second_draft).to_have_value("")
        second_draft.fill("draft two")
        self.page.locator(".session-tab").first.click()
        expect(draft).to_have_value("draft one\nkeep this text")
        pane.get_by_role("button", name="关闭助手", exact=True).click()
        ai.click()
        expect(draft).to_have_value("draft one\nkeep this text")
        self.check_navigation()

    def test_narrow_window_keeps_panels_inside_workspace(self):
        self.open_session()
        self.page.get_by_role("separator", name="调整侧边栏宽度").press("End")
        self.page.get_by_role("separator", name="调整 AI 助手宽度").press("End")
        for width in [1440, 1100, 960]:
            self.page.set_viewport_size({"width": width, "height": 700})
            for panel in ["server-sidebar", "snippet-sidebar", "transfer-sidebar"]:
                button = self.button(panel)
                if button.get_attribute("aria-expanded") != "true":
                    button.click()
                self.check_navigation()
                for selector in ["aside.server-sidebar", ".workspace-session.active .operations-column", ".workspace-session.active .ai-pane"]:
                    box = self.page.locator(selector).bounding_box()
                    self.assertGreaterEqual(box["x"], 0)
                    self.assertLessEqual(box["x"] + box["width"], width + 1)
        self.page.screenshot(path=str(OUTPUT / "narrow-960.png"))


if __name__ == "__main__":
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    BASE_URL = f"http://127.0.0.1:{port}"
    OUTPUT.mkdir(parents=True, exist_ok=True)
    with (OUTPUT / "preview.log").open("w") as log:
        server = subprocess.Popen(
            [shutil.which("node"), str(ROOT / "node_modules/vite/bin/vite.js"), "preview", "--host", "127.0.0.1", "--port", str(port), "--strictPort"],
            cwd=ROOT, stdout=log, stderr=subprocess.STDOUT,
        )
        try:
            deadline = time.monotonic() + 20
            while True:
                try:
                    with urlopen(BASE_URL, timeout=1):
                        break
                except OSError:
                    if time.monotonic() >= deadline or server.poll() is not None:
                        raise RuntimeError(f"Preview failed; see {OUTPUT / 'preview.log'}")
                    time.sleep(0.2)
            unittest.main(verbosity=2)
        finally:
            server.terminate()
            server.wait(timeout=10)
