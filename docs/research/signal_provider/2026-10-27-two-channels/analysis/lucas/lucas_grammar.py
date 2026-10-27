"""LUCAS GOLD LEGEND message grammar (written from scratch, 2026-10-27).

Unlike the generic parser, this reads the channel's whole vocabulary and returns typed events. Every revision of
every message is parsed separately, so an instruction counts only from the time that revision appeared.

Event types
  signal       label, direction, zone (lo, hi), sl, sl_pips (a, b) or None, tps [..], open_tp
  entry_hit    direction                                   ("HIT ENTRY BUY")
  management   label, status (no_tp / tpK / full_tp), close_levels [..] ("close bad entries 3992 -3991"),
               close_half (bool), move_sl (price) or None, keep_level, perf [(entry, price, pips)]
  completed    label, move_sl, perf                        ("SIGNAL 3 COMPLETED ... FULL TAKE PROFIT")
  breakeven    -                                           ("returned to breakeven")
  runner_note  -                                           ("OPTIONAL SWING MANAGEMENT")
  recap_claim  claims [(direction, entry, price, pips)]    ("BUY 3990 -> 4026: +360 pips")
  other        -
"""
import re

N = r'(\d{3,5}(?:\.\d+)?)'
ARROW = r'\s*(?:→|->|=>|to)\s*'
SIG_HDR = re.compile(r'^\s*SIGNAL\s*(\d+)\s*\(date:[^)]*\)\s*$', re.I | re.M)
ZONE = re.compile(r'\b(BUY|SELL)\s*ZONE\s*:?\s*' + N + r'\s*[-–]\s*' + N, re.I)
SL = re.compile(r'\bSTOP\s*LOSS\s*:?\s*' + N + r'(?:\s*\(\s*(\d+)\s*pips?\s*[-–]\s*(\d+)\s*pips?\s*\))?', re.I)
SL2 = re.compile(r'\bSTOPLOSS\s*:?\s*' + N + r'(?:\s*\(\s*(\d+)\s*pips?\s*[-–]\s*(\d+)\s*pips?\s*\))?', re.I)
TPL = re.compile(r'\bTAKE\s*PROFIT\s*:?[ \t]*([^\n]+)', re.I)
MGMT = re.compile(r'SIGNAL\s*(\d+)\s*MANAGEMENT', re.I)
DONE = re.compile(r'SIGNAL\s*(\d+)\s*COMPLETED', re.I)
STATUS = re.compile(r"(Haven'?t hit TP|REACHED\s*TP\s*(\d)|FULL\s*TP\b|FULL TAKE PROFIT)", re.I)
CLOSE_BAD = re.compile(r'close\s*bad\s*entries\s*' + N + r'(?:\s*[-–]\s*' + N + r')?', re.I)
CLOSE_HALF = re.compile(r'close\s*1\s*/\s*2', re.I)
MOVE_SL = re.compile(r'move\s*stop\s*loss\s*' + N, re.I)
KEEP = re.compile(r'Keep the remaining\s*' + N, re.I)
PERF = re.compile(r'Entry\s*' + N + ARROW + N + r'\s*=\s*\+?\s*(\d+)\s*Pips', re.I)
RECAP = re.compile(r'\b(BUY|SELL)\s*(?:at\s*)?' + N + r'(?:' + ARROW + N + r')?\s*[:,]?\s*(?:also\s*(?:saw|reached)\s*(?:a\s*gain\s*of\s*)?)?\+\s*(\d+)\s*pips', re.I)
HIT = re.compile(r'\bHIT\s*ENTRY\s*(BUY|SELL)\b', re.I)


def _f(x):
    return float(x)


def parse_signals(text):
    out = []
    hs = list(SIG_HDR.finditer(text))
    for i, h in enumerate(hs):
        block = text[h.start():(hs[i + 1].start() if i + 1 < len(hs) else len(text))]
        z, s, t = ZONE.search(block), SL.search(block) or SL2.search(block), TPL.search(block)
        if not (z and s and t):
            continue
        toks = [x.strip() for x in re.split(r'\s*[-–]\s*', t.group(1).strip()) if x.strip()]
        tps = [_f(x) for x in toks if re.fullmatch(r'\d+(?:\.\d+)?', x)]
        a, b = _f(z.group(2)), _f(z.group(3))
        out.append(dict(type='signal', label=int(h.group(1)), direction=z.group(1).lower(), lo=min(a, b), hi=max(a, b),
                        sl=_f(s.group(1)), sl_pips=(int(s.group(2)), int(s.group(3))) if s.group(2) else None,
                        tps=tps, open_tp=any(x.lower() == 'open' for x in toks)))
    return out


def parse(text):
    t = (text or '').strip()
    if not t:
        return [dict(type='other')]
    sigs = parse_signals(t)
    if sigs:
        return sigs
    if HIT.search(t) and len(t) < 40:
        return [dict(type='entry_hit', direction=HIT.search(t).group(1).lower())]
    perf = [(_f(a), _f(b), int(c)) for a, b, c in PERF.findall(t)]
    m = MGMT.search(t) or DONE.search(t)
    if m:
        st = STATUS.search(t)
        status = 'no_tp' if st and st.group(1).lower().startswith('haven') else (
            f'tp{st.group(2)}' if st and st.group(2) else ('full_tp' if st else None))
        cb = CLOSE_BAD.search(t)
        ms, kp = MOVE_SL.search(t), KEEP.search(t)
        return [dict(type='completed' if DONE.search(t) else 'management', label=int(m.group(1)), status=status,
                     close_levels=[_f(x) for x in cb.groups() if x] if cb else [], close_half=bool(CLOSE_HALF.search(t)),
                     move_sl=_f(ms.group(1)) if ms else None, keep_level=_f(kp.group(1)) if kp else None, perf=perf)]
    if re.search(r'returned to break\s*-?\s*even', t, re.I):
        return [dict(type='breakeven')]
    if re.search(r'OPTIONAL SWING MANAGEMENT', t, re.I):
        return [dict(type='runner_note')]
    rc = [(d.lower(), _f(e), _f(p) if p else None, int(n)) for d, e, p, n in RECAP.findall(t)]
    if rc:
        return [dict(type='recap_claim', claims=rc)]
    return [dict(type='other')]
