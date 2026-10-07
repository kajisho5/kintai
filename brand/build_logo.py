"""tokisuke ロゴの最終版の生成。文字は線（ストローク）で設計し、塗りの輪郭（アウトライン）に変換して書き出す。"""
import math,os
import pathops
from fontTools.svgLib.path import parse_path
from fontTools.pens.svgPathPen import SVGPathPen
INK='#1B2A41'; AI='#27498C'; SHU='#C73F28'; YAMA='#F4B21D'; WHITE='#FFFFFF'
SHU_DARK='#F27A63'   # 暗い背景の朱
def n(x):
    r=round(x,1); return str(int(r)) if abs(r-int(r))<1e-9 else str(r)
def circle_d(cx,cy,r): return f'M{n(cx-r)} {n(cy)}A{n(r)} {n(r)} 0 1 0 {n(cx+r)} {n(cy)}A{n(r)} {n(r)} 0 1 0 {n(cx-r)} {n(cy)}Z'
def outline(ds,width):
    p=pathops.Path()
    for d in ds: parse_path(d,p.getPen())
    p.stroke(width,pathops.LineCap.ROUND_CAP,pathops.LineJoin.ROUND_JOIN,4)
    p.convertConicsToQuads(0.05)
    p.simplify(fix_winding=True)
    pen=SVGPathPen(None,ntos=lambda v: n(v)); p.draw(pen)
    return pen.getCommands()
class Geo:
    """文字の寸法。xh=x-height、sw=線の太さ。すべて「外形」で揃える（丸い文字もまっすぐな文字も、同じ高さ・同じ底で終わる）"""
    def __init__(s,sw=20,xh=104,gap=17,base=200):
        s.sw,s.xh,s.gap,s.base=sw,xh,gap,base
        s.XT=base-xh; s.R=(xh-sw)/2; s.Bc=base-sw/2; s.Tc=s.XT+sw/2
    def letters(s,x0=0):
        sw,xh,gap,base,XT,R,Bc,Tc=s.sw,s.xh,s.gap,s.base,s.XT,s.R,s.Bc,s.Tc
        L=[]; x=x0
        asc_k=base-xh*1.52+sw/2; asc_t=base-xh*1.34+sw/2
        # t
        r=R*0.80; tx=x+sw/2+R*0.60
        L.append(dict(name='t',ds=[f'M{n(tx)} {n(asc_t)}V{n(Bc-r)}A{n(r)} {n(r)} 0 0 0 {n(tx+r)} {n(Bc)}',f'M{n(tx-R*0.60)} {n(Tc)}H{n(tx+R*0.86)}']))
        x=tx+R*0.86+sw/2
        # o
        x+=gap-3; cx=x+sw/2+R; cy=(XT+base)/2
        L.append(dict(name='o',ds=[circle_d(cx,cy,R)],cx=cx,cy=cy)); x=cx+R+sw/2; s.end_o=x
        # k
        x+=gap+1; kx=x+sw/2
        L.append(dict(name='k',ds=[f'M{n(kx)} {n(asc_k)}V{n(Bc)}',f'M{n(kx+R*0.98)} {n(Tc)}L{n(kx)} {n(base-xh*0.46)}L{n(kx+R*1.02)} {n(Bc)}'])); x=kx+R*1.02+sw/2
        # i
        x+=gap-4; ix=x+sw/2
        L.append(dict(name='i',ds=[f'M{n(ix)} {n(Tc)}V{n(Bc)}'],dot=(ix,XT-sw*0.98,sw*0.62))); x=ix+sw/2
        # s
        x+=gap-2; rr=(xh-sw)/4; scx=x+sw/2+rr*1.02; c1=Tc+rr; c2=Tc+3*rr
        a1=math.radians(-34); a2=math.radians(146)
        L.append(dict(name='s',ds=[f'M{n(scx+rr*math.cos(a1))} {n(c1+rr*math.sin(a1))}A{n(rr)} {n(rr)} 0 1 0 {n(scx)} {n(c1+rr)}A{n(rr)} {n(rr)} 0 1 1 {n(scx+rr*math.cos(a2))} {n(c2+rr*math.sin(a2))}'])); x=scx+rr*1.02+sw/2
        # u
        x+=gap-2; ux=x+sw/2
        L.append(dict(name='u',ds=[f'M{n(ux)} {n(Tc)}V{n(Bc-R)}A{n(R)} {n(R)} 0 0 0 {n(ux+2*R)} {n(Bc-R)}',f'M{n(ux+2*R)} {n(Tc)}V{n(Bc)}'])); x=ux+2*R+sw/2
        # k
        x+=gap+1; kx=x+sw/2
        L.append(dict(name='k',ds=[f'M{n(kx)} {n(asc_k)}V{n(Bc)}',f'M{n(kx+R*0.98)} {n(Tc)}L{n(kx)} {n(base-xh*0.46)}L{n(kx+R*1.02)} {n(Bc)}'])); x=kx+R*1.02+sw/2
        # e
        x+=gap-1; ecx=x+sw/2+R; ecy=cy; an=math.radians(40)
        L.append(dict(name='e',ds=[f'M{n(ecx-R)} {n(ecy)}H{n(ecx+R)}A{n(R)} {n(R)} 0 1 0 {n(ecx+R*math.cos(an))} {n(ecy+R*math.sin(an))}'])); x=ecx+R+sw/2
        s.end=x
        return L
