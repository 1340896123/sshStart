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

    def test_ai_model_and_effort_are_saved_and_sent(self):
        self.open_session()
        # Mock desktop IPC only; exercise the production React UI and agent hook.
        self.page.evaluate("""() => {
            window.aiCalls = [];
            window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
            window.__TAURI_INTERNALS__ = {
                metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
                transformCallback() { return 1; },
                async invoke(command, args) {
                    window.aiCalls.push({ command, args });
                    if (command === 'list_rig_models') return ['test-fast', 'test-reasoning', 'test-fast'];
                    if (command === 'plugin:event|listen') return 1;
                    if (command === 'run_ai_agent') return new Promise(resolve => { window.finishAi = resolve; });
                    return null;
                }
            };
        }""")
        pane = self.page.locator(".workspace-session.active .ai-pane")
        expect(pane.get_by_role("button", name="允许使用工具", exact=True)).to_have_count(0)
        permissions = pane.get_by_label("助手权限", exact=True)
        expect(permissions).to_have_value("request")
        permissions.select_option("chat-only")
        model = pane.get_by_role("button", name="选择模型：")
        model.click()
        picker = pane.get_by_role("dialog", name="选择对话模型")
        expect(picker.get_by_role("button", name="test-fast", exact=True)).to_have_count(1)
        picker.get_by_role("button", name="test-reasoning", exact=True).click()
        expect(model).to_have_attribute("aria-label", "选择模型：test-reasoning")
        pane.get_by_label("思考强度", exact=True).select_option("xhigh")
        self.page.wait_for_function("window.aiCalls.some(c => c.command === 'save_ai_config' && c.args.config.model === 'test-reasoning' && c.args.config.reasoningEffort === 'xhigh')")
        draft = pane.get_by_role("textbox", name="给 AI 助手发送消息")
        draft.fill("检查服务状态")
        draft.press("Shift+Enter")
        expect(draft).to_have_value("检查服务状态\n")
        draft.press("Enter")
        expect(pane.get_by_role("button", name="停止助手")).to_be_visible()
        expect(model).to_be_disabled()
        expect(pane.get_by_label("思考强度", exact=True)).to_be_disabled()
        expect(permissions).to_be_disabled()
        request = self.page.evaluate("window.aiCalls.find(c => c.command === 'run_ai_agent').args")
        self.assertFalse(request["allowTools"])
        self.assertEqual(request["config"]["model"], "test-reasoning")
        self.assertEqual(request["config"]["reasoningEffort"], "xhigh")
        self.assertEqual(request["messages"][-1]["content"], "检查服务状态")
        self.page.evaluate("""window.finishAi({
            content: '服务运行正常。\\n\\n- CPU 使用率：12%\\n- 内存使用率：38%\\n\\n可以继续查看日志，或检查最近一次部署。',
            usage: { available: true, inputTokens: 500, outputTokens: 80, totalTokens: 580, cachedTokens: 100, reasoningTokens: 20, contextTokens: 500, requests: 1 }
        })""")
        expect(pane.locator(".markdown-body")).to_contain_text("服务运行正常")
        expect(model).to_be_enabled()
        pane.screenshot(path=str(OUTPUT / "ai-chat.png"))
        model.click()
        pane.get_by_role("textbox", name="搜索或输入模型 ID").fill("test-fast")
        pane.get_by_role("button", name="test-fast", exact=True).click()
        expect(pane.get_by_label("思考强度", exact=True)).to_have_value("xhigh")
        for policy in ["request", "full-access"]:
            permissions.select_option(policy)
            draft.fill("继续检查")
            draft.press("Enter")
            self.page.wait_for_function("count => window.aiCalls.filter(c => c.command === 'run_ai_agent').length === count", arg=2 if policy == "request" else 3)
            request = self.page.evaluate("window.aiCalls.filter(c => c.command === 'run_ai_agent').at(-1).args")
            self.assertTrue(request["allowTools"])
            self.assertEqual(request["approvalPolicy"], policy)
            expect(permissions).to_be_enabled()
            expect(permissions.locator('option[value="chat-only"]')).to_have_attribute("disabled", "")
            self.page.evaluate("window.finishAi({ content: '检查完成', usage: { available: false } })")
            expect(pane.get_by_role("button", name="发送", exact=True)).to_be_visible()

    def test_ai_custom_model_fallback_and_keyboard_dismiss(self):
        self.open_session()
        pane = self.page.locator(".workspace-session.active .ai-pane")
        model = pane.get_by_role("button", name="选择模型：")
        model.click()
        search = pane.get_by_role("textbox", name="搜索或输入模型 ID")
        expect(search).to_be_focused()
        expect(pane.get_by_role("status")).to_contain_text("可输入模型 ID")
        search.fill("private/custom-reasoning-model")
        search.press("Enter")
        expect(model).to_have_attribute("aria-label", "选择模型：private/custom-reasoning-model")
        effort = pane.get_by_label("思考强度", exact=True)
        for value in ["none", "minimal", "low", "medium", "high", "xhigh", "auto"]:
            effort.select_option(value)
            expect(effort).to_have_value(value)
        model.click()
        search.press("Escape")
        expect(pane.get_by_role("dialog", name="选择对话模型")).to_have_count(0)
        expect(model).to_be_focused()
        model.click()
        pane.get_by_role("textbox", name="给 AI 助手发送消息").click()
        expect(pane.get_by_role("dialog", name="选择对话模型")).to_have_count(0)
        pane.get_by_role("button", name="助手设置", exact=True).click()
        expect(self.page.locator(".settings-model-control input").first).to_have_value("private/custom-reasoning-model")

    def test_ai_composer_controls_fit_narrow_pane(self):
        self.open_session()
        separator = self.page.get_by_role("separator", name="调整 AI 助手宽度")
        for key in ["Home", "End"]:
            separator.press(key)
            pane = self.page.locator(".workspace-session.active .ai-pane")
            bounds = pane.bounding_box()
            for control in [".composer-add-button", ".approval-policy-control", ".composer-model-trigger", ".composer-effort-control", ".send-button"]:
                box = pane.locator(control).bounding_box()
                self.assertGreaterEqual(box["x"], bounds["x"])
                self.assertLessEqual(box["x"] + box["width"], bounds["x"] + bounds["width"])
            pane.get_by_role("button", name="选择模型：").click()
            picker = pane.get_by_role("dialog", name="选择对话模型")
            expect(picker).to_be_visible()
            box = picker.bounding_box()
            self.assertGreaterEqual(box["x"], bounds["x"])
            self.assertLessEqual(box["x"] + box["width"], bounds["x"] + bounds["width"])
            pane.screenshot(path=str(OUTPUT / f"ai-composer-{key.lower()}.png"))
            self.page.keyboard.press("Escape")

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
