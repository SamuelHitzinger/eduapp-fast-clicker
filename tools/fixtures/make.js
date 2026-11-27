// Writes the synthetic EduApp data the tests run against (tools/fixtures/*.json), so the tests need nothing
// captured from ETH and run the same on any checkout and in CI. Shapes follow EduApp's API; every text,
// answer and result here is made up. Run: node tools/fixtures/make.js   (the output is committed)
const fs = require('fs'), path = require('path');

// a small deterministic random generator, so the files only change when this script does
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (a) => a[Math.floor(rnd() * a.length)];

const A = { code: '401-0261-00', type: 'V', title: { de: 'Analysis I', en: 'Analysis I' } };      // the course the tests use
const B = { code: '000-0000-00', type: 'V', title: { de: 'Beispielkurs' } };                      // a second course, German title only

const text = (n) => `<p>Example question ${n}: which statements are true?</p>` + (n % 5 === 0 ? `<p><svg xmlns="http://www.w3.org/2000/svg" width="40" height="12"><text x="0" y="10">x²</text></svg></p>` : '');
const RESULTS = ['UNANSWERED', 'UNANSWERED', 'UNANSWERED', 'CORRECT', 'WRONG', 'PARTLY_CORRECT'];
let qn = 0;
const clicker = (id, type, state = 'CLOSED', answerState = pick(RESULTS)) =>
  ({ id, type, state, answerState: type === 'TEXT' ? 'UNANSWERED' : answerState, title: `Q${++qn}`, question: text(qn), preview: false });

// lecture days with the clickers that ran on them (newest first), as EduApp lists them
const DAYS = [
  ['2026-11-09', [[A, [[322453, 'MCMA'], [322454, 'MCMA', 'OPEN', 'UNANSWERED']]]]],
  ['2026-11-06', [[A, [[322457, 'MCSA'], [322458, 'MCSA']]]]],
  ['2026-11-04', [[A, [[322392, 'MCMA'], [322393, 'MCMA']]]]],
  ['2026-11-02', [[B, [[321664, 'MCSA'], [321665, 'MCSA']]]]],
  ['2026-10-30', [[A, [[322482, 'MCSA']]]]],
  ['2026-10-28', [[A, [[322412, 'MCMA'], [322404, 'MCMA']]]]],
  ['2026-10-26', [[A, [[322441, 'MCMA'], [322442, 'MCMA'], [322443, 'MCSA'], [322444, 'MCSA'], [322446, 'MCSA'], [322445, 'MCSA'], [322447, 'MCMA']]],
                  [B, [[321634, 'MCMA'], [321635, 'MCMA'], [321636, 'MCSA']]]]],
  ['2026-10-23', [[A, [[322483, 'MCSA'], [322484, 'MCSA'], [322485, 'MCSA'], [322486, 'TEXT'], [322487, 'MCMA'], [322488, 'MCSA'], [322489, 'MCSA'], [322490, 'MCSA'], [322491, 'MCSA'], [322492, 'MCSA'], [322493, 'MCSA'], [322494, 'MCSA']]]]],
  ['2026-10-21', [[A, [[322420, 'MCSA'], [322421, 'MCSA'], [322422, 'MCSA'], [322423, 'MCSA'], [322424, 'MCSA'], [322425, 'MCSA'], [322426, 'MCMA'], [322427, 'MCMA'], [322428, 'MCSA'], [322429, 'MCSA'], [322430, 'MCSA'], [322432, 'MCSA']]]]],
  ['2026-10-19', [[B, [[321639, 'MCSA'], [321640, 'MCSA']]]]],
  ['2026-10-16', [[A, [[322462, 'MCSA'], [322463, 'MCSA'], [322464, 'MCMA'], [322465, 'MCSA'], [322466, 'TEXT'], [322467, 'MCSA'], [322469, 'MCSA'], [322470, 'MCSA'], [322471, 'MCMA'], [322472, 'MCSA'], [322474, 'MCSA'], [322475, 'MCSA'], [322477, 'MCSA']]]]],
  ['2026-10-14', [[A, [[322399, 'MCSA'], [322398, 'MCMA']]]]],
  ['2026-10-12', [[A, [[322448, 'MCMA'], [322449, 'MCMA']]], [B, [[321658, 'MCMA'], [321659, 'MCMA']]]]],
  ['2026-10-07', [[A, [[322401, 'MCSA'], [322402, 'MCMA']]]]],
  ['2026-10-05', [[B, [[321630, 'MCSA'], [321632, 'MCSA']]]]],
  ['2026-09-30', [[A, [[322440, 'MCMA'], [322418, 'MCMA'], [322419, 'MCMA']]]]],
  ['2026-09-28', [[A, [[322439, 'MCSA']]], [B, [[321652, 'MCMA'], [321653, 'MCMA'], [321654, 'MCSA']]]]],
  ['2026-09-25', [[A, [[322499, 'MCMA']]]]],
  ['2026-09-23', [[A, [[322396, 'MCMA'], [322397, 'MCSA']]]]],
  ['2026-09-21', [[B, [[321656, 'MCMA'], [321657, 'MCSA']]]]],
  ['2026-09-18', [[A, [[322495, 'MCMA']]]]],
  ['2026-09-16', [[A, [[322416, 'MCSA'], [322417, 'MCMA']]]]],
];

