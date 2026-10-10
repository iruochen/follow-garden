"""Check release asset dimensions, local website links and language coverage."""
from pathlib import Path
import json
import re
import struct

ROOT=Path(__file__).resolve().parents[1]
def dimensions(path):
    data=path.read_bytes()
    if data.startswith(b'\x89PNG\r\n\x1a\n'):return struct.unpack('>II',data[16:24])
    assert data[:2]==b'\xff\xd8',path
    i=2
    while i<len(data):
        assert data[i]==255,path
        while data[i]==255:i+=1
        marker=data[i];i+=1
        if marker in (0xd8,0xd9) or 0xd0<=marker<=0xd7:continue
        length=int.from_bytes(data[i:i+2],'big')
        if marker in (0xc0,0xc1,0xc2):
            height,width=struct.unpack('>HH',data[i+3:i+7]);return width,height
        i+=length
    raise AssertionError(path)
for size in (16,32,48,128):
    assert dimensions(ROOT/f'extension/icons/icon-{size}.png')==(size,size)
assert dimensions(ROOT/'store-assets/icon-128.png')==(128,128)
for name in ('01-following-zh','02-following-en','03-confirm-en'):
    assert dimensions(ROOT/f'store-assets/screenshots/{name}-1280x800.jpg')==(1280,800)
for name,size in [('small-tile-440x280',(440,280)),('marquee-1400x560',(1400,560))]:
    assert dimensions(ROOT/f'store-assets/promos/{name}.jpg')==size
for folder in ('site','store-assets/promos'):
    for path in (ROOT/folder).glob('*.html'):
        source=path.read_text()
        for target in re.findall(r'(?:src|href)="([^"#]+)"',source):
            if target.startswith('https://'):
                from urllib.parse import urlparse
                assert urlparse(target).hostname in {'github.com','iruochen.github.io','chromewebstore.google.com'},(path,target)
                continue
            assert not target.startswith(('http:','//')),path
            assert (path.parent/target.split('#')[0]).is_file(),(path,target)
source=(ROOT/'site/app.js').read_text()
copy=json.loads(source.split('const copy = ',1)[1].split('\nlet language',1)[0].rstrip().removesuffix(';'))
for path in (ROOT/'site').glob('*.html'):
    for key in re.findall(r'data-i18n="([^"]+)"',path.read_text()):
        assert key in copy and len(copy[key])==2 and all(copy[key]),(path,key)
for language in ('en','zh_CN'):
    messages=json.loads((ROOT/f'extension/_locales/{language}/messages.json').read_text())
    assert all(messages[k]['message'] for k in ('extensionName','extensionDescription','actionTitle'))
print('OK: icon and store image dimensions, standalone website links and bilingual catalogs.')
print('Scope: local assets only; website hosting and Chrome Web Store submission are not verified.')