def hand_paths(g,cx,cy,color,scale=1.0):
    a=math.radians(-50); Lh=g.R*0.53
    d=f'M{n(cx)} {n(cy)}L{n(cx+Lh*math.cos(a))} {n(cy+Lh*math.sin(a))}'
    w=g.sw*0.58
    return f'<path fill="{color}" d="{outline([d],w)}"/><circle cx="{n(cx)}" cy="{n(cy)}" r="{n(g.sw*0.32)}" fill="{color}"/>'
def word_frag(g,color=INK,hand=SHU,only=None,x0=0,clock=True):
    """文字の SVG 断片（アウトライン）。only=('t','o') など"""
    L=g.letters(x0); ds=[]; extra=''
    for l in L:
        if only and l['name'] not in only: continue
        ds+=l['ds']
        if 'dot' in l and not only: 
            cx,cy,r=l['dot']; extra+=f'<circle cx="{n(cx)}" cy="{n(cy)}" r="{n(r)}" fill="{color}"/>'
        if l['name']=='o' and clock: extra+=hand_paths(g,l['cx'],l['cy'],hand)
    return f'<path fill="{color}" d="{outline(ds,g.sw)}"/>'+extra
def svg(w,h,inner,title):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {n(w)} {n(h)}" width="{n(w)}" height="{n(h)}" role="img" aria-label="{title}"><title>{title}</title>{inner}</svg>\n'
def wordmark(color=INK,hand=SHU,pad=16,clock=True):
    g=Geo(); frag=word_frag(g,color,hand,clock=clock)
    return svg(g.end+2*pad,256,f'<g transform="translate({pad} {n(128-(g.base-g.xh/2))})">{frag}</g>','tokisuke')
def tile(bg=AI,fg=WHITE,hand=SHU_DARK,rx=58,sw=20,small=False):
    """アプリアイコン: t と、時計の o。small=True は 16〜32px 用（線を太く、針を大きく）"""
    g=Geo(sw=sw if not small else 26,xh=104,gap=14 if not small else 10)
    frag=word_frag(g,fg,hand,only=('t','o'))
    wd=g.end_o; sc=0.96 if not small else 1.0
    ox=(256-wd*sc)/2; oy=128-135*sc
    return svg(256,256,f'<rect width="256" height="256" rx="{rx}" fill="{bg}"/><g transform="translate({n(ox)} {n(oy)}) scale({sc})">{frag}</g>','tokisuke')
def tile_inner(bg=AI,fg=WHITE,hand=SHU_DARK,rx=58):
    g=Geo(sw=20,xh=104,gap=14); frag=word_frag(g,fg,hand,only=('t','o'))
    wd=g.end_o; sc=0.96; ox=(256-wd*sc)/2; oy=128-135*sc
    return f'<rect width="256" height="256" rx="{rx}" fill="{bg}"/><g transform="translate({n(ox)} {n(oy)}) scale({sc})">{frag}</g>'
def lockup_h(color=INK,hand=SHU,bg=AI,fg=WHITE,ihand=SHU_DARK,sym_h=176,gap=36,pad=16):
    g=Geo(); frag=word_frag(g,color,hand)
    sc=sym_h/256; oy=(256-sym_h)/2; wx=pad+sym_h+gap
    return svg(wx+g.end+pad,256,f'<g transform="translate({pad} {n(oy)}) scale({n(sc) if sc!=int(sc) else int(sc)})">{tile_inner(bg,fg,ihand)}</g><g transform="translate({n(wx)} {n(128-(g.base-g.xh/2))})">{frag}</g>','tokisuke')
def lockup_stack(color=INK,hand=SHU,bg=AI,fg=WHITE,ihand=SHU_DARK,sym=168,gap=28,pad=16):
    g=Geo(); frag=word_frag(g,color,hand)
    ww=g.end; W=max(ww,sym)+2*pad; H=pad+sym+gap+g.xh*1.6+pad
    sc=sym/256
    return svg(W,H,f'<g transform="translate({n((W-sym)/2)} {n(pad)}) scale({n(sc)})">{tile_inner(bg,fg,ihand)}</g><g transform="translate({n((W-ww)/2)} {n(pad+sym+gap-(g.base-g.xh*1.5))})">{frag}</g>','tokisuke')
if __name__=='__main__':
    os.makedirs('final',exist_ok=True)
    W=lambda fn,t: open(f'final/{fn}','w').write(t)
    W('tokisuke-wordmark.svg',wordmark())
    W('tokisuke-icon.svg',tile())
    W('tokisuke-icon-small.svg',tile(small=True))
    W('tokisuke-horizontal.svg',lockup_h())
    W('tokisuke-stacked.svg',lockup_stack())
    print('ok')
