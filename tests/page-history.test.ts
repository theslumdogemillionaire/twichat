import test from 'node:test'
import assert from 'node:assert/strict'
import { HISTORY_LIMIT, PageHistory, type Page } from '../src/renderer/page-history'

const room = (channel: string): Page => ({ view: 'room', channel })
const discover: Page = { view: 'discover' }
const settings: Page = { view: 'settings' }

test('a fresh trail goes nowhere', () => {
  const history = new PageHistory()
  assert.equal(history.current(), undefined)
  assert.equal(history.canBack(), false)
  assert.equal(history.canForward(), false)
  assert.equal(history.back(), undefined)
  assert.equal(history.forward(), undefined)
})

test('the first page is a root, not a step: there is nothing behind it', () => {
  const history = new PageHistory()
  history.push(discover)
  assert.deepEqual(history.current(), discover)
  assert.equal(history.canBack(), false)
})

test('back and forward walk the pages visited', () => {
  const history = new PageHistory()
  history.push(discover); history.push(room('zerator')); history.push(settings)
  assert.deepEqual(history.back(), room('zerator'))
  assert.deepEqual(history.back(), discover)
  assert.equal(history.canBack(), false)
  assert.deepEqual(history.forward(), room('zerator'))
  assert.deepEqual(history.forward(), settings)
  assert.equal(history.canForward(), false)
})

test('two channels are two pages, the same channel twice is one', () => {
  const history = new PageHistory()
  history.push(room('zerator')); history.push(room('ponce')); history.push(room('ponce'))
  assert.deepEqual(history.back(), room('zerator'))
  assert.equal(history.canBack(), false)
})

test('opening the page we are already on is not a move', () => {
  const history = new PageHistory()
  history.push(discover); history.push(settings); history.push(settings)
  assert.deepEqual(history.back(), discover)
  assert.deepEqual(history.forward(), settings)
  assert.equal(history.canForward(), false)
})

test('going somewhere new drops the branch forward held', () => {
  const history = new PageHistory()
  history.push(discover); history.push(room('zerator')); history.push(settings)
  history.back(); history.back()
  history.push(room('ponce'))
  assert.equal(history.canForward(), false)
  assert.deepEqual(history.back(), discover)
  assert.equal(history.canBack(), false)
})

test('returning to a page already behind us still counts as a move', () => {
  // The cursor sits on `discover`; pushing `settings` again is a step forward onto a new branch,
  // not a no-op, because it is not the page we stand on.
  const history = new PageHistory()
  history.push(discover); history.push(settings)
  history.back()
  history.push(settings)
  assert.deepEqual(history.back(), discover)
})

test('pruning drops the pages that no longer exist, wherever they stand', () => {
  const history = new PageHistory()
  history.push(room('zerator')); history.push(discover); history.push(room('ponce')); history.push(settings)
  history.back() // on `ponce`
  history.prune(page => page.channel !== 'ponce')
  assert.deepEqual(history.current(), discover)
  assert.deepEqual(history.back(), room('zerator'))
  assert.deepEqual(history.forward(), discover)
  assert.deepEqual(history.forward(), settings)
})

test('pruning a page before the cursor keeps the cursor on its own page', () => {
  const history = new PageHistory()
  history.push(room('zerator')); history.push(discover); history.push(settings)
  history.prune(page => page.channel !== 'zerator')
  assert.deepEqual(history.current(), settings)
  assert.deepEqual(history.back(), discover)
  assert.equal(history.canBack(), false)
})

test('pruning everything behind leaves only the way forward', () => {
  const history = new PageHistory()
  history.push(room('zerator')); history.push(discover)
  history.back() // on `zerator`
  history.prune(page => page.channel !== 'zerator')
  assert.equal(history.current(), undefined)
  assert.equal(history.canBack(), false)
  assert.equal(history.canForward(), true)
  assert.deepEqual(history.forward(), discover)
})

test('an untouched trail survives a prune that matches nothing', () => {
  const history = new PageHistory()
  history.push(room('zerator')); history.push(discover); history.push(settings)
  history.back()
  history.prune(() => true)
  assert.deepEqual(history.current(), discover)
  assert.equal(history.canForward(), true)
})

test('the trail stops growing, dropping the oldest pages', () => {
  const history = new PageHistory()
  for (let index = 0; index < HISTORY_LIMIT + 10; index++) history.push(room(`channel${index}`))
  // The cursor stays on the page just opened, and exactly the cap stands behind it.
  assert.deepEqual(history.current(), room(`channel${HISTORY_LIMIT + 9}`))
  let steps = 0
  while (history.canBack()) { history.back(); steps++ }
  assert.equal(steps, HISTORY_LIMIT - 1)
  assert.deepEqual(history.current(), room(`channel${10}`))
})

test('a reset trail is a fresh one', () => {
  const history = new PageHistory()
  history.push(discover); history.push(settings)
  history.reset()
  assert.equal(history.current(), undefined)
  assert.equal(history.canBack(), false)
  assert.equal(history.canForward(), false)
})
