# FX tick decoder: Dukascopy generalisation and ECB check (wave 1, market data)

Scope: EURUSD, USDJPY, GBPUSD for 2026-10-05, 09, 14, 20, 23 at 12:00 and 13:00 UTC (the half-open
window 12:00-14:00, as in download_ticks.py), plus XAUUSD 2026-10-26 13:00 UTC for the gold level check.
31 hour files, 1.4 MB raw, all with status `ok`. Raw files are in `fx/raw/<SYMBOL>/`, never executed.

Result: **PASS.** 15 of 15 pair-days are within 15 pips of the ECB reference rate. Worst |diff| is 5.16 pips.
Unit tests: 25 of 25 pass.

## Code changes (study copy, a3/)

- `dukas_lib.py`: symbol parameter on `hour_url`, `fetch_hour`, plus `symbol_base`, `price_divisor`,
  `check_rawdir`, `decode_hour_prices`. Divisors come from `symbols.spec`. Existing names are unchanged:
  `BASE`, `PRICE_DIVISOR` (1000.0), `hour_path`, `decode_hour` (raw ints), `window_ticks`, `load_hour_arrays`.
  Behaviour change: the manifest note on a clean fetch is still empty. A note is written only after failed
  attempts (`retried after HTTP 503 | ...`), and an `error` note lists every failed attempt.
- `download_ticks.py`: `--symbol` (default XAUUSD) and `--pause`. Positional arguments are unchanged, and the
  default paths are identical. Non-gold symbols must use a RAWDIR named after the symbol.
- New: `ecb_check.py` (comparison and CSV), `fx_coverage.py` (coverage, spreads, gold check),
  `test_fx_decode.py` (25 unit tests), `fetch_fx_hours.sh` (the download driver).
- `symbols.py` is not modified. No divisor was changed; all three FX divisors were confirmed by the ECB check.

## Commands

```
# tests (from a3/); no sockets, urlopen mocked
python3 -I -B -m unittest discover -s . -p 'test_fx_decode.py' -v
# downloads (one run per symbol-day, 4 workers, nice 10, 1 s pause), log in fx/download.log
nice -n 10 sh a3/fetch_fx_hours.sh /tmp/claude-1001/twochan/fx
# e.g. one symbol-day, as run by the driver:
python3 -I -B a3/download_ticks.py fx/raw/EURUSD fx/manifests/EURUSD_2026-10-05.csv \
  2026-10-05T12 2026-10-05T14 4 --symbol EURUSD --pause 1.0
# ECB reference rates (fetched once with curl, same URL the script uses; script reuses the file)
curl -sS -o fx/ecb/eurofxref-hist-90d.xml https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml
# comparison and coverage
python3 -I -B a3/ecb_check.py fx
python3 -I -B a3/fx_coverage.py fx
```

ECB file: 69,508 bytes, sha256 `b1938e96c2032834aa57181c4135542f780c32262bcf44b363dcd53e38c911d5`, 64 dates
(2026-07-29 to 2026-10-26). All five check dates are published.

## ECB comparison

Method: fixing instant 14:15 Europe/Berlin, which is 12:15 UTC for every check date (all before the 2026-10-25
switch). Dukascopy value: mid of the last tick at or before 12:15:00.000 UTC. Context: the 12:10-12:15 window.
Derived pairs: USDJPY = EURJPY/EURUSD, GBPUSD = EURUSD/EURGBP. Pips: EURUSD and GBPUSD 0.0001, USDJPY 0.01.

