// Offline smoke test: mount the plugin against a fake Host and exercise every tool.
// Run with `node test/smoke.mjs` (or `npm test`); it needs no DSH runtime and touches no network.
import { apply } from '../index.js'

const SELF = 'session-self'
const TARGET = 'session-target'

// ---- fake session history -------------------------------------------------
const events = []
let seq = 0
function push(type, data) {
  events.push({ event: { type, seq: seq++, time: Date.now(), data } })
}
function user(text, kind = 'user') {
  push('user/message', { role: 'user', content: [{ type: 'text', text }], source: { kind } })
}
function assistant(text) {
  push('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text }] }, source: { kind: 'model' } })
}
function toolCall(name, args) {
  push('tool/call', { turn: 1, step: 1, callId: 'c1', name, arguments: args })
}
function toolResult(text) {
  push('tool/result', { message: { role: 'tool', content: [{ type: 'text', text }] } })
}

user('第一条：只回复 OK', 'plugin:meow-memory')
assistant('OK')
user('第二条：读一下日志')
toolCall('bash', '{"command":"ls"}')
toolResult('a.txt b.txt')
assistant('日志里有两个文件')
user('第三条：搜索“关键字甲”试试')
assistant('好的，关键字甲我记住了')
user('第四条')
assistant('收到第四条')

// ---- fake Host ------------------------------------------------------------
const tools = {}
const services = {
  sessionController: {
    async list() {
      return {
        items: [
          { sessionId: TARGET, cwd: '/tmp/fake', updatedAt: Date.now(), blank: false, running: false },
          { sessionId: SELF, cwd: '/tmp/fake', updatedAt: Date.now(), blank: false, running: true },
        ],
      }
    },
    async state({ sessionId }) {
      return { sessionId, cursor: events.length, active: true, running: false, queue: [], pendingInput: [] }
    },
    async create({ cwd }) {
      return { sessionId: 'session-created', cwd }
    },
    async prompt() {
      return { accepted: true }
    },
    async cancel() {
      return { accepted: true }
    },
    async updateQueue() {
      return { accepted: true }
    },
    async rename() {
      return { title: 'x', seq: 1 }
    },
    async wait() {
      return { reason: 'idle', state: { running: false, queue: [], pendingInput: [] }, output: { records: events.slice(-1), truncated: false } }
    },
    // Paging emulation: newest page by default, beforeSeq is EXCLUSIVE.
    async events(request) {
      const limit = Number(request.maxMessages ?? 20)
      let window = events
      if (Number.isFinite(request.beforeSeq)) {
        window = events.filter(entry => entry.event.seq < request.beforeSeq)
      }
      if (Number.isFinite(request.throughSeq)) {
        window = window.filter(entry => entry.event.seq <= request.throughSeq)
      }
      // Simulate a server that pages tighter than requested, so multi-page walking is exercised.
      const slice = window.slice(-Math.min(Math.max(limit, 1), 4))
      return {
        records: slice,
        hasMore: window.length > slice.length,
        cursor: slice.length ? slice[slice.length - 1].event.seq + 2 : 0,
      }
    },
  },
  workspaceRegistry: {
    async archiveSession() {},
    async unarchiveSession() {},
    async resolveByPath() {
      return undefined
    },
  },
}

const ctx = {
  get(name) {
    return services[name]
  },
  effect(fn) {
    return fn()
  },
  logger: { warn: (...args) => console.error('warn:', ...args), info() {} },
  tools: {
    register(definition) {
      tools[definition.name] = definition
      return () => {}
    },
  },
}

apply(ctx, {})
const names = Object.keys(tools).sort()
console.log('registered tools:', names.join(', '))

const exec = { agent: { id: SELF }, signal: undefined }
async function call(name, args) {
  const definition = tools[name]
  if (!definition) throw new Error(`missing tool ${name}`)
  const value = await definition.execute(args, exec)
  const rendered = definition.output?.render?.(args, value) ?? []
  return { value, text: rendered.map(block => block.text).join('\n') }
}

const failures = []
function check(label, condition, detail) {
  if (condition) {
    console.log(`PASS ${label}`)
  } else {
    failures.push(label)
    console.log(`FAIL ${label}\n${detail ?? ''}`)
  }
}

// 1. tail
const tail = await call('sessions_read', { sessionId: TARGET, limit: 2 })
check('tail returns the newest messages', tail.value.at === 'tail' && tail.value.messages.at(-1)?.text === '收到第四条', tail.text)
check('tail reports more_before', tail.value.more_before === true, JSON.stringify(tail.value))

// 2. head — must walk back to the true beginning
const head = await call('sessions_read', { sessionId: TARGET, at: 'head', limit: 2 })
check('head starts at the first message', head.value.messages[0]?.text.startsWith('第一条'), head.text)
check('head scanned the whole log', head.value.more_before === false, JSON.stringify({ pages: head.value.pages, scanned: head.value.scanned, more_before: head.value.more_before }))
check('head paged more than once', head.value.pages >= 2, `pages=${head.value.pages}`)

// 3. injected context is labelled
check('injected context is labelled', head.value.messages[0]?.role === 'context:meow-memory', JSON.stringify(head.value.messages[0]))

// 4. search hits a later message and continues forward
const found = await call('sessions_read', { sessionId: TARGET, query: '读一下日志', limit: 3 })
check('search finds the message', found.value.at === 'search' && found.value.matched === true, found.text)
check('search starts at the hit', found.value.messages[0]?.text.includes('读一下日志'), found.text)
check('search keeps following messages', found.value.messages.length > 1 && found.value.messages[1].seq > found.value.messages[0].seq, found.text)

// 5. search miss
const miss = await call('sessions_read', { sessionId: TARGET, query: '不存在的词zzz' })
check('search miss is explicit', miss.value.at === 'search-miss' && miss.value.messages.length === 0, miss.text)
check('search miss text has no contradiction', !miss.text.includes('本次'), miss.text)

// 6. fromSeq continues
const fromSeq = await call('sessions_read', { sessionId: TARGET, fromSeq: 6, limit: 2 })
check('fromSeq starts at or after the requested seq', fromSeq.value.messages[0]?.seq >= 6, fromSeq.text)

// 7. fromSeq beyond the end does not jump backwards
const beyond = await call('sessions_read', { sessionId: TARGET, fromSeq: 99999 })
check('fromSeq past the end is empty', beyond.value.messages.length === 0, beyond.text)
check('fromSeq past the end says so', beyond.value.at === 'beyond', beyond.text)

// 8. tool traffic only on request
const plain = await call('sessions_read', { sessionId: TARGET, at: 'head', limit: 20 })
check('default hides tool lines', !plain.value.messages.some(line => line.role.startsWith('tool')), plain.text)
const withTools = await call('sessions_read', { sessionId: TARGET, at: 'head', limit: 20, includeTools: true })
check('includeTools adds tool lines', withTools.value.messages.some(line => line.role === 'tool-call') && withTools.value.messages.some(line => line.role === 'tool-result'), withTools.text)

// 9. the rest of the toolkit still mounts and answers
const list = await call('sessions_list', { limit: 5 })
check('list hides the caller', list.value.sessions.every(row => row.session_id !== SELF), list.text)
const stopSelf = await call('sessions_stop', { sessionId: SELF }).then(() => 'no error', error => `error: ${error.message}`)
check('stop refuses to target the caller', stopSelf.startsWith('error:'), stopSelf)
const created = await call('sessions_create', { cwd: '/tmp/fake-project', title: '冒烟' })
check('create returns an id', created.value.session_id === 'session-created', created.text)
const sent = await call('sessions_send', { sessionId: TARGET, text: '继续' })
check('send accepts the alias-free form', sent.value.mode === 'queue', sent.text)
const sentAlias = await call('sessions_send', { sessionId: TARGET, message: '继续' })
check('send accepts a message alias', sentAlias.value.mode === 'queue', sentAlias.text)
const waited = await call('sessions_wait', { sessionId: TARGET, timeoutMs: 1000 })
check('wait returns a reason', typeof waited.value.reason === 'string', waited.text)

console.log('\n--- sample renders ---')
console.log(head.text)
console.log('')
console.log(miss.text)

console.log(failures.length === 0 ? '\nALL CHECKS PASSED' : `\n${failures.length} FAILED: ${failures.join(' | ')}`)
process.exitCode = failures.length === 0 ? 0 : 1
