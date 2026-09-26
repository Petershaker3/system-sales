#!/usr/bin/env python3
"""
Build script — يدمج نسخة التطوير (dev/) في ملف HTML واحد مستقل (production)
جاهز للمشاركة عبر واتساب/إيميل أو الفتح المباشر بدون سيرفر.

الاستخدام: python3 build.py
المخرج: dist/index.html
"""
import re, os, json

HERE = os.path.dirname(os.path.abspath(__file__))
DEV_INDEX = os.path.join(HERE, 'index.html')
CSS_FILE = os.path.join(HERE, 'css', 'style.css')
JS_DIR = os.path.join(HERE, 'js')
LOAD_ORDER_FILE = os.path.join(HERE, '..', 'load_order.json') if os.path.exists(os.path.join(HERE,'..','load_order.json')) else os.path.join(HERE, 'load_order.json')
DIST_DIR = os.path.join(HERE, '..', 'dist')

def main():
    with open(DEV_INDEX, encoding='utf-8') as f:
        html = f.read()

    # 1) Inline CSS
    with open(CSS_FILE, encoding='utf-8') as f:
        css = f.read()
    html = re.sub(
        r'<link rel="stylesheet" href="css/style\.css">',
        lambda m: f'<style>\n{css}\n</style>',
        html, count=1
    )

    # 2) Inline JS in the exact load order declared in the dev index.html
    #    (extracted directly from the <script src="js/..."> tags to guarantee
    #    the production build always matches whatever index.html declares)
    script_srcs = re.findall(r'<script src="js/([^"]+)"></script>', html)
    if not script_srcs:
        raise SystemExit("No <script src='js/...'> tags found in index.html — aborting.")

    js_parts = []
    for name in script_srcs:
        path = os.path.join(JS_DIR, name)
        with open(path, encoding='utf-8') as f:
            js_parts.append(f.read())
    combined_js = '\n\n'.join(js_parts)

    # Replace the whole run of <script src=...> tags with one inline <script>
    script_block_pattern = r'(?:<script src="js/[^"]+"></script>\s*)+'
    html = re.sub(script_block_pattern, lambda m: f'<script>\n{combined_js}\n</script>', html, count=1)

    os.makedirs(DIST_DIR, exist_ok=True)
    out_path = os.path.join(DIST_DIR, 'index.html')
    with open(out_path, 'w', encoding='utf-8') as f:
        f.write(html)

    print(f"✅ Production build written to: {out_path}")
    print(f"   Size: {len(html):,} chars | JS files combined: {len(script_srcs)}")

if __name__ == '__main__':
    main()
