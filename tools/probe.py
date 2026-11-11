import json, sys, time, http.client, ssl
cookies = json.load(open(sys.argv[1], encoding='utf-8'))
cookies = cookies if isinstance(cookies, list) else cookies.get('cookies', [])
ck = '; '.join(f"{c['name']}={c['value']}" for c in cookies if c.get('path','/') == '/')
H = {'Cookie': ck, 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0'}
def t(conn, path):
    s = time.perf_counter(); conn.request('GET', '/web/gw/' + path, headers=H); r = conn.getresponse(); b = r.read()
    return r.status, (time.perf_counter() - s) * 1000, b, r
ctx = ssl.create_default_context()
s = time.perf_counter(); c = http.client.HTTPSConnection('eduapp.ethz.ch', context=ctx); c.connect(); print(f"TCP+TLS connect: {(time.perf_counter()-s)*1000:.0f} ms")
st, ms, b, r = t(c, 'semesters/current'); print('semesters/current', st, f'{ms:.0f} ms', b[:120]); sem = json.loads(b)['semkez']
for i in range(3):
    st, ms, b, r = t(c, f'clickers?semkez={sem}'); print(f'clickers list #{i}', st, f'{ms:.0f} ms', len(b), 'bytes', 'cache-control=', r.getheader('cache-control'), 'etag=', r.getheader('etag'))
lst = json.loads(b)
json.dump(lst, open(sys.argv[2] + '/clickers_list.json', 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
print('list keys:', list(lst)[:10] if isinstance(lst, dict) else type(lst))
for i in range(3):
    st, ms, b, r = t(c, 'clickers/322454'); print(f'clicker detail #{i}', st, f'{ms:.0f} ms', len(b), 'bytes')
json.dump(json.loads(b), open(sys.argv[2] + '/clicker_322454.json', 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
# fresh connection each time (what a cold request costs)
for i in range(3):
    s = time.perf_counter(); c2 = http.client.HTTPSConnection('eduapp.ethz.ch', context=ctx); st, ms, b, r = t(c2, 'clickers/322454'); c2.close(); print(f'cold detail #{i}', st, f'{(time.perf_counter()-s)*1000:.0f} ms total')
# keep-alive idle behaviour
print('server keep-alive header:', r.getheader('connection'), r.getheader('keep-alive'))
