"""Render the original Follow Garden vector mark using only the standard library."""
from pathlib import Path
import math
import struct
import zlib

ROOT = Path(__file__).resolve().parents[1]
SVG = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect x="4" y="4" width="120" height="120" rx="29" fill="#284f45"/><path d="M64 98V67M64 79L43 58M64 67L87 44" fill="none" stroke="#f6f3e9" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/><path d="M44 61C24 62 25 39 26 32C47 30 59 49 44 61Z" fill="#f6f3e9"/><path d="M72 59C65 35 88 25 101 27C104 47 91 65 72 59Z" fill="#c9dd9e"/><circle cx="64" cy="99" r="6" fill="#f6f3e9"/></svg>'''
def bezier(a,b,c,d):
    return [tuple((1-t)**3*a[k]+3*(1-t)**2*t*b[k]+3*(1-t)*t*t*c[k]+t**3*d[k] for k in (0,1)) for t in [i/32 for i in range(33)]]
left=bezier((44,61),(24,62),(25,39),(26,32))+bezier((26,32),(47,30),(59,49),(44,61))
right=bezier((72,59),(65,35),(88,25),(101,27))+bezier((101,27),(104,47),(91,65),(72,59))
def inside(x,y,poly):
    result=False
    for a,b in zip(poly,poly[1:]+poly[:1]):
        if (a[1]>y)!=(b[1]>y) and x<(b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0]: result=not result
    return result
def line(x,y,a,b):
    dx=b[0]-a[0];dy=b[1]-a[1]
    t=max(0,min(1,((x-a[0])*dx+(y-a[1])*dy)/(dx*dx+dy*dy)))
    return (x-a[0]-t*dx)**2+(y-a[1]-t*dy)**2<=3.5**2
def color(x,y):
    cx=max(33,min(95,x));cy=max(33,min(95,y))
    if not(4<=x<=124 and 4<=y<=124) or (x-cx)**2+(y-cy)**2>29**2:return (0,0,0,0)
    ink=(40,79,69,255);white=(246,243,233,255);lime=(201,221,158,255)
    if inside(x,y,right):return lime
    if inside(x,y,left) or any(line(x,y,a,b) for a,b in [((64,98),(64,67)),((64,79),(43,58)),((64,67),(87,44))]) or (x-64)**2+(y-99)**2<=36:return white
    return ink
def png(size, padding=0):
    scale=4;rows=bytearray()
    for y in range(size):
        rows.append(0)
        for x in range(size):
            values=[color((x+(sx+.5)/scale-padding)*128/(size-2*padding),(y+(sy+.5)/scale-padding)*128/(size-2*padding)) for sy in range(scale) for sx in range(scale)]
            # Premultiplied averaging avoids black fringes on transparent corners.
            alpha=sum(v[3] for v in values)/len(values)
            rgb=[round(sum(v[k]*v[3] for v in values)/max(1,sum(v[3] for v in values))) for k in range(3)]
            rows.extend((*rgb,round(alpha)))
    def chunk(name,data):return struct.pack('>I',len(data))+name+data+struct.pack('>I',zlib.crc32(name+data)&0xffffffff)
    return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',size,size,8,6,0,0,0))+chunk(b'IDAT',zlib.compress(bytes(rows),9))+chunk(b'IEND',b'')
icons=ROOT/'extension/icons';icons.mkdir(exist_ok=True)
for size in (16,32,48,128): (icons/f'icon-{size}.png').write_bytes(png(size))
(ROOT/'extension/ui/mark.svg').write_text(SVG)
assets=ROOT/'site/assets';assets.mkdir(parents=True,exist_ok=True)
(assets/'mark.svg').write_text(SVG)
(assets/'icon-32.png').write_bytes((icons/'icon-32.png').read_bytes())
print('Generated SVG mark and 16/32/48/128 px Chrome icons.')

store=ROOT/'store-assets';store.mkdir(exist_ok=True);(store/'icon-128.png').write_bytes(png(128,16))
