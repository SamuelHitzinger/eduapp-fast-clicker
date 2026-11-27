import json, sys, time, http.client, ssl
cookies = json.load(open(sys.argv[1], encoding='utf-8'))
ck = '; '.join(f"{c['name']}={c['value']}" for c in cookies if c.get('path','/') == '/')
H = {'Cookie': ck, 'Accept': 'application/json', 'Accept-Encoding': 'identity'}
c = http.client.HTTPSConnection('eduapp.ethz.ch', context=ssl.create_default_context())
def get(p):
    s=time.perf_counter(); c.request('GET','/web/gw/'+p,headers=H); r=c.getresponse(); b=r.read(); return r.status,(time.perf_counter()-s)*1000,b
for n in (1,5,25):
    for i in range(2):
        st,ms,b=get(f'dashboard/activity-feed?semkez=2026W&maxActivities={n}'); print(f'activity-feed max={n}',st,f'{ms:.0f} ms',len(b),'B')
json.dump(json.loads(b),open('data/activity_feed.json','w',encoding='utf-8'),indent=1,ensure_ascii=False)
st,ms,b=get('dashboard/upcoming-lectures?start=2026-11-09T00:00:00Z&days=1'); print('upcoming',st,f'{ms:.0f} ms',len(b))
json.dump(json.loads(b),open('data/upcoming.json','w',encoding='utf-8'),indent=1,ensure_ascii=False)
