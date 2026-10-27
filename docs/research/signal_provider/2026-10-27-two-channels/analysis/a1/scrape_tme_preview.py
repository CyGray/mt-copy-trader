"""Polite scraper of a PUBLIC Telegram web preview (t.me/s/<handle>), no login. 1 request per 1.5 s.
usage: scrape_tme_preview.py HANDLE OUTDIR [MAX_PAGES]. Saves raw pages (untrusted data) and posts.json
(id, datetime UTC, edited flag, has_media, text). Paginates with ?before=<lowest id>."""
import html, json, os, re, sys, time, urllib.request
handle, out = sys.argv[1], sys.argv[2]; maxp = int(sys.argv[3]) if len(sys.argv) > 3 else 200
UA = 'Mozilla/5.0 (X11; Linux x86_64) ByTraderResearch/1.0 (private research)'
def get(url):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=30) as r: return r.read().decode('utf-8', 'replace')
def text_of(b):
    m = re.search(r'tgme_widget_message_text[^>]*>(.*?)</div>\s*(?:<div class="tgme_widget_message_footer|<div class="tgme_widget_message_reactions)', b, re.S) \
        or re.search(r'tgme_widget_message_text[^>]*>(.*?)</div>', b, re.S)
    if not m: return ''
    t = re.sub(r'<br\s*/?>', '\n', m.group(1)); t = re.sub(r'<[^>]+>', '', t); return html.unescape(t).strip()
posts = {}; before = None
for p in range(maxp):
    url = f'https://t.me/s/{handle}' + (f'?before={before}' if before else '')
    try: page = get(url)
    except Exception as e: print('ERR', url, e); time.sleep(5); continue
    open(os.path.join(out, 'pages', f'p{p:03d}.html'), 'w').write(page)
    blocks = page.split('class="tgme_widget_message_wrap')[1:]
    ids = []
    for b in blocks:
        i = re.search(rf'data-post="{re.escape(handle)}/(\d+)"', b, re.I)
        if not i: continue
        mid = int(i.group(1)); ids.append(mid)
        d = re.search(r'datetime="([^"]+)"', b)
        posts[mid] = dict(id=mid, date=d.group(1) if d else None, edited='tgme_widget_message_meta">edited' in b or '>edited<' in b,
                          has_media=bool(re.search(r'message_photo|message_video|message_document|message_roundvideo', b)), text=text_of(b))
    if not ids: break
    nb = min(ids)
    print(f'page {p} ids {min(ids)}-{max(ids)} total {len(posts)}', flush=True)
    if before is not None and nb >= before: break
    before = nb
    if nb <= 1: break
    time.sleep(1.5)
json.dump([posts[k] for k in sorted(posts)], open(os.path.join(out, 'posts.json'), 'w'))
print('DONE', len(posts))
