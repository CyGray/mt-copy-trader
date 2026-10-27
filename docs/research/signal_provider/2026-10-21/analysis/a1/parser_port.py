# Faithful Python port of worker/src/lib/vipSignalParser.ts (parseGoldSignal, detectCancelIntent).
# JS \b and \d are ASCII; JS \s is Unicode whitespace -> re.ASCII plus explicit JS whitespace class.
import re
WS = r'[ \t\n\r\f\v   -     　﻿]'
def rx(p, flags=0):
    return re.compile(p.replace(r'\s', WS), flags | re.ASCII)
ORDER_TYPE_REGEX = rx(r'\b(BUY\s*LIMIT|SELL\s*LIMIT|BUY\s*STOP|SELL\s*STOP)\b', re.I)
DIRECTION_REGEX = rx(r'^[ \t>]*(BUY(?:ING)?|SELL(?:ING)?)\b', re.I | re.M)
ENTRY_REGEX = rx(r'\b(?:OPEN|ENTRY(?:\s*ZONE)?)\s*:?\s*(-?\d+(?:\.\d+)?)(?:\s*[-–]\s*(-?\d+(?:\.\d+)?))?', re.I)
STOP_LOSS_REGEX = rx(r'\b(?:SL|STOP\s*LOSS)\s*:?\s*(-?\d+(?:\.\d+)?)', re.I)
TAKE_PROFIT_REGEX = rx(r'\bTP\s*(\d+)\s*:?\s*(-?\d+(?:\.\d+)?)', re.I)
SYMBOL_REGEX = rx(r'\b([A-Z]{2,6}(?:USD|USDT))\b')
GOLD_REGEX = rx(r'\bGOLD\b', re.I)

def expand_short_range(first_raw, second_raw):
    first = float(first_raw); second = float(second_raw)
    if second >= first: return second
    fd = re.sub(r'[-+.]', '', first_raw); sd = re.sub(r'[-+.]', '', second_raw)
    if len(sd) >= len(fd): return second
    prefix = fd[: len(fd) - len(sd)]
    return float(prefix + sd)

def normalize_symbol(text):
    m = SYMBOL_REGEX.search(text.upper())
    if m: return m.group(1)
    return 'XAUUSD'

def parse_gold_signal(text):
    normalized = (text or '').strip()
    if not normalized:
        return {'ok': False, 'error': 'empty_message'}
    order_type = 'market'
    om = ORDER_TYPE_REGEX.search(normalized)
    if om:
        raw = re.sub(WS + '+', '_', om.group(1).upper())
        order_type = {'BUY_LIMIT': 'buy_limit', 'SELL_LIMIT': 'sell_limit', 'BUY_STOP': 'buy_stop', 'SELL_STOP': 'sell_stop'}.get(raw, order_type)
    dm = DIRECTION_REGEX.search(normalized)
    if not dm: return {'ok': False, 'error': 'missing_direction'}
    direction = 'buy' if dm.group(1).upper().startswith('B') else 'sell'
    em = ENTRY_REGEX.search(normalized)
    if not em: return {'ok': False, 'error': 'missing_entry'}
    e1 = float(em.group(1))
    e2 = expand_short_range(em.group(1), em.group(2)) if em.group(2) else e1
    entry_low, entry_high = min(e1, e2), max(e1, e2)
    sm = STOP_LOSS_REGEX.search(normalized)
    if not sm: return {'ok': False, 'error': 'missing_sl'}
    sl = float(sm.group(1))
    tps = [(int(m.group(1)), float(m.group(2))) for m in TAKE_PROFIT_REGEX.finditer(normalized)]
    if not tps: return {'ok': False, 'error': 'missing_tp'}
    tps.sort(key=lambda x: x[0])
    values = [v for _, v in tps]
    for i in range(1, len(values)):
        ordered = values[i] > values[i-1] if direction == 'buy' else values[i] < values[i-1]
        if not ordered: return {'ok': False, 'error': 'invalid_tp_order'}
    if direction == 'buy':
        if sl >= entry_low: return {'ok': False, 'error': 'invalid_sl_side'}
        if values[0] <= entry_high: return {'ok': False, 'error': 'invalid_tp_side'}
    else:
        if sl <= entry_high: return {'ok': False, 'error': 'invalid_sl_side'}
        if values[0] >= entry_low: return {'ok': False, 'error': 'invalid_tp_side'}
    return {'ok': True, 'signal': {'symbol': normalize_symbol(normalized), 'direction': direction, 'orderType': order_type,
            'entryLow': entry_low, 'entryHigh': entry_high, 'stopLoss': sl, 'takeProfits': values}}

CANCEL_MAX_LENGTH = 120
CANCEL_PHRASES = [rx(r'\bcancel(?:l?ed)?\b', re.I), rx(r'\bdelete\s+this\s+signal\b', re.I),
                  rx(r'\bignore\s+this\s+signal\b', re.I), rx(r'\binvalid\s+signal\b', re.I)]
NEGATION_BEFORE_PHRASE = rx(r'\b(?:not|never|no|don[\'’]?t|do\s+not|won[\'’]?t)\s+$', re.I)

def detect_cancel_intent(text):
    trimmed = (text or '').strip()
    if not trimmed or len(trimmed) > CANCEL_MAX_LENGTH: return False
    if parse_gold_signal(trimmed)['ok']: return False
    for pat in CANCEL_PHRASES:
        for m in pat.finditer(trimmed):
            before = trimmed[: m.start()]
            if not NEGATION_BEFORE_PHRASE.search(before): return True
    return False
