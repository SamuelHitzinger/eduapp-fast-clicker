// Writes the synthetic EduApp data the tests run against (tools/fixtures/*.json), so the tests need nothing
// captured from ETH and run the same on any checkout and in CI. The shapes follow EduApp's API; every id (except the
// three question ids the tests have always named: 322454 open, 322453 and 322458 closed), date, text, answer and
// result here is made up.
// Run: node tools/fixtures/make.js   (the output is committed; CI checks it is up to date)
const fs = require('fs'), path = require('path');

// a small deterministic random generator, so the files only change when this script does
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (a) => a[Math.floor(rnd() * a.length)];

const A = { code: '401-0261-00', type: 'V', title: { de: 'Analysis I', en: 'Analysis I' } };      // the course the tests use
const B = { code: '000-0000-00', type: 'V', title: { de: 'Beispielkurs' } };                      // a second course, German title only
const OPEN_ID = 322454;

const text = (n) => `<p>Example question ${n}: which statements are true?</p>` + (n % 5 === 0 ? `<p><svg xmlns="http://www.w3.org/2000/svg" width="40" height="12"><text x="0" y="10">x²</text></svg></p>` : '');
const RESULTS = ['UNANSWERED', 'UNANSWERED', 'UNANSWERED', 'CORRECT', 'WRONG', 'PARTLY_CORRECT'];
const TYPES = ['MCSA', 'MCSA', 'MCMA'];

// 22 lecture days, newest first: course A on most days, course B on some; 1–13 questions a day
const days = [];
let day = Date.parse('2026-03-30T00:00:00Z');
for (let i = 0; i < 22; i++) {
  const courses = [];
  if (i % 4 !== 3) courses.push([A, i === 0 ? 2 : 1 + Math.floor(rnd() * (i % 5 === 0 ? 12 : 3))]);
  if (i % 3 === 1 || i % 4 === 3) courses.push([B, 1 + Math.floor(rnd() * 3)]);
  days.push({ date: new Date(day).toISOString().slice(0, 10), at: day, courses });
  day -= (i % 2 ? 3 : 2) * 86400e3;                             // Mon/Wed/Fri-ish rhythm
}

let nextId = 610001, qn = 0;
const byId = new Map();
const byDate = days.map((d, di) => ({
  date: d.date,
  courses: d.courses.map(([course, count], ci) => ({
    ...course,
    clickers: Array.from({ length: count }, (_, k) => {
      const open = di === 0 && ci === 0 && k === count - 1;       // the newest question of the newest day is open
      const id = open ? OPEN_ID : di === 0 && ci === 0 && k === 0 ? 322453 : di === 1 && ci === 0 && k === 0 ? 322458 : nextId++;
      const type = open ? 'MCMA' : (k % 11 === 4 ? 'TEXT' : pick(TYPES));
      const c = { id, type, state: open ? 'OPEN' : 'CLOSED', answerState: open || type === 'TEXT' ? 'UNANSWERED' : pick(RESULTS), title: `Q${++qn}`, question: text(qn), preview: false };
      // closed at a made-up time of that day (newer questions later in the day)
      byId.set(id, { c, course, closedAt: d.at + (9 * 3600 + ci * 4 * 3600 + k * 600 + Math.floor(rnd() * 300)) * 1000 + Math.floor(rnd() * 1000) });
      return c;
    }),
  })),
}));
const byCourse = [B, A].map((course) => ({ ...course, clickers: [...byId.values()].filter((x) => x.course === course).map((x) => x.c).reverse() }));

// the open question (MCMA, five options, results shown after closing)
const detail = {
  id: OPEN_ID, type: 'MCMA', state: 'OPEN', title: byId.get(OPEN_ID).c.title,
  question: '<p>Example: which of these functions are continuous on [0, 1]?</p><p><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14"><text x="0" y="11">f(x)</text></svg></p>',
  answerState: 'UNANSWERED',
  entries: ['x²', '1/x', '|x|', 'sin x', '⌊x⌋'].map((a, i) => ({ id: 7001 + i, answer: `<p>${a}</p>`, selected: false })),
  showResults: true, preview: false,
};

// the activity feed (25 newest events, newest first): a forum comment, the open question's round just stopped,
// then the closing of the most recent other questions
const msg = { de: 'Eine Umfrage wurde aktualisiert', en: 'A poll was updated' };
const openAt = byId.get(OPEN_ID).closedAt;
const closed = [...byId.entries()].filter(([id]) => id !== OPEN_ID).sort((a, b) => b[1].closedAt - a[1].closedAt).slice(0, 23);
const ev = [
  { objectType: 'CHANNEL', type: 'CHANNEL_COMMENT_CREATE', objectId: 90001, itemId: 90002, createdAt: new Date(openAt + 360e3).toISOString(), objectTitle: 'Forum', message: { de: 'Neuer Kommentar', en: 'New comment' }, courseTitle: A.title },
  { objectType: 'CLICKER', type: 'CLICKER_STOP_ROUND', objectId: OPEN_ID, itemId: 0, createdAt: new Date(openAt).toISOString(), objectTitle: detail.title, message: msg, courseTitle: A.title },
  ...closed.map(([id, x]) => ({ objectType: 'CLICKER', type: 'CLICKER_CLOSE', objectId: id, itemId: 0, createdAt: new Date(x.closedAt).toISOString(), objectTitle: x.c.title, message: msg, courseTitle: x.course.title })),
];
const feed = ev.map((e, i) => ({ id: 880100 - i * 3, ...e }));

const out = __dirname;
fs.writeFileSync(path.join(out, 'clickers_list.json'), JSON.stringify({ byCourse, byDate }, null, 1) + '\n');
fs.writeFileSync(path.join(out, 'activity_feed.json'), JSON.stringify(feed, null, 1) + '\n');
fs.writeFileSync(path.join(out, 'clicker_322454.json'), JSON.stringify(detail, null, 1) + '\n');
console.log(`fixtures: ${byId.size} clickers in ${byDate.length} days, ${feed.length} feed events`);
