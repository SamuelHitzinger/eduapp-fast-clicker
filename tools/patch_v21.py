"""One-off patch: fixes from the second independent review (v2.0.0 -> v2.1.0)."""
import sys

p = sys.argv[1]
s = open(p, encoding="utf-8").read()


def rep(a, b, count=1):
    global s
    n = s.count(a)
    if n != count:
        raise SystemExit(f"expected {count} match(es), found {n}: {a[:80]!r}")
    s = s.replace(a, b)


rep("const VERSION = '2.0.0';", "const VERSION = '2.1.0';")
rep("// @version      2.0.0", "// @version      2.1.0")

# ---- state: cross-tab send stamps instead of per-tab sequence numbers
rep("""    sending: new Set(), resend: new Set(), sendSeq: new Map(), // id -> number of the newest send
    unverified: new Map(),       // id -> {ans, gen, mySend, took}: accepted but not yet confirmed by a re-read""",
    """    sending: new Set(), resend: new Set(),
    stamp: new Map(),            // id -> stamp of the newest send in ANY tab (time-based, broadcast to other tabs)
    unverified: new Map(),       // id -> {ans, gen, ver, stamp, took, repair, rechecks}: accepted, not yet re-read""")

# ---- #3 + #6: broadcast send intents and login-needed; leader ignores followers' status
rep("""    } else if (m.t === 'status') {
      Object.assign(state, { lastPollAt: m.lastPollAt, lastError: m.lastError, authLost: m.authLost, lectures: m.lectures || state.lectures });""",
    """    } else if (m.t === 'send' && m.id) {                // another tab sent an answer for this question
      if (m.stamp > (state.stamp.get(m.id) || 0)) {
        state.stamp.set(m.id, m.stamp);
        state.unverified.delete(m.id);
        state.draft.delete(m.id);
        state.status.set(m.id, { kind: 'pending', text: 'Answer being sent from another tab…' });
        render();
      }
    } else if (m.t === 'status') {
      if (state.leader) return;                          // the polling tab owns this state
      Object.assign(state, { lastPollAt: m.lastPollAt, lastError: m.lastError, authLost: m.authLost, loginNeeded: !!m.loginNeeded, lectures: m.lectures || state.lectures });""")
rep("""  const broadcastStatus = () => broadcast({ t: 'status', lastPollAt: state.lastPollAt, lastError: state.lastError, authLost: state.authLost, lectures: state.lectures });""",
    """  const broadcastStatus = () => { if (state.leader) broadcast({ t: 'status', lastPollAt: state.lastPollAt, lastError: state.lastError, authLost: state.authLost, loginNeeded: state.loginNeeded, lectures: state.lectures }); };""")

# ---- #5: pausing releases leadership so another tab can poll
rep("""  function electLeader() {
    if (navigator.locks && navigator.locks.request) {
      navigator.locks.request('fast-clicker-poller', () => new Promise(() => becomeLeader())).catch(() => becomeLeader());
      broadcast({ t: 'hello' });
    } else becomeLeader();
  }""",
    """  let releaseLeader = null;
  function electLeader() {
    if (navigator.locks && navigator.locks.request) {
      navigator.locks.request('fast-clicker-poller', () => new Promise((release) => {
        if (!state.running) { release(); return; }       // paused while queued: pass leadership on
        releaseLeader = release;
        becomeLeader();
      })).catch(() => becomeLeader());
      broadcast({ t: 'hello' });
    } else becomeLeader();
  }
  function resignLeader() {
    state.leader = false;
    clearTimeout(state.timer);
    if (releaseLeader) { const r = releaseLeader; releaseLeader = null; r(); }
  }""")
rep("""      case 'pause': state.running = !state.running; if (state.running) pokeNow(); else clearTimeout(state.timer); updateWakeLock(); break;""",
    """      case 'pause':
        state.running = !state.running;
        if (state.running) electLeader(); else resignLeader();
        updateWakeLock(); break;""")

