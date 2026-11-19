from pathlib import Path
import qrcode
from PIL import Image
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[1]
assets = root / 'public' / 'images'
qr = qrcode.QRCode(box_size=12, border=3, error_correction=qrcode.constants.ERROR_CORRECT_M)
qr.add_data('https://sshstar.123756.xyz/')
qr.make(fit=True)
qr.make_image(fill_color='#102017', back_color='#f2f6f3').save(assets / 'website-qr.png')
with sync_playwright() as p:
    browser = p.chromium.launch(channel='msedge', headless=True)
    page = browser.new_page(viewport={'width':1600,'height':1000}, device_scale_factor=1, reduced_motion='reduce')
    page.goto('https://sshstar.123756.xyz/', wait_until='networkidle')
    page.screenshot(path=str(assets / 'website.png'))
    Image.open(assets / 'website.png').save(assets / 'website.webp', quality=92)
    (assets / 'website.png').unlink()
    browser.close()
