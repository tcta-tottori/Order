#!/usr/bin/env python3
"""Bump the app version everywhere it must stay in sync (index.html, app.js, sw.js)."""
import re, sys, pathlib
root = pathlib.Path(__file__).resolve().parent.parent
ver = sys.argv[1] if len(sys.argv) > 1 else None
if not ver or not re.match(r'^\d+\.\d+\.\d+$', ver):
    sys.exit('usage: bump-version.py X.Y.Z')
p = root / 'index.html'; s = p.read_text(encoding='utf-8')
s = re.sub(r'<html lang="ja"( data-ver="[^"]*")?>', f'<html lang="ja" data-ver="{ver}">', s)
s = re.sub(r'(css/app\.css|js/[a-z-]+\.js)(\?v=[^"]*)?"', lambda m: f'{m.group(1)}?v={ver}"', s)
p.write_text(s, encoding='utf-8')
p = root / 'js' / 'app.js'; s = p.read_text(encoding='utf-8')
s = re.sub(r"const APP_VERSION = '[^']*';", f"const APP_VERSION = '{ver}';", s); p.write_text(s, encoding='utf-8')
p = root / 'sw.js'; s = p.read_text(encoding='utf-8')
s = re.sub(r"const VERSION = '[^']*';", f"const VERSION = '{ver}';", s); p.write_text(s, encoding='utf-8')
print('version set to', ver)
