"""Build axon/index.html and axon/assets/site.css from page.html + i18n JSON.
Usage: python3 tools/axon-site/build.py <path-to-tailwindcss-binary>"""
import json, os, subprocess, sys, hashlib
H = os.path.dirname(os.path.abspath(__file__)); OUT = os.path.join(H, '..', '..', 'axon')
base = json.load(open(os.path.join(H, 'i18n_base.json'))); extra = json.load(open(os.path.join(H, 'i18n_extra.json')))
for l in base: base[l].update(extra[l])
css = os.path.join(OUT, 'assets', 'site.css'); os.makedirs(os.path.dirname(css), exist_ok=True)
subprocess.run([sys.argv[1], '-c', os.path.join(H, 'tailwind.config.js'), '-i', os.path.join(H, 'input.css'), '-o', css, '--minify'], check=True)
ver = hashlib.sha1(open(css, 'rb').read()).hexdigest()[:8]
page = open(os.path.join(H, 'page.html')).read()
page = page.replace('__I18N__', json.dumps(base, ensure_ascii=False)).replace('__VER__', ver)
assert '—' not in page, 'em dash in page'
open(os.path.join(OUT, 'index.html'), 'w').write(page)
print('ok', ver, len(page))
