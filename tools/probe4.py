import time, http.client, ssl, socket
ctx = ssl.create_default_context(); ctx.set_alpn_protocols(['h2', 'http/1.1'])
s = socket.create_connection(('eduapp.ethz.ch', 443)); t = ctx.wrap_socket(s, server_hostname='eduapp.ethz.ch')
print('ALPN negotiated:', t.selected_alpn_protocol(), '| TLS', t.version()); t.close()
ctx = ssl.create_default_context()
def get(c, p):
    s = time.perf_counter(); c.request('GET', p, headers={'Accept': 'application/json'}); r = c.getresponse(); b = r.read(); return r, b, (time.perf_counter() - s) * 1000
c = http.client.HTTPSConnection('eduapp.ethz.ch', context=ctx)
r, b, ms = get(c, '/web/gw/clickers/1')
print('unauth status', r.status, dict(r.getheaders()), b[:200])
for idle in (4, 10, 30, 60, 90):
    c = http.client.HTTPSConnection('eduapp.ethz.ch', context=ctx); get(c, '/web/gw/semesters/current'); time.sleep(idle)
    try: r, b, ms = get(c, '/web/gw/semesters/current'); print(f'idle {idle}s: reused, {ms:.0f} ms')
    except Exception as e: print(f'idle {idle}s: closed by server ({type(e).__name__})')
