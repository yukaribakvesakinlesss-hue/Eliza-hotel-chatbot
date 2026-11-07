"""Build the AXON site.

Usage:  python3 tools/axon-site/build.py <path-to-tailwindcss-v3-binary>
Env:    AXON_GA4=G-XXXXXXX   optional GA4 measurement ID (empty = analytics off)

Writes axon/index.html, axon/privacy.html, axon/assets/site.css and axon/assets/app.js.
"""
import datetime, hashlib, json, os, re, subprocess, sys

H = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(H, '..', '..', 'axon'))
SITE = 'https://axon-systems-three.vercel.app'
EMAIL = 'gulcanyesilbudak@icloud.com'
PHONE = '+905540248698'
GA4 = os.environ.get('AXON_GA4', '').strip()

# booking-engine strings, kept from the previous site (en + tr)
base = json.load(open(os.path.join(H, 'i18n_base.json')))
ENGINE_KEYS = ['rooms', 'dows', 'cal_in', 'cal_out', 'cal_n', 'up_to', 'spec1', 'spec2', 'spec3', 'b_empty', 'nights', 'night', 'b_room', 'b_extra',
               'b_ota', 'b_tax', 'b_total', 't_sold', 't_max', 't_hold', 'sold', 'leg_best', 'leg_peak', 'leg_sold', 'cal_hint', 'adults', 'reserve', 'frame_url']
engine = {l: {k: base[l][k] for k in ENGINE_KEYS} for l in ('en', 'tr')}

jsonld = {
    '@context': 'https://schema.org',
    '@graph': [
        {'@type': 'Organization', '@id': SITE + '/#org', 'name': 'AXON Systems', 'url': SITE + '/', 'logo': SITE + '/images/favicon.svg',
         'email': EMAIL, 'telephone': PHONE, 'address': {'@type': 'PostalAddress', 'addressLocality': 'Istanbul', 'addressCountry': 'TR'},
         'description': 'AI automation for hotels: guest communication, reservation inquiries and multilingual support.'},
        {'@type': 'WebSite', '@id': SITE + '/#website', 'url': SITE + '/', 'name': 'AXON Systems', 'publisher': {'@id': SITE + '/#org'}, 'inLanguage': ['en', 'tr']},
        {'@type': 'Service', 'name': 'AXON Hotel AI', 'provider': {'@id': SITE + '/#org'}, 'serviceType': 'AI guest communication for hotels', 'areaServed': 'Worldwide',
         'offers': {'@type': 'Offer', 'name': 'Start', 'priceSpecification': {'@type': 'UnitPriceSpecification', 'price': 300, 'priceCurrency': 'USD', 'unitText': 'MONTH',
                    'description': 'Starting price per month. Setup fee and third-party costs are quoted separately.'}}}
    ]
}

css = os.path.join(OUT, 'assets', 'site.css')
os.makedirs(os.path.dirname(css), exist_ok=True)
subprocess.run([sys.argv[1], '-c', os.path.join(H, 'tailwind.config.js'), '-i', os.path.join(H, 'input.css'), '-o', css, '--minify'], check=True)
ver = hashlib.sha1(open(css, 'rb').read()).hexdigest()[:8]

js = open(os.path.join(H, 'app.js')).read()
js = js.replace('__EMAIL__', EMAIL).replace('__GA4__', GA4).replace('__ENGINE__', json.dumps(engine, ensure_ascii=False))
open(os.path.join(OUT, 'assets', 'app.js'), 'w').write(js)
jsver = hashlib.sha1(js.encode()).hexdigest()[:8]
syn = open(os.path.join(H, 'synapse.js')).read()
open(os.path.join(OUT, 'assets', 'synapse.js'), 'w').write(syn)
synver = hashlib.sha1(syn.encode()).hexdigest()[:8]
sysjs = open(os.path.join(H, 'systems.js')).read()
open(os.path.join(OUT, 'assets', 'systems.js'), 'w').write(sysjs)
sysver = hashlib.sha1(sysjs.encode()).hexdigest()[:8]
pajs = open(os.path.join(H, 'personal.js')).read()
open(os.path.join(OUT, 'assets', 'personal.js'), 'w').write(pajs)
paver = hashlib.sha1(pajs.encode()).hexdigest()[:8]

def fill(s):
    return (s.replace('__SITE__', SITE).replace('__EMAIL__', EMAIL).replace('__VER__', ver).replace('__JSVER__', jsver).replace('__SYNVER__', synver).replace('__SYSVER__', sysver).replace('__PAVER__', paver)
             .replace('__DATE__', datetime.date.today().strftime('%d %B %Y')).replace('__JSONLD__', json.dumps(jsonld, ensure_ascii=False)))

for name in ('page.html', 'privacy.html'):
    page = fill(open(os.path.join(H, name)).read())
    for bad in ('—', '__'):
        assert bad not in page.replace('__', '') if bad == '__' else bad not in page, (name, bad)
    out = 'index.html' if name == 'page.html' else name
    open(os.path.join(OUT, out), 'w').write(page)
assert '—' not in js
print('ok css', ver, 'js', jsver)
