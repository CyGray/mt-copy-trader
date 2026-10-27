"""Per-symbol specification for the channel-agnostic pipeline (two-channel study, 2026-10-27).

price_divisor  Dukascopy bi5 integer price / divisor = price (gold 1000; FX 100000; JPY quotes 1000)
pip            the provider's "pip" in price units (gold 0.10 by the channel convention "60 pips" = 6.0 USD)
unit           price-unit scale for engine parameters that the gold study expressed in USD
               (tolerances, break-even trigger, trailing distances, extra spread, slippage, stop bounds).
               Pre-registered: 1.0 for gold (USD), 1 pip for FX.
contract       units per 1.0 lot (gold 100 oz, FX 100,000 base units)
quote_ccy      currency of the price; P&L per lot = price move * contract in quote_ccy
min_sl, max_sl stop-distance bounds in price units (gold: project default 2..25 USD; FX: 2..100 pips)
Vantage specs are NOT assumed: read SYMBOL_INFO through the read-only bridge before sizing.
"""

SPECS = {
    'XAUUSD': dict(price_divisor=1000.0, pip=0.10, unit=1.0, contract=100.0, quote_ccy='USD', min_sl=2.0, max_sl=25.0),
    'XAGUSD': dict(price_divisor=1000.0, pip=0.01, unit=0.01, contract=5000.0, quote_ccy='USD', min_sl=0.02, max_sl=0.50),
}
for _s in ('EURUSD', 'GBPUSD', 'AUDUSD', 'NZDUSD', 'USDCHF', 'USDCAD', 'EURGBP', 'EURCHF', 'EURAUD', 'GBPCHF',
           'GBPAUD', 'AUDCAD', 'AUDNZD'):
    SPECS[_s] = dict(price_divisor=100000.0, pip=0.0001, unit=0.0001, contract=100000.0, quote_ccy=_s[3:],
                     min_sl=0.0002, max_sl=0.0100)
for _s in ('USDJPY', 'EURJPY', 'GBPJPY', 'AUDJPY', 'CADJPY', 'CHFJPY', 'NZDJPY'):
    SPECS[_s] = dict(price_divisor=1000.0, pip=0.01, unit=0.01, contract=100000.0, quote_ccy='JPY',
                     min_sl=0.02, max_sl=1.00)

ALIASES = {'GOLD': 'XAUUSD', 'XAU': 'XAUUSD', 'SILVER': 'XAGUSD', 'GU': 'GBPUSD', 'EU': 'EURUSD', 'UJ': 'USDJPY',
           'GJ': 'GBPJPY'}


def spec(symbol):
    s = (symbol or '').upper().replace('/', '').replace('.', '').strip()
    s = ALIASES.get(s, s)
    if s not in SPECS:
        raise KeyError(f'unknown symbol {symbol!r}: add it to SPECS with a decode check first')
    return dict(SPECS[s], symbol=s)


def to_pips(symbol, price_distance):
    return price_distance / spec(symbol)['pip']


def from_pips(symbol, pips):
    return pips * spec(symbol)['pip']