# ---- #1: fence detail downloads so a round transition never reuses a response requested before it
rep("""  function publish(c, alert) {""",
    """  function fence(id) {                // responses to requests issued before now must not be applied
    const s = state.seq.get(id) || { issued: 0, applied: 0, floor: 0 };
    s.floor = s.issued + 1; state.seq.set(id, s);
  }
  const ROUND_KEEP = new Set(['CLICKER_CLOSE', 'CLICKER_STOP_ROUND']);
  function publish(c, alert) {""")
rep("""  async function processClickerEvent(id, meta, initial) {
    const prev = state.clickers.get(id);
    const { detail: c } = await fetchClicker(id);
    if (meta.courseTitle) c.courseTitle = meta.courseTitle;
    c.lastEventAt = meta.createdAt ? Math.min(Date.now(), Date.parse(meta.createdAt) || Date.now()) : Date.now();
    if (meta.type === 'CLICKER_STOP_ROUND') c.roundStopped = true;
    else if (meta.type !== 'CLICKER_CLOSE') {
      c.roundStopped = false;
      if (!initial && prev) { c.gen = (c.gen || 0) + 1; resetRound(id); }
    }
    const alert = c.state === 'OPEN' && !c.roundStopped && (!initial || Date.now() - c.lastEventAt < 3 * 3600e3);""",
    """  async function processClickerEvent(id, meta, initial) {
    const prev = state.clickers.get(id);
    if (!initial) fence(id);
    // a (possible) new round: invalidate drafts and in-flight sends now, once per event, before downloading
    if (!initial && prev && !ROUND_KEEP.has(meta.type) && !meta.genDone) {
      prev.gen = (prev.gen || 0) + 1; meta.genDone = true; resetRound(id);
      if (meta.type === 'GAP') state.status.set(id, { kind: 'warn', text: 'Connection gap: a new round may have started. Check your answer and send again.' });
    }
    const { detail: c } = await fetchClicker(id);
    if (meta.courseTitle) c.courseTitle = meta.courseTitle;
    if (meta.type !== 'GAP') c.lastEventAt = meta.createdAt ? Math.min(Date.now(), Date.parse(meta.createdAt) || Date.now()) : Date.now();
    if (meta.type === 'CLICKER_STOP_ROUND') c.roundStopped = true;
    else if (meta.type !== 'CLICKER_CLOSE' && meta.type !== 'GAP') c.roundStopped = false;
    const alert = meta.type !== 'GAP' && c.state === 'OPEN' && !c.roundStopped && (!initial || Date.now() - c.lastEventAt < 3 * 3600e3);""")
rep("""  function resetRound(id) {           // answers of a previous round must be chosen again explicitly
    state.draft.delete(id); state.status.delete(id); state.resend.delete(id);
  }""",
    """  function resetRound(id) {           // answers of a previous round must be chosen again explicitly
    state.draft.delete(id); state.status.delete(id); state.resend.delete(id); state.unverified.delete(id);
  }""")

# ---- #2: an unbridgeable feed gap makes round history uncertain for every known open question
rep("""    if (!initial && allNew(feed)) state.scanDone = false;            // still a gap: reconcile with the list""",
    """    const gap = !initial && allNew(feed);
    if (gap) state.scanDone = false;                                 // still a gap: reconcile with the list""")
rep("""    for (const [id, p] of state.pendingRefresh) if (!byClicker.has(id)) byClicker.set(id, p);
    let authErr = null;""",
    """    for (const [id, p] of state.pendingRefresh) if (!byClicker.has(id)) byClicker.set(id, p);
    if (gap) for (const c of state.clickers.values()) {
      if (c.state === 'OPEN' && !byClicker.has(c.id)) byClicker.set(c.id, { latest: { type: 'GAP' }, ids: [] });
    }
    let authErr = null;""")

