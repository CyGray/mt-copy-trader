"""Channel-agnostic signal parser and message classifier (two-channel study, 2026-10-27).

parse_message(text) -> list of signal dicts (0, 1 or several per message). Order of attempts:
  1. the repo format via parser_port.parse_gold_signal (vipSignalParser.ts port; unchanged behaviour), then
  2. the "zone" format, one block per "SIGNAL n" header or per direction line:
        BUY ZONE: 3992 - 3990            (also SELL ZONE, BUY/SELL [NOW] a - b, BUY LIMIT a)
        STOPLOSS: 3984 (60pips - 80pips) (also SL, STOP LOSS; the pips annotation is optional)
        TAKE PROFIT: 3998 - 4006 - 4014 - open   (also TP: a / b / c, or TP1 / TP2 lines)
A block without a stop or without a numeric TP is NOT a signal (e.g. a "zone map" with no stop).
The parser never guesses a missing level. Levels are validated like vipSignalParser (TP order, sides).

classify_message(text, has_media, is_reply) -> one of
  signal, management, result_claim, analysis_levels, analysis, marketing, third_party_promo, engagement, media_only
Classification is keyword based and is checked against hand labels (labels.py) before use.
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'a3'))
import parser_port as pp  # noqa: E402
import symbols  # noqa: E402

NUM = r'(\d{1,6}(?:[.,]\d+)?)'
SEP = r'\s*(?:-|–|—|/|\bto\b|,(?!\d))\s*'
HEADER = re.compile(r'^\s*SIGNAL\s*#?\s*(\d+)\b.*$', re.I | re.M)
DIR_ZONE = re.compile(r'\b(BUY|SELL)(?:\s*(?:ZONE|NOW|LIMIT|STOP))?\s*:?\s*@?\s*' + NUM + r'(?:' + SEP + NUM + r')?', re.I)
SL_RX = re.compile(r'\b(?:STOP\s*LOSS|STOPLOSS|SL)\s*:?\s*' + NUM + r'(?:\s*\(\s*(\d+)\s*pips?\s*(?:-|–|to)\s*(\d+)\s*pips?\s*\))?', re.I)
TP_LIST = re.compile(r'\b(?:TAKE\s*PROFITS?|TPS?)\s*:?\s*((?:' + NUM + r'|open)(?:' + SEP + r'(?:' + NUM + r'|open))*)', re.I)
TP_NUMBERED = re.compile(r'\bTP\s*(\d)\s*:?\s*' + NUM, re.I)
SYM_RX = re.compile(r'\b(' + '|'.join(sorted(symbols.SPECS, key=len, reverse=True)) + r'|GOLD)\b', re.I)


def _f(s):
    return float(s.replace(',', '.')) if re.fullmatch(r'\d+,\d{1,2}', s) else float(s.replace(',', ''))


def _symbol(text, level):
    m = SYM_RX.search(text or '')
    if m:
        return symbols.spec(m.group(1))['symbol']
    if 500 <= level <= 20000:
        return 'XAUUSD'          # inferred from the price level; flagged symbol_inferred
    return None


def _validate(direction, lo, hi, sl, tps):
    if not tps:
        return 'missing_tp'
    for i in range(1, len(tps)):
        if not (tps[i] > tps[i - 1] if direction == 'buy' else tps[i] < tps[i - 1]):
            return 'invalid_tp_order'
    if direction == 'buy':
        if sl >= lo:
            return 'invalid_sl_side'
        if tps[0] <= hi:
            return 'invalid_tp_side'
    else:
        if sl <= hi:
            return 'invalid_sl_side'
        if tps[0] >= lo:
            return 'invalid_tp_side'
    return None


def _blocks(text):
    hs = list(HEADER.finditer(text))
    if hs:
        out = []
        for i, h in enumerate(hs):
            end = hs[i + 1].start() if i + 1 < len(hs) else len(text)
            out.append((h.group(1), text[h.start():end]))
        return out
    ds = list(DIR_ZONE.finditer(text))
    if len(ds) <= 1:
        return [(None, text)]
    return [(None, text[d.start():(ds[i + 1].start() if i + 1 < len(ds) else len(text))]) for i, d in enumerate(ds)]


def parse_zone_block(label, block, full_text):
    d = DIR_ZONE.search(block)
    if not d:
        return None, 'missing_direction'
    direction = d.group(1).lower()
    a = _f(d.group(2))
    b = _f(d.group(3)) if d.group(3) else a
    lo, hi = min(a, b), max(a, b)
    s = SL_RX.search(block)
    if not s:
        return None, 'missing_sl'
    sl = _f(s.group(1))
    ann = (int(s.group(2)), int(s.group(3))) if s.group(2) else None
    numbered = TP_NUMBERED.findall(block)
    t = None if numbered else TP_LIST.search(block)
    tps, open_tp = [], False
    if t:
        for tok in re.split(SEP, t.group(1)):
            tok = tok.strip()
            if not tok:
                continue
            if tok.lower() == 'open':
                open_tp = True
            else:
                tps.append(_f(tok))
    else:
        tps = [_f(v) for _, v in sorted(numbered, key=lambda x: int(x[0]))]
        open_tp = bool(re.search(r'\bTP\s*\d\s*:?\s*open\b', block, re.I))
    err = _validate(direction, lo, hi, sl, tps)
    if err:
        return None, err
    sym = _symbol(full_text, (lo + hi) / 2)
    if not sym:
        return None, 'unknown_symbol'
    info = []
    if not SYM_RX.search(full_text or ''):
        info.append('symbol_inferred')
    if open_tp:
        info.append('open_last_tp')
    if ann:
        pip = symbols.spec(sym)['pip']
        near, far = sorted((abs(sl - lo), abs(sl - hi)))
        if abs(near / pip - min(ann)) > 5 or abs(far / pip - max(ann)) > 5:
            info.append(f'sl_annotation_mismatch_{near / pip:.0f}-{far / pip:.0f}_vs_{ann[0]}-{ann[1]}')
    return dict(label=label, symbol=sym, direction=direction, orderType='market', entryLow=lo, entryHigh=hi,
                stopLoss=sl, takeProfits=tps, open_tp=open_tp, sl_pips_annotation=ann, info=info,
                format='zone'), None


def parse_message(text):
    """Returns (signals, error). signals is a list; error explains an empty list."""
    t = (text or '').strip()
    if not t:
        return [], 'empty_message'
    r = pp.parse_gold_signal(t)
    if r['ok']:
        s = dict(r['signal'], label=None, open_tp=False, sl_pips_annotation=None, info=[], format='vip')
        return [s], None
    out, errs = [], []
    for label, block in _blocks(t):
        s, e = parse_zone_block(label, block, t)
        if s:
            out.append(s)
        else:
            errs.append(e)
    return out, (None if out else (errs[0] if errs else 'no_block'))


KW = dict(
    management=r'\b(MANAGEMENT|HIT ENTRY|move\s*stop\s*loss|move\s*SL|close\s*(bad\s*entries|1/2|half)|break\s*-?\s*even|'
               r'returned to breakeven|runner|trail)',
    result_claim=r'(\+\s*\d+\s*pips|\d+\s*PIPS|TP\s*\d?\s*(HIT|has been hit|REACHED)|COMPLETED|FULL\s*TP|PROFIT\b.*\$|\$\s?\d|'
                 r'\d+\s*K\s*profit|FLIPPED|feedbacks?)',
    third_party_promo=r'(TRADING BOT|BASIC PLAN|PREMIUM PLAN|\bBTC\b)',
    marketing=r'(JOIN|1ON1|CIRCLE|MASTERMIND|SLOTS? LEFT|ACCESS|BOOTCAMP|MENTOR|@\w+|reach out|iPhone)',
    engagement=r'(TAP|MAKE SOME NOISE|ARE YOU READY|are you with me|LET\'S GO|GOOD\s*MORNING|Hello|Goodnight|READY\?)',
)


def classify_message(text, has_media=False, is_reply=False):
    t = (text or '').strip()
    body = re.sub(r'^Forwarded from [^\n]*\n?', '', t).strip()
    if not body:
        return 'media_only' if has_media or t else 'empty'
    sigs, _ = parse_message(body)
    if sigs:
        return 'signal'
    for cls in ('third_party_promo', 'management', 'result_claim'):
        if re.search(KW[cls], body, re.I):
            if cls == 'management' and not (is_reply or re.search(r'MANAGEMENT|HIT ENTRY', body, re.I)):
                continue
            return cls
    if re.search(r'\b(BUY|SELL)\s*ZONE', body, re.I) or len(re.findall(r'\b\d{4}(?:\.\d+)?\b', body)) >= 4:
        return 'analysis_levels'
    if re.search(KW['marketing'], body, re.I):
        return 'marketing'
    if re.search(KW['engagement'], body, re.I) or len(body) < 40:
        return 'engagement'
    return 'analysis'
