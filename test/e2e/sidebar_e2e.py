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

    def mock_ai(self):
        self.page.evaluate("""() => {
            window.aiCalls = [];
            window.aiCallbacks = {};
            window.aiListeners = {};
            window.aiSequence = 0;
            window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
            window.__TAURI_INTERNALS__ = {
                metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
                transformCallback(callback) {
                    const id = ++window.aiSequence;
                    window.aiCallbacks[id] = callback;
                    return id;
                },
                async invoke(command, args) {
                    window.aiCalls.push({ command, args });
                    if (command === 'plugin:event|listen') { window.aiListeners[args.event] = args.handler; return 1; }
                    if (command === 'sync_list_key_files') return [];
                    if (command === 'list_rig_models') return Array.from({ length: 40 }, (_, i) => 'review-model-' + i);
                    if (command === 'upload_ai_attachment') {
                        if (window.aiDeferUpload) return new Promise(resolve => { window.finishUpload = resolve; });
                        return { remotePath: '/tmp/review.png', size: 8 };
                    }
                    if (command === 'run_ai_agent') {
                        window.aiRun = args;
                        return new Promise((resolve, reject) => { window.finishAi = resolve; window.failAi = reject; });
                    }
                    if (command === 'resolve_ai_approval' && window.aiDeferApproval) return new Promise(resolve => { window.finishApproval = resolve; });
                    if (command === 'cancel_ai_run') {
                        if (window.aiDeferCancel) return new Promise(resolve => {
                            window.finishCancel = () => { window.failAi('AI 运行已取消'); resolve(null); };
                        });
                        window.failAi('AI 运行已取消');
                    }
                    return null;
                }
            };
            window.emitAi = event => {
                const runId = window.aiRun.runId;
                const callback = window.aiCallbacks[window.aiListeners['ai-agent:' + runId]];
                callback({ event: 'ai-agent:' + runId, id: 1, payload: {
                    runId, sequence: ++window.aiSequence, timestamp: Date.now(), ...event
                }});
            };
        }""")

    def send_ai(self, pane, text):
        self.page.evaluate("window.aiRun = null")
        pane.get_by_role("textbox", name="给 AI 助手发送消息").fill(text)
        pane.get_by_role("button", name="发送", exact=True).click()
        self.page.wait_for_function("!!window.aiRun")

    def finish_ai(self, pane):
        self.page.evaluate("window.finishAi({ content: '检查完成' })")
        expect(pane.get_by_role("button", name="停止助手")).to_have_count(0)

    def settings_provider(self, name):
        return self.page.get_by_role("treeitem", name=name, exact=True).locator(":scope > .provider-tree-row")

    def settings_model(self, provider, model):
        return self.page.get_by_role("treeitem", name=provider, exact=True).get_by_role("treeitem", name=model, exact=True)

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

    def test_ai_provider_tree_links_selection_and_supports_keyboard(self):
        self.open_session()
        self.page.get_by_role("button", name="助手设置", exact=True).click()
        tree = self.page.get_by_role("tree", name="模型提供商列表")
        editor = self.page.locator(".provider-editor")
        first = tree.get_by_role("treeitem", name="默认提供商", exact=True)
        expect(first).to_have_attribute("aria-selected", "true")
        expect(editor).to_have_attribute("aria-label", "提供商配置")
        self.page.get_by_label("API Key", exact=True).fill("tree-primary-key")
        self.settings_model("默认提供商", "gpt-4.1-mini").click()
        expect(editor).to_have_attribute("aria-label", "模型配置")
        expect(self.page.get_by_label("API Key", exact=True)).to_have_count(0)
        self.page.get_by_label("模型 ID", exact=True).fill("primary/model")
        self.page.get_by_label("默认思考强度", exact=True).select_option("high")
        child = self.settings_model("默认提供商", "primary/model")
        expect(child).to_have_attribute("aria-selected", "true")
        child.focus()
        child.press("ArrowLeft")
        expect(first).to_be_focused()
        expect(self.page.get_by_label("API Key", exact=True)).to_have_value("tree-primary-key")
        first.press("ArrowLeft")
        expect(first).to_have_attribute("aria-expanded", "false")
        expect(child).to_have_count(0)
        first.press("ArrowRight")
        expect(first).to_have_attribute("aria-expanded", "true")
        first.press("ArrowRight")
        expect(child).to_be_focused()
        expect(self.page.get_by_label("默认思考强度", exact=True)).to_have_value("high")
        self.page.get_by_role("button", name="添加提供商", exact=True).click()
        expect(editor).to_have_attribute("aria-label", "提供商配置")
        self.page.get_by_label("提供商名称").fill("Other")
        self.page.get_by_label("Base URL").fill("https://other.example/v1")
        self.page.get_by_label("API Key", exact=True).fill("tree-other-key")
        self.settings_model("Other", "未命名模型").click()
        self.page.get_by_label("模型 ID", exact=True).fill("other/model")
        self.page.get_by_label("默认思考强度", exact=True).select_option("medium")
        self.page.get_by_role("button", name="添加模型", exact=True).click()
        expect(self.page.get_by_label("模型 ID", exact=True)).to_have_value("")
        self.page.get_by_label("模型 ID", exact=True).fill("other/temporary")
        self.page.get_by_role("button", name="删除模型 other/temporary", exact=True).click()
        expect(self.page.get_by_label("模型 ID", exact=True)).to_have_value("other/model")
        expect(self.page.get_by_label("默认思考强度", exact=True)).to_have_value("medium")
        self.page.get_by_role("button", name="设为当前模型", exact=True).click()
        for width, height in [(1440, 900), (960, 620)]:
            self.page.set_viewport_size({"width": width, "height": height})
            left = self.page.locator(".provider-tree-panel").bounding_box()
            right = editor.bounding_box()
            self.assertLessEqual(left["x"] + left["width"], right["x"])
            for box in [left, right]:
                self.assertGreaterEqual(box["x"], 0)
                self.assertLessEqual(box["x"] + box["width"], width)
                self.assertLessEqual(box["y"] + box["height"], height)
            self.assertTrue(editor.evaluate("e => e.scrollWidth <= e.clientWidth + 1"))
            self.page.screenshot(path=str(OUTPUT / f"ai-provider-tree-{width}.png"))
        other = self.settings_model("Other", "other/model")
        other.focus()
        other.press("Home")
        expect(first).to_be_focused()
        expect(self.page.get_by_label("API Key", exact=True)).to_have_value("tree-primary-key")
        first.press("End")
        expect(other).to_be_focused()
        expect(self.page.get_by_label("模型 ID", exact=True)).to_have_value("other/model")
        expect(tree.locator('[aria-selected="true"]')).to_have_count(1)
        self.page.get_by_role("button", name="保存设置", exact=True).click()
        self.page.get_by_role("button", name="关闭设置", exact=True).click()
        pane = self.page.locator(".workspace-session.active .ai-pane")
        expect(pane.get_by_label("思考强度", exact=True)).to_have_value("medium")

    def test_ai_provider_settings_and_switching(self):
        self.open_session()
        self.mock_ai()
        self.page.get_by_role("button", name="助手设置", exact=True).click()
        self.page.get_by_label("提供商名称").fill("Primary")
        self.page.get_by_label("API Key", exact=True).fill("primary-key")
        self.settings_model("Primary", "gpt-4.1-mini").click()
        self.page.get_by_label("模型 ID", exact=True).fill("fast-model")
        first_model = self.page.locator(".provider-model-card").first
        for label in ["自动", "极低", "中", "高", "超高"]:
            first_model.get_by_role("checkbox", name=label, exact=True).uncheck()
        first_model.get_by_label("默认思考强度", exact=True).select_option("low")
        self.page.get_by_role("button", name="添加模型", exact=True).click()
        self.page.get_by_label("模型 ID", exact=True).fill("shared-model")
        self.page.get_by_label("默认思考强度", exact=True).select_option("high")
        self.page.get_by_role("button", name="添加提供商", exact=True).click()
        self.page.get_by_label("提供商名称").fill("Secondary")
        self.page.get_by_label("Base URL").fill("https://secondary.example/v1")
        self.page.get_by_label("接口模式").select_option("responses")
        self.page.get_by_label("API Key", exact=True).fill("secondary-key")
        self.settings_model("Secondary", "未命名模型").click()
        self.page.get_by_label("模型 ID", exact=True).fill("shared-model")
        self.page.get_by_label("默认思考强度", exact=True).select_option("medium")
        self.settings_provider("Secondary").click()
        self.page.get_by_role("button", name="获取模型", exact=True).click()
        self.page.get_by_label("搜索提供商模型").fill("review-model-1")
        self.page.get_by_role("button", name="review-model-1", exact=True).click()
        expect(self.page.get_by_role("treeitem", name="Secondary", exact=True).get_by_role("treeitem")).to_have_count(2)
        self.page.screenshot(path=str(OUTPUT / "ai-provider-settings.png"))
        for width in [960, 1440]:
            self.page.set_viewport_size({"width": width, "height": 900})
            self.assertTrue(self.page.locator(".provider-settings").evaluate("e => e.scrollWidth <= e.clientWidth + 1"))
        self.page.get_by_role("button", name="保存设置", exact=True).click()
        expect(self.page.get_by_role("button", name="已保存", exact=True)).to_be_visible()
        self.page.get_by_role("button", name="关闭设置", exact=True).click()
        pane = self.page.locator(".workspace-session.active .ai-pane")
        provider = pane.get_by_label("模型提供商", exact=True)
        effort = pane.get_by_label("思考强度", exact=True)
        model = pane.get_by_role("button", name="选择模型：")
        expect(effort).to_have_value("low")
        self.assertEqual(effort.locator("option").evaluate_all("items => items.map(i => i.value)"), ["none", "low"])
        model.click()
        pane.get_by_role("button", name="shared-model", exact=True).click()
        expect(effort).to_have_value("high")
        effort.select_option("xhigh")
        provider.select_option(label="Secondary")
        expect(effort).to_have_value("medium")
        effort.select_option("high")
        provider.select_option(label="Primary")
        expect(effort).to_have_value("xhigh")
        provider.select_option(label="Secondary")
        expect(effort).to_have_value("high")
        self.page.screenshot(path=str(OUTPUT / "ai-provider-switcher.png"))
        self.send_ai(pane, "检查提供商切换")
        request = self.page.evaluate("window.aiRun")
        self.assertEqual(request["config"]["endpoint"], "https://secondary.example/v1")
        self.assertEqual(request["config"]["apiKey"], "secondary-key")
        self.assertEqual(request["config"]["apiMode"], "responses")
        self.assertEqual(request["config"]["model"], "shared-model")
        self.assertEqual(request["config"]["reasoningEffort"], "high")
        expect(provider).to_be_disabled()
        self.finish_ai(pane)
        stored = self.page.evaluate("window.aiCalls.filter(c => c.command === 'save_ai_config').at(-1).args.config")
        self.assertNotIn("apiKey", stored)
        self.assertTrue(all("apiKey" not in p for p in stored["providers"]))
        key_calls = self.page.evaluate("window.aiCalls.filter(c => c.command === 'store_ai_key').map(c => c.args)")
        self.assertEqual({c["apiKey"] for c in key_calls}, {"primary-key", "secondary-key"})
        self.page.get_by_role("button", name="助手设置", exact=True).click()
        self.page.get_by_role("button", name="移除已保存密钥", exact=True).click()
        expect(self.page.get_by_label("API Key", exact=True)).to_have_value("")
        self.page.get_by_role("button", name="删除提供商", exact=True).click()
        expect(self.page.locator(".provider-tree-branch")).to_have_count(1)
        self.page.get_by_role("button", name="保存设置", exact=True).click()
        self.page.get_by_role("button", name="关闭设置", exact=True).click()
        expect(provider.locator("option")).to_have_count(1)
        expect(effort).to_have_value("xhigh")

    def test_ai_model_and_effort_are_saved_and_sent(self):
        self.open_session()
        self.page.get_by_role("button", name="助手设置", exact=True).click()
        self.settings_model("默认提供商", "gpt-4.1-mini").click()
        self.page.get_by_label("模型 ID", exact=True).fill("test-fast")
        self.page.get_by_role("button", name="添加模型", exact=True).click()
        self.page.get_by_label("模型 ID", exact=True).fill("test-reasoning")
        self.page.get_by_role("button", name="保存设置", exact=True).click()
        self.page.get_by_role("button", name="关闭设置", exact=True).click()
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
        pane.get_by_role("textbox", name="搜索模型 ID").fill("test-fast")
        pane.get_by_role("button", name="test-fast", exact=True).click()
        expect(pane.get_by_label("思考强度", exact=True)).to_have_value("auto")
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

    def test_ai_configured_model_search_and_keyboard_dismiss(self):
        self.open_session()
        self.page.get_by_role("button", name="助手设置", exact=True).click()
        self.settings_model("默认提供商", "gpt-4.1-mini").click()
        self.page.get_by_label("模型 ID", exact=True).fill("private/custom-reasoning-model")
        self.page.get_by_role("button", name="保存设置", exact=True).click()
        self.page.get_by_role("button", name="关闭设置", exact=True).click()
        pane = self.page.locator(".workspace-session.active .ai-pane")
        model = pane.get_by_role("button", name="选择模型：")
        model.click()
        search = pane.get_by_role("textbox", name="搜索模型 ID")
        expect(search).to_be_focused()
        expect(pane.locator(".composer-model-note")).to_contain_text("1 个已配置模型")
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
        self.settings_model("默认提供商", "private/custom-reasoning-model").click()
        expect(self.page.get_by_label("模型 ID", exact=True).first).to_have_value("private/custom-reasoning-model")

    def test_ai_composer_controls_fit_narrow_pane(self):
        self.open_session()
        separator = self.page.get_by_role("separator", name="调整 AI 助手宽度")
        for key in ["Home", "End"]:
            separator.press(key)
            pane = self.page.locator(".workspace-session.active .ai-pane")
            bounds = pane.bounding_box()
            for control in [".composer-add-button", ".approval-policy-control", ".composer-model-trigger", ".composer-provider-control", ".composer-effort-control:not(.composer-provider-control)", ".send-button"]:
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

    def test_ai_model_picker_fits_minimum_window_with_multiline_draft(self):
        self.open_session()
        self.mock_ai()
        self.page.get_by_role("button", name="助手设置", exact=True).click()
        self.page.get_by_role("button", name="获取模型", exact=True).click()
        for index in range(40):
            self.page.get_by_role("button", name=f"review-model-{index}", exact=True).click()
        self.page.get_by_role("button", name="保存设置", exact=True).click()
        self.page.get_by_role("button", name="关闭设置", exact=True).click()
        self.page.set_viewport_size({"width": 960, "height": 620})
        pane = self.page.locator(".workspace-session.active .ai-pane")
        draft = pane.get_by_role("textbox", name="给 AI 助手发送消息")
        draft.fill("\n".join(["等待发送的排查信息"] * 14))
        pane.get_by_role("button", name="选择模型：").click()
        search = pane.get_by_role("textbox", name="搜索模型 ID")
        expect(pane.get_by_role("button", name="review-model-39", exact=True)).to_be_attached()
        for width, height in [(960, 620), (1440, 900), (960, 620)]:
            self.page.set_viewport_size({"width": width, "height": height})
            expect(search).to_be_in_viewport()
            expect(search).to_be_focused()
            self.page.wait_for_function("""() => {
                const picker = document.querySelector('.composer-model-popover').getBoundingClientRect();
                return picker.top >= 0 && picker.bottom <= innerHeight && picker.right <= innerWidth;
            }""")
        self.page.screenshot(path=str(OUTPUT / "ai-model-minimum-window.png"))
        search.fill("review-model-39")
        search.press("Enter")
        expect(draft).to_have_value("\n".join(["等待发送的排查信息"] * 14))
        expect(pane.get_by_role("button", name="选择模型：review-model-39")).to_be_focused()

    def test_ai_history_preserves_drafts_and_confirms_deletion(self):
        self.open_session()
        self.mock_ai()
        pane = self.page.locator(".workspace-session.active .ai-pane")
        draft = pane.get_by_role("textbox", name="给 AI 助手发送消息")
        history = pane.get_by_role("button", name="历史会话", exact=True)
        new = pane.get_by_role("button", name="新建会话", exact=True)
        draft.fill("新会话尚未发送的草稿")
        new.click()
        expect(draft).to_have_value("新会话尚未发送的草稿")
        self.send_ai(pane, "第一轮排查")
        self.finish_ai(pane)
        draft.fill("第一轮未发送的补充信息")
        history.click()
        pane.locator(".ai-history-select").first.click()
        expect(draft).to_have_value("第一轮未发送的补充信息")
        expect(draft).to_be_focused()
        new.click()
        expect(draft).to_have_value("")
        draft.fill("新会话的另一份草稿")
        history.click()
        pane.locator(".ai-history-select").first.click()
        expect(draft).to_have_value("第一轮未发送的补充信息")
        new.click()
        expect(draft).to_have_value("新会话的另一份草稿")
        self.send_ai(pane, "第二轮排查")
        self.finish_ai(pane)
        draft.fill("第二轮的草稿")
        history.click()
        pane.locator(".ai-history-select").filter(has_text="第一轮排查").click()
        expect(draft).to_have_value("第一轮未发送的补充信息")
        history.click()
        pane.locator(".ai-history-select").first.focus()
        self.page.keyboard.press("Escape")
        expect(history).to_be_focused()
        history.click()
        item = pane.locator(".ai-history-item").filter(has_text="第一轮排查")
        delete = item.get_by_role("button", name="删除会话：第一轮排查", exact=True)
        delete.click()
        expect(pane.locator(".ai-history-item")).to_have_count(2)
        expect(pane.locator(".ai-message")).to_have_count(2)
        expect(item.get_by_role("button", name="取消删除", exact=True)).to_be_focused()
        pane.screenshot(path=str(OUTPUT / "ai-history-delete-confirm.png"))
        self.page.keyboard.press("Escape")
        expect(delete).to_be_focused()
        expect(pane.get_by_role("dialog", name="AI 历史会话")).to_be_visible()
        delete.click()
        item.get_by_role("button", name="确认删除", exact=True).click()
        expect(pane.locator(".ai-history-item")).to_have_count(1)
        expect(pane.locator(".ai-history-select").first).to_be_focused()
        expect(pane.locator(".ai-message")).to_have_count(0)
        pane.locator(".ai-history-select").first.click()
        expect(draft).to_have_value("第二轮的草稿")

    def test_ai_attachment_upload_keeps_its_original_draft(self):
        self.open_session()
        self.mock_ai()
        pane = self.page.locator(".workspace-session.active .ai-pane")
        self.send_ai(pane, "带附件的排查")
        self.finish_ai(pane)
        draft = pane.get_by_role("textbox", name="给 AI 助手发送消息")
        draft.fill("请查看附件")
        self.page.evaluate("window.aiDeferUpload = true")
        pane.locator('input[type="file"]').set_input_files({"name": "review.png", "mimeType": "image/png", "buffer": bytes.fromhex("89504e470d0a1a0a")})
        expect(pane.locator(".attachment-reference.uploading")).to_be_visible()
        pane.get_by_role("button", name="新建会话", exact=True).click()
        expect(pane.locator(".attachment-reference")).to_have_count(0)
        self.page.evaluate("window.finishUpload({ remotePath: '/tmp/review.png', size: 8 })")
        expect(pane.locator(".attachment-reference")).to_have_count(0)
        pane.get_by_role("button", name="历史会话", exact=True).click()
        pane.locator(".ai-history-select").first.click()
        expect(draft).to_have_value("请查看附件")
        expect(pane.locator(".attachment-reference.ready")).to_contain_text("/tmp/review.png")
        expect(pane.get_by_role("button", name="发送", exact=True)).to_be_enabled()

    def test_ai_stream_failure_shows_cause_and_restores_request_for_editing(self):
        self.page.clock.install()
        self.open_session()
        self.mock_ai()
        pane = self.page.locator(".workspace-session.active .ai-pane")
        self.send_ai(pane, "分析当前部署")
        self.page.evaluate("window.emitAi({ type: 'text_delta', delta: '磁盘检查完成，正在检查服务。' })")
        self.page.evaluate("window.failAi('HTTP 429: 请求过多，请稍后重试')")
        error = pane.locator(".ai-error-feedback")
        expect(error).to_contain_text("HTTP 429")
        expect(error).to_contain_text("5 秒后自动重试")
        expect(pane.locator(".markdown-body")).to_contain_text("磁盘检查完成")
        expect(pane.locator(".ai-status")).to_contain_text("请求过多")
        draft = pane.get_by_role("textbox", name="给 AI 助手发送消息")
        draft.fill("已有的新草稿")
        edit = error.get_by_role("button", name="重新编辑请求", exact=True)
        expect(edit).to_be_disabled()
        draft.fill("")
        edit.click()
        expect(draft).to_have_value("分析当前部署")
        expect(draft).to_be_focused()
        self.page.clock.run_for(6_000)
        self.assertEqual(self.page.evaluate("window.aiCalls.filter(c => c.command === 'run_ai_agent').length"), 1)
        pane.screenshot(path=str(OUTPUT / "ai-stream-failure.png"))

    def test_ai_failure_retries_after_five_seconds_and_can_be_cancelled(self):
        self.page.clock.install()
        self.open_session()
        self.mock_ai()
        pane = self.page.locator(".workspace-session.active .ai-pane")
        self.send_ai(pane, "检查服务状态")
        original = self.page.evaluate("window.aiRun")
        raw_error = 'HTTP 503\n{"error":{"message":"upstream unavailable","request_id":"req-123"}}'
        self.page.evaluate("error => window.failAi(error)", raw_error)
        error = pane.locator(".ai-error-feedback")
        expect(error).to_have_attribute("role", "alert")
        expect(error).to_contain_text(raw_error)
        expect(error).to_contain_text("5 秒后自动重试")
        pane.screenshot(path=str(OUTPUT / "ai-retry-countdown.png"))
        self.page.clock.run_for(4_000)
        expect(error).to_contain_text("1 秒后自动重试")
        self.assertEqual(self.page.evaluate("window.aiCalls.filter(c => c.command === 'run_ai_agent').length"), 1)
        self.page.clock.run_for(1_000)
        expect(pane.get_by_role("button", name="停止助手")).to_be_visible()
        retried = self.page.evaluate("window.aiRun")
        self.assertEqual(retried["messages"], original["messages"])
        self.assertEqual(retried["conversationId"], original["conversationId"])
        self.assertNotEqual(retried["runId"], original["runId"])
        self.page.evaluate("window.failAi('connection reset by peer')")
        expect(error).to_contain_text("5 秒后自动重试")
        error.get_by_role("button", name="取消自动重试", exact=True).click()
        self.page.clock.run_for(10_000)
        expect(error).to_contain_text("connection reset by peer")
        expect(error).not_to_contain_text("秒后自动重试")
        self.assertEqual(self.page.evaluate("window.aiCalls.filter(c => c.command === 'run_ai_agent').length"), 2)

    def test_ai_approval_announces_pending_state_and_uses_readable_text(self):
        self.open_session()
        self.mock_ai()
        self.page.set_viewport_size({"width": 960, "height": 620})
        pane = self.page.locator(".workspace-session.active .ai-pane")
        self.send_ai(pane, "检查服务状态")
        focus = pane.get_by_role("button", name="历史会话", exact=True)
        focus.focus()
        self.page.evaluate("window.emitAi({ type: 'approval_required', approvalId: 'approval', actionId: 'tool', tool: 'execute_command', command: 'systemctl restart example-service', reason: '重启服务以应用新配置', arguments: {} })")
        expect(pane.locator(".ai-status")).to_contain_text("需要你批准执行命令")
        expect(pane.locator(".ai-run-status")).to_have_attribute("data-state", "approval")
        expect(pane.locator(".ai-run-status-copy strong")).to_have_text("等待审批")
        expect(pane.locator(".ai-status")).to_have_attribute("aria-live", "polite")
        expect(focus).to_be_focused()
        expect(pane.locator(".thinking-progress")).to_have_count(0)
        sizes = pane.locator(".approval-call > code, .approval-call > p, .approval-call-actions button").evaluate_all("els => els.map(e => parseFloat(getComputedStyle(e).fontSize))")
        self.assertTrue(all(size >= 12 for size in sizes), sizes)
        self.assertFalse(pane.locator(".approval-call").evaluate("e => e.scrollWidth > e.clientWidth"))
        pane.screenshot(path=str(OUTPUT / "ai-approval-readable.png"))
        self.page.evaluate("window.aiDeferApproval = true")
        pane.get_by_role("button", name="批准并继续", exact=True).click()
        expect(pane.locator(".ai-run-status")).to_have_attribute("data-state", "reviewing")
        self.page.evaluate("window.finishApproval(null)")
        expect(pane.locator(".ai-status")).to_contain_text("正在执行任务")
        self.finish_ai(pane)
        expect(pane.locator(".ai-status")).to_contain_text("已完成回复")

    def test_ai_run_status_tracks_activity_elapsed_time_and_terminal_states(self):
        self.page.clock.install()
        self.open_session()
        self.mock_ai()
        self.page.set_viewport_size({"width": 960, "height": 620})
        pane = self.page.locator(".workspace-session.active .ai-pane")
        status = pane.get_by_role("group", name="助手运行状态", exact=True)
        expect(status).to_have_attribute("data-state", "idle")
        expect(status.locator(".ai-run-elapsed")).to_have_count(0)
        self.send_ai(pane, "查看服务运行状态")
        expect(status).to_have_attribute("data-state", "starting")
        self.page.evaluate("window.emitAi({ type: 'run_started' })")
        expect(status).to_have_attribute("data-state", "thinking")
        self.page.evaluate("window.emitAi({ type: 'reasoning_delta', delta: '先检查进程和服务状态。' })")
        expect(status).to_have_attribute("data-state", "thinking")
        self.page.evaluate("window.emitAi({ type: 'text_delta', delta: '开始检查服务。' })")
        expect(status).to_have_attribute("data-state", "responding")
        self.page.evaluate("window.emitAi({ type: 'tool_started', actionId: 'tool-1', tool: 'execute_command', command: 'systemctl status example-service', arguments: {}, startedAt: Date.now() })")
        expect(status).to_have_attribute("data-state", "executing")
        expect(status).to_contain_text("systemctl status example-service")
        self.page.clock.fast_forward(65_000)
        elapsed = status.locator(".ai-run-elapsed > span")
        minutes, seconds = map(int, elapsed.inner_text().split(":"))
        self.assertGreaterEqual(minutes * 60 + seconds, 65)
        self.assertFalse(status.evaluate("e => e.scrollWidth > e.clientWidth"))
        pane.screenshot(path=str(OUTPUT / "ai-run-status-executing.png"))
        self.page.evaluate("window.emitAi({ type: 'tool_finished', actionId: 'tool-1', tool: 'execute_command', command: 'systemctl status example-service', output: 'active (running)', exitCode: 0, status: 'completed', startedAt: Date.now() - 65000, completedAt: Date.now() })")
        expect(status).to_have_attribute("data-state", "thinking")
        self.page.evaluate("window.emitAi({ type: 'text_delta', delta: '服务运行正常。' })")
        expect(status).to_have_attribute("data-state", "responding")
        self.finish_ai(pane)
        expect(status).to_have_attribute("data-state", "completed")
        finished_elapsed = elapsed.inner_text()
        self.page.clock.fast_forward(3_000)
        expect(elapsed).to_have_text(finished_elapsed)
        self.send_ai(pane, "再次检查")
        self.page.evaluate("window.failAi('HTTP 429: 请稍后重试')")
        expect(status).to_have_attribute("data-state", "error")
        expect(status).to_contain_text("HTTP 429")
        self.send_ai(pane, "停止前的检查")
        self.page.evaluate("window.aiDeferCancel = true")
        stop = pane.get_by_role("button", name="停止助手", exact=True)
        stop.click()
        expect(status).to_have_attribute("data-state", "stopping")
        expect(stop).to_be_disabled()
        self.page.evaluate("window.finishCancel()")
        expect(status).to_have_attribute("data-state", "cancelled")
        pane.screenshot(path=str(OUTPUT / "ai-run-status-stopped.png"))

    def test_session_context_menu_uses_clicked_tab_and_preserves_retained_session(self):
        self.open_session()
        tabs = self.page.get_by_role("tab", selected=False)
        all_tabs = self.page.get_by_role("tab")
        draft = self.page.locator(".workspace-session.active .ai-pane textarea")
        draft.fill("保留的会话草稿")
        first_id = all_tabs.first.get_attribute("id")
        self.page.locator(".workspace-session.active .xterm").evaluate("e => e.dataset.retained = 'yes'")
        for _ in range(2):
            self.page.get_by_role("button", name="为当前服务器新建会话").click()
        active_id = self.page.get_by_role("tab", selected=True).get_attribute("id")
        tabs.first.click(button="right")
        expect(self.page.get_by_role("tab", selected=True)).to_have_attribute("id", active_id)
        expect(self.page.get_by_role("menuitem", name="关闭左侧标签页")).to_be_disabled()
        self.page.get_by_role("menuitem", name="新建同服务器会话").click()
        expect(all_tabs).to_have_count(4)
        all_tabs.last.click(button="right")
        self.page.get_by_role("menuitem", name="关闭当前标签页").click()
        expect(all_tabs).to_have_count(3)
        expect(self.page.get_by_role("tab", selected=True)).to_have_attribute("id", active_id)
        all_tabs.first.click(button="right")
        self.page.get_by_role("menuitem", name="关闭其他标签页").click()
        expect(all_tabs).to_have_count(1)
        expect(self.page.get_by_role("tab", selected=True)).to_have_attribute("id", first_id)
        expect(self.page.locator(".workspace-session.active .ai-pane textarea")).to_have_value("保留的会话草稿")
        expect(self.page.locator(".workspace-session.active .xterm")).to_have_attribute("data-retained", "yes")
        all_tabs.first.click(button="right")
        self.page.screenshot(path=str(OUTPUT / "session-context-menu.png"))
        for name in ["关闭其他标签页", "关闭左侧标签页", "关闭右侧标签页"]:
            expect(self.page.get_by_role("menuitem", name=name)).to_be_disabled()
        self.page.get_by_role("menuitem", name="关闭全部标签页").click()
        expect(all_tabs).to_have_count(0)
        expect(self.page.get_by_role("heading", name="选择一台服务器开始")).to_be_visible()
        expect(self.page.get_by_role("button", name="为当前服务器新建会话")).to_be_disabled()

    def test_session_context_menu_closes_left_right_and_inactive_tab(self):
        self.open_session()
        tabs = self.page.get_by_role("tab")
        for _ in range(3):
            self.page.get_by_role("button", name="为当前服务器新建会话").click()
        second_id = tabs.nth(1).get_attribute("id")
        tabs.nth(1).click(button="right")
        self.page.get_by_role("menuitem", name="关闭右侧标签页").click()
        expect(tabs).to_have_count(2)
        expect(self.page.get_by_role("tab", selected=True)).to_have_attribute("id", second_id)
        for _ in range(2):
            self.page.get_by_role("button", name="为当前服务器新建会话").click()
        third_id = tabs.nth(2).get_attribute("id")
        fourth_id = tabs.nth(3).get_attribute("id")
        tabs.nth(2).click(button="right")
        self.page.get_by_role("menuitem", name="关闭左侧标签页").click()
        expect(tabs).to_have_count(2)
        expect(tabs.first).to_have_attribute("id", third_id)
        expect(self.page.get_by_role("tab", selected=True)).to_have_attribute("id", fourth_id)
        tabs.first.click(button="right")
        self.page.get_by_role("menuitem", name="关闭当前标签页").click()
        expect(tabs).to_have_count(1)
        expect(self.page.get_by_role("tab", selected=True)).to_have_attribute("id", fourth_id)
        self.page.get_by_role("button", name="关闭会话 Sidebar preview 4", exact=True).click()
        expect(tabs).to_have_count(0)

    def test_session_context_menu_keyboard_dismissal_and_viewport_bounds(self):
        self.open_session()
        self.page.get_by_role("button", name="为当前服务器新建会话").click()
        tabs = self.page.get_by_role("tab")
        tabs.last.focus()
        tabs.last.press("Home")
        expect(tabs.first).to_be_focused()
        expect(tabs.first).to_have_attribute("aria-selected", "true")
        tabs.first.press("Shift+F10")
        menu = self.page.get_by_role("menu")
        expect(menu).to_be_visible()
        expect(self.page.get_by_role("menuitem", name="新建同服务器会话")).to_be_focused()
        menu.press("ArrowDown")
        expect(self.page.get_by_role("menuitem", name="关闭当前标签页")).to_be_focused()
        menu.press("End")
        expect(self.page.get_by_role("menuitem", name="关闭全部标签页")).to_be_focused()
        menu.press("Escape")
        expect(menu).to_have_count(0)
        expect(tabs.first).to_be_focused()
        tabs.first.press("ArrowLeft")
        expect(tabs.last).to_be_focused()
        tabs.last.press("Shift+F10")
        menu.press("Tab")
        expect(menu).to_have_count(0)
        expect(tabs.last).to_be_focused()
        tabs.last.click(button="right")
        self.page.get_by_role("heading", name="服务器", exact=True).click()
        expect(menu).to_have_count(0)
        self.page.set_viewport_size({"width": 960, "height": 620})
        self.page.evaluate("() => new Promise(requestAnimationFrame)")
        tabs.last.evaluate("e => e.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, cancelable: true, clientX: 959, clientY: 619}))")
        expect(menu).to_be_visible()
        box = menu.bounding_box()
        self.assertGreaterEqual(box["x"], 0)
        self.assertGreaterEqual(box["y"], 0)
        self.assertLessEqual(box["x"] + box["width"], 960)
        self.assertLessEqual(box["y"] + box["height"], 620)
        self.page.screenshot(path=str(OUTPUT / "session-context-menu-edge.png"))
        self.page.set_viewport_size({"width": 1000, "height": 700})
        expect(menu).to_have_count(0)
        tabs.last.focus()
        tabs.last.press("Delete")
        expect(tabs).to_have_count(1)
        expect(tabs.first).to_be_focused()

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