# ---- #3 + #4: cross-tab serialized voting, stamped sends, shared verification/repair path
old_send_start = s.index("  async function sendVote(id, { repair = 0 } = {}) {")
old_send_end = s.index("  function setStatus(id, kind, text) {")
s = s[:old_send_start] + r"""  const fmtMs = (ms) => ms < 1000 ? ms + ' ms' : (ms / 1000).toFixed(1) + ' s';
  let stampCounter = 0;
  const newStamp = () => Date.now() * 1000 + (++stampCounter % 1000);
  const withVoteLock = (id, fn) => navigator.locks && navigator.locks.request
    ? navigator.locks.request('fast-clicker-vote-' + id, fn)   // one vote request per question across ALL tabs
    : fn();

  async function sendVote(id, { repair = 0 } = {}) {
    const c = state.clickers.get(id);
    if (!c) return;
    if (state.sending.has(id)) { state.resend.add(id); return; } // one request per question at a time
    const d = state.draft.get(id);
    const ans = d && d.gen === c.gen ? d.value : answerOf(c);
    const ver = d ? d.ver : 0;
    const gen = c.gen;
    if (typeof ans === 'string' ? !ans.trim() : !ans.length) return;
    state.sending.add(id);
    const stamp = newStamp();
    state.stamp.set(id, stamp);
    state.unverified.delete(id);
    broadcast({ t: 'send', id, stamp });                         // older sends in other tabs stop retrying
    const body = typeof ans === 'string' ? { individualAnswer: ans.trim() } : { selectedAnswer: [...ans] };
    const t0 = performance.now();
    const deadline = Date.now() + CFG.voteDeadlineMs;
    setStatus(id, 'pending', 'Sending…');
    let attempt = 0, delivered = false;
    try {
      await withVoteLock(id, async () => {
        for (;;) {
          const cur = state.clickers.get(id);
          if (state.stamp.get(id) !== stamp) { if (state.status.get(id)?.text === 'Sending…') state.status.delete(id); return; } // superseded
          if (cur.gen !== gen) { setStatus(id, 'warn', 'A new round started. Choose and send again.'); return; }
          if (cur.state !== 'OPEN') { setStatus(id, 'err', 'The question was closed before your answer got through.'); return; }
          if (state.authLost) {
            setStatus(id, 'warn', 'Login expired. Your answer is kept and will be sent right after login.');
            tryRelogin();
            if (!await waitForSession(deadline)) return;
            continue;
          }
          attempt++;
          try {
            await req(`clickers/${id}/vote`, { method: 'POST', body, kind: 'vote' });
            delivered = true;
            return;
          } catch (e) {
            if (e instanceof AuthError) { state.authLost = true; continue; }
            if (!isTransient(e)) {
              setStatus(id, 'err', e.status >= 400 && e.status < 500 ? `Not accepted (HTTP ${e.status}). Is the round still running?` : `Failed: ${e.message}`);
              attempt = -1; return;
            }
            if (Date.now() > deadline) return;
            setStatus(id, 'pending', `${e.message === 'offline' ? 'Offline' : 'Weak connection'}, still trying… (attempt ${attempt + 1})`);
            await waitOnlineOr(backoff(attempt, e.retryAfterMs));
          }
        }
      });
      if (!delivered) {
        if (attempt >= 0 && state.stamp.get(id) === stamp && state.clickers.get(id).gen === gen && state.clickers.get(id).state === 'OPEN') {
          setStatus(id, 'err', 'Could not reach EduApp for 2 minutes. Tap Send to try again.');
        }
        return;
      }
      fence(id);                                                 // only re-reads issued after the vote count
      const took = fmtMs(Math.round(performance.now() - t0)) + (attempt > 1 ? `, attempt ${attempt}` : '');
      if (state.stamp.get(id) === stamp) {
        setStatus(id, 'ok', `Sent ✓ accepted by the server (${took}). Verifying…`);
        state.unverified.set(id, { ans, gen, ver, stamp, took, repair, rechecks: 0 });
        verifyVote(id, stamp);                                   // in the background
      }
    } finally {
      state.sending.delete(id);
      render();
      if (state.resend.delete(id)) {
        const cur = state.draft.get(id);
        if (cur && cur.ver !== ver && cur.gen === state.clickers.get(id).gen) sendVote(id);
      }
    }
  }
  async function verifyVote(id, stamp) {
    for (let i = 0; i < 5; i++) {
      const u = state.unverified.get(id);
      if (!u || u.stamp !== stamp) return;                      // resolved, or superseded by a newer send
      try { await fetchClicker(id); return; }                   // fetchClicker → checkVerification
      catch { await sleep((hooks.timeScale || 1) * 1000 * (i + 1)); }
    }
    const u = state.unverified.get(id);
    if (u && u.stamp === stamp) { u.waiting = true; setStatus(id, 'ok', `Sent ✓ accepted by the server (${u.took}). Will double-check when the connection allows.`); }
  }
  // Called whenever a fresh (post-vote) detail of a question is applied, from any code path.
  function checkVerification(id, c) {
    const u = state.unverified.get(id);
    if (!u) return;
    if (u.gen !== c.gen || state.stamp.get(id) !== u.stamp || state.sending.has(id)) return;
    state.unverified.delete(id);
    publish(c, false);                                          // other tabs see the server's answer too
    if (sameAnswer(u.ans, answerOf(c))) {
      const cur = state.draft.get(id);
      if (cur && cur.ver === u.ver) state.draft.delete(id);
      setStatus(id, 'ok', `✓ Confirmed by the server (${u.took})`);
      return;
    }
    const cur = state.draft.get(id);
    const newer = cur && cur.ver !== u.ver;
    if (c.state === 'OPEN' && !newer && u.repair < 2) {         // e.g. an older request landed late
      setStatus(id, 'pending', 'The server shows a different answer. Re-sending yours…');
      if (!cur) setDraft(c, typeof u.ans === 'string' ? u.ans : [...u.ans]);
      setTimeout(() => sendVote(id, { repair: u.repair + 1 }), 0);
    } else if (!newer) {
      setStatus(id, 'warn', `The server shows a different answer${c.state !== 'OPEN' ? ' (question closed)' : ''}. Check and send again.`);
    }
  }
""" + s[old_send_end:]

