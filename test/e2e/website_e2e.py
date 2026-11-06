"""Exercise the production product website; optionally target its deployed URL."""

import hashlib
import json
from pathlib import Path
import sys
import unittest
from urllib.request import urlopen

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / 'output' / 'website-qa'
BASE_URL = (sys.argv.pop(1) if len(sys.argv) > 1 and sys.argv[1].startswith('http') else 'http://127.0.0.1:4321').rstrip('/')


class WebsiteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        OUTPUT.mkdir(parents=True, exist_ok=True)
        cls.playwright = sync_playwright().start()
        cls.addClassCleanup(cls.playwright.stop)
        cls.browser = cls.playwright.chromium.launch(channel='msedge', headless=True)
        cls.addClassCleanup(cls.browser.close)

    def setUp(self):
        self.context = self.browser.new_context(
            viewport={'width': 1440, 'height': 1000},
            permissions=['clipboard-read', 'clipboard-write'],
            reduced_motion='reduce',
        )
        self.addCleanup(self.context.close)
        self.page = self.context.new_page()
        self.errors = []
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        response = self.page.goto(BASE_URL)
        self.assertEqual(response.status, 200)
        self.page.locator('#preview-image').wait_for(state='visible')

    def tearDown(self):
        self.assertEqual(self.errors, [])

    def test_responsive_and_images(self):
        for width in [1440, 1024, 768, 375, 320]:
            self.page.set_viewport_size({'width': width, 'height': 1000})
            self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), width)
            expect(self.page.get_by_role('heading', level=1)).to_be_visible()
            self.page.screenshot(path=str(OUTPUT / f'website-{width}.png'), full_page=True)
        self.assertEqual(self.page.evaluate('getComputedStyle(document.documentElement).scrollBehavior'), 'auto')
        self.assertTrue(self.page.locator('#preview-image').evaluate('(image) => image.complete && image.naturalWidth > 0'))
        self.assertNotIn('{{', self.page.content())
        self.assertEqual(self.page.locator('link[rel=canonical]').get_attribute('href'), 'https://sshstar.123756.xyz/')
        self.page.set_viewport_size({'width': 1440, 'height': 1000})
        self.page.screenshot(path=str(OUTPUT / 'desktop-top.png'))

    def test_preview_tabs_pointer_and_keyboard(self):
        for name, image in [('远程文件', 'files.webp'), ('模型配置', 'models.webp'), ('工作台', 'workspace.webp')]:
            tab = self.page.get_by_role('tab', name=name)
            tab.click()
            expect(tab).to_have_attribute('aria-selected', 'true')
            self.page.wait_for_function('(name) => { const image = document.querySelector("#preview-image"); return image.src.endsWith(name) && image.complete && image.naturalWidth > 0; }', arg=image)
            expect(self.page.get_by_role('tabpanel')).to_have_attribute('aria-labelledby', tab.get_attribute('id'))
        self.page.get_by_role('tab', name='工作台').press('ArrowRight')
        expect(self.page.get_by_role('tab', name='远程文件')).to_be_focused()
        self.page.keyboard.press('End')
        expect(self.page.get_by_role('tab', name='模型配置')).to_have_attribute('aria-selected', 'true')
        self.page.keyboard.press('Home')
        expect(self.page.get_by_role('tab', name='工作台')).to_have_attribute('aria-selected', 'true')

    def test_mobile_navigation(self):
        self.page.set_viewport_size({'width': 375, 'height': 812})
        toggle = self.page.get_by_role('button', name='切换导航菜单')
        toggle.click()
        expect(toggle).to_have_attribute('aria-expanded', 'true')
        self.page.get_by_role('navigation', name='主导航').get_by_role('link', name='功能特性').click()
        expect(toggle).to_have_attribute('aria-expanded', 'false')
        expect(self.page).to_have_url(BASE_URL + '/#features')
        toggle.click()
        self.page.keyboard.press('Escape')
        expect(toggle).to_be_focused()
        expect(toggle).to_have_attribute('aria-expanded', 'false')
        toggle.click()
        self.page.set_viewport_size({'width': 1024, 'height': 900})
        expect(self.page.locator('.menu-toggle')).to_have_attribute('aria-expanded', 'false')

    def test_faq_and_checksum_copy(self):
        summary = self.page.locator('.faq-list summary').first
        summary.focus()
        self.page.keyboard.press('Enter')
        expect(self.page.locator('.faq-list details').first).to_have_attribute('open', '')
        self.page.get_by_role('button', name='复制 EXE 校验值').click()
        expect(self.page.get_by_role('status')).to_contain_text('已复制')
        copied = self.page.evaluate('navigator.clipboard.readText()')
        self.assertEqual(copied, self.page.locator('#copy-checksum').get_attribute('data-checksum'))
        for link in self.page.locator('a[href^="#"]').all():
            target = link.get_attribute('href')[1:]
            if target:
                self.assertEqual(self.page.locator(f'[id="{target}"]').count(), 1)

    def test_download_integrity(self):
        with urlopen(BASE_URL + '/release.json', timeout=30) as response:
            release = json.load(response)
        for kind in ['exe', 'msi']:
            asset = release[kind]
            with urlopen(BASE_URL + '/downloads/' + asset['name'], timeout=60) as response:
                body = response.read()
            self.assertEqual(len(body), asset['size'])
            self.assertEqual(hashlib.sha256(body).hexdigest(), asset['sha256'])
        with urlopen(BASE_URL + '/downloads/SHA256SUMS.txt', timeout=30) as response:
            checksums = response.read().decode()
        self.assertIn(release['exe']['sha256'], checksums)
        self.assertIn(release['msi']['sha256'], checksums)

    def test_without_javascript(self):
        context = self.browser.new_context(java_script_enabled=False)
        self.addCleanup(context.close)
        page = context.new_page()
        page.goto(BASE_URL)
        expect(page.get_by_role('heading', level=1)).to_be_visible()
        self.assertEqual(page.locator('a[download][href$=".exe"]').count(), 2)
        page.locator('.faq-list summary').first.click()
        expect(page.locator('.faq-list details').first).to_have_attribute('open', '')

    def test_accessibility(self):
        axe = OUTPUT / 'node_modules' / 'axe-core' / 'axe.min.js'
        if not axe.exists() or BASE_URL.startswith('https:'):
            self.skipTest('Optional local axe-core audit; install into output/website-qa')
        self.page.add_script_tag(path=str(axe))
        result = self.page.evaluate('async () => await axe.run(document, {runOnly: {type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"]}})')
        (OUTPUT / 'accessibility.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        self.assertEqual([(item['id'], [node['target'] for node in item['nodes']]) for item in result['violations']], [])


if __name__ == '__main__':
    unittest.main(verbosity=2)