const byId = new Map();
const byDate = DAYS.map(([date, courses]) => ({
  date,
  courses: courses.map(([course, cs]) => ({ ...course, clickers: cs.map(([id, type, state, ans]) => { const c = clicker(id, type, state, ans); byId.set(id, { c, course }); return c; }) })),
}));
const byCourse = [B, A].map((course) => ({ ...course, clickers: [...byId.values()].filter((x) => x.course === course).map((x) => x.c).reverse() }));

// the open question (MCMA, five options, results shown after closing)
const detail = {
  id: 322454, type: 'MCMA', state: 'OPEN', title: byId.get(322454).c.title,
  question: '<p>Example: which of these functions are continuous on [0, 1]?</p><p><svg xmlns="http://www.w3.org/2000/svg" width="60" height="14"><text x="0" y="11">f(x)</text></svg></p>',
  answerState: 'UNANSWERED',
  entries: ['x²', '1/x', '|x|', 'sin x', '⌊x⌋'].map((a, i) => ({ id: 633799 + i, answer: `<p>${a}</p>`, selected: false })),
  showResults: true, preview: false,
};

// the activity feed (newest first): the open question's round was just stopped, older questions closed
const feedOf = (id, type, createdAt) => ({ objectType: 'CLICKER', type, objectId: id, itemId: 0, createdAt, objectTitle: byId.get(id) ? byId.get(id).c.title : 'Q', message: { de: 'Eine Umfrage wurde aktualisiert', en: 'A poll was updated' } });
const ev = [
  { objectType: 'CHANNEL', type: 'CHANNEL_COMMENT_CREATE', objectId: 236376, itemId: 34342, createdAt: '2026-11-09T13:02:42.394Z', objectTitle: 'Forum', message: { de: 'Neuer Kommentar', en: 'New comment' } },
  feedOf(322454, 'CLICKER_STOP_ROUND', '2026-11-09T12:56:40.722Z'),
  feedOf(322453, 'CLICKER_CLOSE', '2026-11-09T11:33:29.185Z'),
  feedOf(322458, 'CLICKER_CLOSE', '2026-11-06T08:40:23.026Z'),
  feedOf(322457, 'CLICKER_CLOSE', '2026-11-06T07:52:18.405Z'),
  feedOf(322393, 'CLICKER_CLOSE', '2026-11-04T08:54:43.963Z'),
  feedOf(322392, 'CLICKER_CLOSE', '2026-11-04T07:40:27.888Z'),
  feedOf(321665, 'CLICKER_CLOSE', '2026-11-02T14:40:31.868Z'),
  feedOf(321664, 'CLICKER_CLOSE', '2026-11-02T14:26:36.386Z'),
  feedOf(322482, 'CLICKER_CLOSE', '2026-10-30T08:45:40.812Z'),
  feedOf(322412, 'CLICKER_CLOSE', '2026-10-30T06:43:12.267Z'),
  feedOf(322404, 'CLICKER_CLOSE', '2026-10-28T08:46:20.439Z'),
  feedOf(321636, 'CLICKER_CLOSE', '2026-10-26T14:53:51.004Z'),
  feedOf(321635, 'CLICKER_CLOSE', '2026-10-26T14:48:31.218Z'),
  feedOf(321634, 'CLICKER_CLOSE', '2026-10-26T14:32:55.123Z'),
  ...[322447, 322494, 322493, 322492, 322432, 322430, 322429, 322428, 322427].map((id, i) => feedOf(id, 'CLICKER_CLOSE', new Date(Date.parse('2026-10-26T13:39:55.985Z') - i * 7).toISOString())),
  feedOf(322445, 'CLICKER_CLOSE', '2026-10-26T12:57:02.921Z'),
];
let actId = 474463;
const feed = ev.map((e, i) => ({ id: actId - i * 3, ...e, courseTitle: e.objectId && byId.get(e.objectId) ? byId.get(e.objectId).course.title : A.title }));

const out = __dirname;
fs.writeFileSync(path.join(out, 'clickers_list.json'), JSON.stringify({ byCourse, byDate }, null, 1) + '\n');
fs.writeFileSync(path.join(out, 'activity_feed.json'), JSON.stringify(feed, null, 1) + '\n');
fs.writeFileSync(path.join(out, 'clicker_322454.json'), JSON.stringify(detail, null, 1) + '\n');
console.log(`fixtures: ${byId.size} clickers in ${byDate.length} days, ${feed.length} feed events`);