| pair | date | Dukascopy mid | ECB value | diff pips | window ticks | window min-max mid | ECB in window | pass |
|---|---|---|---|---|---|---|---|---|
| EURUSD | 2026-10-05 | 1.12024 | 1.12040 | -1.65 | 458 | 1.12012-1.12053 | yes | PASS |
| EURUSD | 2026-10-09 | 1.12047 | 1.12060 | -1.30 | 475 | 1.12026-1.12073 | yes | PASS |
| EURUSD | 2026-10-14 | 1.11961 | 1.11950 | +1.10 | 409 | 1.11939-1.11970 | yes | PASS |
| EURUSD | 2026-10-20 | 1.12189 | 1.12150 | +3.95 | 340 | 1.12149-1.12189 | yes | PASS |
| EURUSD | 2026-10-23 | 1.11934 | 1.11930 | +0.40 | 407 | 1.11904-1.11934 | yes | PASS |
| USDJPY | 2026-10-05 | 158.20100 | 158.22920 | -2.82 | 473 | 158.17500-158.23100 | yes | PASS |
| USDJPY | 2026-10-09 | 158.21550 | 158.25451 | -3.90 | 444 | 158.21350-158.25100 | no | PASS |
| USDJPY | 2026-10-14 | 158.44650 | 158.45467 | -0.82 | 270 | 158.43450-158.46600 | yes | PASS |
| USDJPY | 2026-10-20 | 158.09800 | 158.12751 | -2.95 | 364 | 158.08700-158.12950 | yes | PASS |
| USDJPY | 2026-10-23 | 156.83400 | 156.80336 | +3.06 | 587 | 156.77850-156.85200 | yes | PASS |
| GBPUSD | 2026-10-05 | 1.32246 | 1.32247 | -0.14 | 599 | 1.32224-1.32262 | yes | PASS |
| GBPUSD | 2026-10-09 | 1.32199 | 1.32204 | -0.49 | 753 | 1.32181-1.32222 | yes | PASS |
| GBPUSD | 2026-10-14 | 1.32674 | 1.32666 | +0.82 | 429 | 1.32646-1.32687 | yes | PASS |
| GBPUSD | 2026-10-20 | 1.33519 | 1.33467 | +5.16 | 314 | 1.33467-1.33520 | yes | PASS |
| GBPUSD | 2026-10-23 | 1.33668 | 1.33683 | -1.49 | 439 | 1.33658-1.33689 | yes | PASS |

Per pair: mean |diff| EURUSD 1.68, USDJPY 2.71, GBPUSD 1.62 pips. Largest |diff| 3.95, 3.90 and 5.16 pips.
The ECB value falls inside the 5-minute tick range in 14 of 15 cases. The exception is USDJPY 2026-10-09, which is
0.35 pips above the window maximum, inside the ECB rounding bound for that pair.
ECB rounding bound (half the last published digit, propagated to the derived pairs): max 0.5 pips EURUSD,
1.15 pips USDJPY, 1.37 pips GBPUSD. The largest |diff| (5.16) is well above this, so it is not explained by rounding alone.
The CSV `ecb_check.csv` holds these aggregates only (16 lines: header plus 15 rows).

Divisor check: the decoded levels (1.12, 158.2, 1.32) match the ECB levels. A wrong divisor would be off by 10x
or 100x. The unit test `test_wrong_divisor_is_off_by_a_power_of_ten` checks that the ratio is exactly 100.

## Gold check, XAUUSD 2026-10-26 13:00 UTC

- Nearest quote to 13:00:00.000 is mid **4,015.778 USD**, 16 ms after the instant. No tick sits exactly at or before 13:00:00.000.
- Hour mid range 3,988.805-4,018.525 USD. Within the approximate 3,980-4,030 level: yes.
- Median quoted spread in that hour: 0.524 USD (5.24 gold pips of 0.10).
- This is one hour and one level. It is not an independent reference, so it supports the divisor (1000) only loosely.

## Unit tests

`python3 -I -B -m unittest discover -s . -p 'test_fx_decode.py' -v` gives "Ran 25 tests ... OK". The tests cover:
synthetic bi5 decode per divisor (EURUSD, GBPUSD, USDJPY, XAUUSD, with the 20-byte layout and bid/ask/volume order);
wrong-divisor ratio; empty file; spread in pips; URL building (EURUSD, the `eu` alias, XAUUSD, 0-indexed month);
the default unchanged (URL, BASE, PRICE_DIVISOR, path, fetch URL); per-symbol path separation and `check_rawdir`;
HTTP 503 then OK, persistent 503, 404 marker, zero-length marker (urlopen mocked); ECB parsing, derived pairs,
CET/CEST fixing instant; the comparison logic on synthetic ticks (pass, fail, tick after the fix excluded, no ticks);
CLI refusal of a mismatched symbol directory before any network call; CLI default on a cached file.

