import json, sys, time, http.client, ssl, gzip
cookies = json.load(open(sys.argv[1], encoding='utf-8'))
ck = '; '.join(f"{c['name']}={c['value']}" for c in cookies if c.get('path','/') == '/')
ctx = ssl.create_default_context()
def get(conn, p, enc='gzip'):
    s=time.perf_counter(); conn.request('GET','/web/gw/'+p,headers={'Cookie':ck,'Accept':'application/json','Accept-Encoding':enc}); r=conn.getresponse(); b=r.read()
    return r, b, (time.perf_counter()-s)*1000
c = http.client.HTTPSConnection('eduapp.ethz.ch', context=ctx)
r,b,ms = get(c,'clickers/322454'); print('detail gzip:', r.getheader('content-encoding'), len(b), 'B on wire', f'{ms:.0f} ms')
r,b,ms = get(c,'clickers/322454','identity'); print('detail raw:', len(b), 'B')
for p in ['dashboard/activity-feed?maxActivities=3', 'dashboard/activity-feed?semkez=2026W&maxActivities=3']:
    r,b,ms = get(c,p,'identity'); print(p, r.status, f'{ms:.0f} ms', len(b))
r,b,ms = get(c,'dashboard/upcoming-lectures?start=2026-11-09T13:00:00Z&days=1','identity')
print('now UTC', time.strftime('%H:%M:%S', time.gmtime()))
for l in json.loads(b): print(' ', l['code'], l['start'][11:16], l['end'][11:16], {k:(v['available'],v['callToAction']) for k,v in l['assets'].items()})
# keep-alive idle timeout
for idle in (5, 20, 45, 80):
    c = http.client.HTTPSConnection('eduapp.ethz.ch', context=ctx); get(c,'semesters/current')
    time.sleep(idle)
    try:
        r,b,ms = get(c,'semesters/current'); print(f'idle {idle}s: connection reused OK ({ms:.0f} ms)')
    except Exception as e: print(f'idle {idle}s: server closed connection ({type(e).__name__})')