# fetchClicker: route every applied post-vote detail through checkVerification
rep("""        state.clickers.set(id, c);
        const u = state.unverified.get(id);            // any later download can complete a pending verification
        if (u && u.gen === c.gen && state.sendSeq.get(id) === u.mySend && sameAnswer(u.ans, answerOf(c))) {
          state.unverified.delete(id);
          setStatus(id, 'ok', `✓ Confirmed by the server (${u.took})`);
        }
        return { detail: c, applied: true, fresh: c };""",
    """        state.clickers.set(id, c);
        if (my >= s.floor) checkVerification(id, c);   // any post-vote download can complete a verification
        return { detail: c, applied: true, fresh: c };""")

# recheck: bounded, through the same path
rep("""  function recheckUnverified() {
    if (state.authLost || hooks.offline) return;
    for (const [id, u] of state.unverified) {
      const c = state.clickers.get(id);
      if (!u.waiting || !c || c.state !== 'OPEN' || state.sendSeq.get(id) !== u.mySend) { if (!c || c.state !== 'OPEN') state.unverified.delete(id); continue; }
      fetchClicker(id).then(render).catch(() => {});
    }
  }""",
    """  function recheckUnverified() {
    if (state.authLost || hooks.offline) return;
    for (const [id, u] of state.unverified) {
      const c = state.clickers.get(id);
      if (!c || c.state !== 'OPEN' || state.stamp.get(id) !== u.stamp) { state.unverified.delete(id); continue; }
      if (!u.waiting) continue;
      if (++u.rechecks > 12) {                                   // ~2 min: stop downloading, say so
        state.unverified.delete(id);
        setStatus(id, 'ok', `Sent ✓ accepted by the server (${u.took}). Couldn't double-check on this connection.`);
        continue;
      }
      fetchClicker(id).then(render).catch(() => {});
    }
  }""")

# ---- #8: protect the server harder when it slows down
rep("""      if (lat.feed > 4000) cadence = Math.max(cadence, Math.round(lat.feed * 1.5)); // server struggling: back off""",
    """      if (lat.feed > 2500) cadence = Math.max(cadence, Math.round(lat.feed * 3)); // server slower than usual: back off""")

open(p, "w", encoding="utf-8").write(s)
print("patched")
