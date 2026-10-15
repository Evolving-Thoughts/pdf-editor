import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runQaStep } from './qa-step.mjs'

async function check(args, verify, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'qa-step-test-')),
    output = []
  try {
    const result = await runQaStep({
      name: 'fixture',
      command: process.execPath,
      args,
      root,
      print: (line) => output.push(line),
      ...options,
    })
    verify(
      result,
      output.join('\n'),
      readFileSync(join(root, 'fixture.log'), 'utf8'),
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
test('a failed assertion remains failed and its final stack is visible in CI', async () => {
  await check(
    [
      '-e',
      "console.log('SETUP OK'); console.error('AssertionError: active match covered by search panel'); process.exitCode = 3",
    ],
    (result, visible, full) => {
      assert.equal(result.status, 'FAIL')
      assert.equal(result.code, 3)
      assert.match(
        visible,
        /AssertionError: active match covered by search panel/,
      )
      assert.match(full, /AssertionError/)
    },
  )
})
test('failure output is bounded but its full log is retained', async () => {
  await check(
    ['-e', "for(let i=0;i<100;i++)console.log('LINE_'+i);process.exitCode=1"],
    (result, visible, full) => {
      assert.equal(result.status, 'FAIL')
      assert.doesNotMatch(visible, /LINE_0\n/)
      assert.match(visible, /LINE_99/)
      assert.match(full, /LINE_0\n/)
    },
  )
})
test('passing output is not echoed as a failure', async () => {
  await check(
    ['-e', "console.log('PASS fixture')"],
    (result, visible, full) => {
      assert.equal(result.status, 'PASS')
      assert.doesNotMatch(visible, /last 60/)
      assert.match(full, /PASS fixture/)
    },
  )
})
test('a timed-out step is explicitly identified and remains failed', async () => {
  await check(
    ['-e', 'setInterval(()=>{},1000)'],
    (result, visible) => {
      assert.equal(result.status, 'FAIL')
      assert.equal(result.timedOut, true)
      assert.match(visible, /TIMEOUT/)
    },
    { timeoutMs: 150 },
  )
})
