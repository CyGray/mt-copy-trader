"""Hand labels (orchestrator, 2026-10-27, from the final revision of every message; no text stored here).
Class per message id; for signals the exact levels read by eye. Used by eval_parser.py for precision/recall."""
M = 'media_only'
GABFX = {5692: 'engagement', 5693: 'marketing', 5694: 'marketing', **{i: M for i in range(5695, 5704)},
         5704: 'marketing', 5705: 'marketing', 5706: 'result_claim', 5707: M, 5708: 'result_claim',
         5709: 'result_claim', 5710: M, 5711: 'result_claim', 5712: M, 5713: 'result_claim', 5714: M, 5715: M,
         5716: 'analysis_levels', 5717: M, 5718: 'third_party_promo', 5719: 'engagement'}
LUCAS = {23203: 'engagement', 23204: 'analysis', 23205: 'engagement', 23206: 'engagement', 23207: 'analysis_levels',
         23208: 'result_claim', 23209: M, 23210: 'result_claim', 23211: M, 23212: 'marketing', 23213: 'engagement',
         23214: 'engagement', 23215: 'engagement', 23216: M, 23217: 'engagement', 23218: 'signal',
         **{i: 'management' for i in range(23219, 23229)}, 23229: 'result_claim', 23230: 'management',
         23231: 'management', 23232: 'result_claim', 23233: 'management', 23234: 'management', 23235: 'management',
         23236: 'result_claim', 23237: 'marketing', 23238: M, **{i: M for i in range(23239, 23247)},
         23247: 'result_claim', 23248: 'engagement', **{i: M for i in range(23249, 23253)}}
# expected signals (final text): (message_id, label, direction, entry_low, entry_high, sl, tps, open_tp)
SIGNALS_FINAL = {23218: [('3', 'buy', 3990.0, 3992.0, 3984.0, [3998.0, 4006.0, 4014.0], True),
                         ('4', 'sell', 4011.0, 4013.0, 4018.0, [4006.0, 3999.0, 3990.0], False)]}
# first revision of 23218 had SL 4028 for signal 4 (edited 14:20:03Z, 27 min after posting)
SIGNALS_FIRST = {23218: [('3', 'buy', 3990.0, 3992.0, 3984.0, [3998.0, 4006.0, 4014.0], True),
                         ('4', 'sell', 4011.0, 4013.0, 4028.0, [4006.0, 3999.0, 3990.0], False)]}