## Coverage, ticks and spread

Expected hours per pair: 10 (5 days x 12:00 and 13:00). Manifests: `fx/manifests/`.

| pair | ok | cached | empty | missing | error | files with 503 | HTTP 503 responses | ticks/hour median (min-max) | median spread pips (pooled) | per-hour median spread | negative spreads | out-of-order ts |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| EURUSD | 10 | 0 | 0 | 0 | 0 | 0 | 0 | 6833 (4949-12600) | 0.30 (n=73,363) | 0.2-0.3 | 0 | 0 |
| USDJPY | 10 | 0 | 0 | 0 | 0 | 0 | 0 | 7566 (5153-10681) | 0.30 (n=74,907) | 0.3-0.4 | 0 | 0 |
| GBPUSD | 10 | 0 | 0 | 0 | 0 | 0 | 0 | 7926 (5179-14336) | 0.50 (n=85,853) | 0.5-0.6 | 0 | 0 |
| XAUUSD | 1 (13h, 2026-10-26) | - | - | - | - | 0 | 0 | 22,030 (one hour) | 5.24 pips = 0.524 USD (one hour) | - | 0 | 0 |

- No empty or missing hours. No hour needed a retry.
- HTTP 503 retries: zero in the 31 study requests. The 503 path is covered by mocked unit tests only.
- Spread medians fall on 0.1-pip steps (5-decimal quotes), so the per-file medians are coarse.
- Per-file rows (ticks, median spread, negative and out-of-order counts for each of the 31 hours) are printed by `fx_coverage.py`.

## Surprises (divisors and URLs)

1. **Redirect, not a plain-http file.** `http://datafeed.dukascopy.com/datafeed/.../12h_ticks.bi5` answers
   `301 Moved Permanently` with `https://` as the Location. urllib follows the redirect by default, so the downloads
   travelled over TLS. I did not log the final URL per request, so this is inferred from the 301 and the default
   redirect handling. The old note "https timed out" no longer matched; the comment in `dukas_lib.py` was updated.
2. **One HTTP 503 from a manual HTTPS probe**, on `https://datafeed.dukascopy.com/datafeed/EURUSD/2026/09/05/12h_ticks.bi5`
   (107-byte body). This was a probe and is not in any manifest. Its file was deleted.
3. **FX divisors** (EURUSD and GBPUSD 100000, USDJPY 1000) agree with the ECB levels. `symbols.py` is unchanged.
4. **Shared readers still return raw ints.** `window_ticks` and `load_hour_arrays` (used by the gold-era
   scripts) do not divide. FX callers must divide by `price_divisor(symbol)`.
5. **Default behaviour change, deliberate.** `check_rawdir` also refuses to put XAUUSD data into a directory named
   after another symbol. Callers that follow the layout are unaffected.

## Unknown or not verified

- Whether the broker (Vantage) quotes match Dukascopy. Nothing here measures the broker.
- The exact ECB fixing timing. The brief gives 14:15 CET, and the 12:10-12:15 UTC window is reported as context
  only. Only the 12:15 UTC point is scored.
- Only five pair-days per pair. Weekend and holiday hours were not downloaded, so empty-hour behaviour on those days is unknown.
- Field order: the mid check is symmetric, so it cannot detect an ask/bid swap. Zero negative spreads supports
  the ask-then-bid layout used in the existing code, but it is not an independent proof.
- The original XAUUSD divisor check (`verify_decode.py`) is not in `a3/`, so it cannot be reproduced here.
  The gold level check above is the only gold check in this report.
- Live 503 handling: no live 503 occurred in the study downloads, so retry timing is untested in production.
- Gold spread (5.24 pips in one hour) may not be representative of other hours.
