// Tiny test harness: `test(name, fn)` registers, `runAll()` runs and reports.
import assert from 'node:assert/strict';

const tests = [];
export function test(name, fn) {
  tests.push({ name, fn });
}

export async function runAll(label) {
  let pass = 0;
  let fail = 0;
  for (const { name, fn } of tests.splice(0)) {
    try {
      await fn();
      pass++;
      console.log(`  ok   ${name}`);
    } catch (e) {
      fail++;
      console.log(`  FAIL ${name}\n       ${String(e && e.stack || e).split('\n').slice(0, 6).join('\n       ')}`);
    }
  }
  console.log(`${label}: ${pass} passed, ${fail} failed`);
  return { pass, fail };
}

export { assert };
