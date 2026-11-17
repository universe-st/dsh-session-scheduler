/**
 * dsh-session-scheduler — 「会话调度」: let one agent drive other conversations.
 *
 * Tools (all prefixed `sessions_`):
 * - sessions_list       read the visible sessions with their live status
 * - sessions_create     open a session in any project directory
 * - sessions_send       deliver a message to a running or stopped session (queue / steer)
 * - sessions_stop       cancel the active turn of a session
 * - sessions_archive    archive a session
 * - sessions_unarchive  restore an archived session
 * - sessions_wait       block until a session goes idle or asks for input
 *
 * Every operation goes through the Host services the Web GUI itself uses —
 * `sessionController` for list/create/prompt/cancel/wait and `workspaceRegistry`
 * for archive/unarchive — so the Session log stays the single source of truth.
 * Nothing here keeps durable state of its own.
 */

import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

/** Loader entry name. */
export const name = 'sessionScheduler'

/** Tools are the only hard dependency; every Session service is looked up optionally. */
export const inject = ['tools']

const DEFAULT_WAIT_MS = 180_000
const MAX_WAIT_MS = 600_000
const MAX_LIST_ROWS = 200
const MAX_TAIL_CHARS = 12_000
const MAX_MESSAGES = 80
const STATE_CONCURRENCY = 6
const STOP_CONFIRM_MS = 15_000
const WAIT_TOOL_TIMEOUT_MS = MAX_WAIT_MS + 60_000

/**
 * Register the scheduling tools on the mounting scope.
 * @param ctx - Cordis context of the plugin.
 * @param config - Loader row config.
 */
export function apply(ctx, config = {}) {
  const settings = normalizeConfig(config)
  /** Aborted when the plugin unloads. */
  const lifecycle = new AbortController()
  ctx.effect(() => () => lifecycle.abort())

  /** @returns {any} the Session controller, or throws a user-facing error */
  function controller() {
    const service = ctx.get('sessionController')
    if (!service) throw new Error('sessionScheduler: 当前 profile 没有 sessionController，无法调度会话。')
    return service
  }

  /** @returns {any} the workspace registry, or throws a user-facing error */
  function registry() {
    const service = ctx.get('workspaceRegistry')
    if (!service) throw new Error('sessionScheduler: 当前 profile 没有 workspaceRegistry，无法归档或恢复会话。')
    return service
  }

  function warn(message) {
    ctx.logger?.warn?.(`sessionScheduler: ${message}`)
  }

  /**
   * Register one tool and tie its lifetime to the plugin.
   * @param definition - tool definition
   */
  function tool(definition) {
    ctx.effect(() => ctx.tools.register(definition))
  }

  // ------------------------------------------------------------ session reads

  /**
   * Read every visible Session row without resuming an Agent.
   * @param signal - cancellation
   * @returns {Promise<any[]>} summaries
   */
  async function listRows(signal) {
    const value = await controller().list({}, signal)
    const items = Array.isArray(value?.items) ? value.items : []
    return items.filter(item => item && typeof item.sessionId === 'string')
  }

  /**
   * Read passive state for a bounded set of sessions.
   * @param sessionIds - ids to read
   * @param signal - cancellation
   * @returns {Promise<Map<string, any>>} id to state
   */
  async function statesOf(sessionIds, signal) {
    const states = new Map()
    for (let index = 0; index < sessionIds.length; index += STATE_CONCURRENCY) {
      const slice = sessionIds.slice(index, index + STATE_CONCURRENCY)
      const settled = await Promise.all(slice.map(async (sessionId) => {
        try {
          return [sessionId, await controller().state({ sessionId }, signal)]
        } catch (error) {
          if (signal?.aborted) throw error
          return [sessionId, undefined]
        }
      }))
      for (const [sessionId, state] of settled) states.set(sessionId, state)
    }
    return states
  }

  /**
   * Read the title a Session shows in the GUI: its logged title event, then the
   * live title service, then the directory name.
   * @param row - SessionSummary
   * @returns {string} display title
   */
  function titleOf(row) {
    try {
      const values = row?.projections?.values
      const hinted = values && typeof values.title === 'string' ? values.title.trim() : ''
      if (hinted) return hinted
      const sessions = ctx.get('sessions')
      const titles = ctx.get('sessionTitle')
      const session = typeof sessions?.get === 'function' ? sessions.get(row.sessionId) : undefined
      if (session && typeof titles?.get === 'function') {
        const snapshot = titles.get(session)
        if (snapshot?.title) return String(snapshot.title).trim()
      }
    } catch (error) {
      warn(`title of ${row?.sessionId} was not readable: ${messageOf(error)}`)
    }
    return ''
  }

  /**
   * @param state - SessionState or undefined
   * @returns {string} one-word status
   */
  function statusOf(state) {
    if (!state) return 'unknown'
    const pending = Array.isArray(state.pendingInput) ? state.pendingInput : []
    if (pending.length > 0) return `waiting-${pending.join('+')}`
    if (state.running === true) return 'running'
    const queue = Array.isArray(state.queue) ? state.queue : []
    if (queue.length > 0) return 'queued'
    return 'idle'
  }

  /**
   * @param state - SessionState or undefined
   * @returns {number} queued message count
   */
  function queuedOf(state) {
    return Array.isArray(state?.queue) ? state.queue.length : 0
  }

  /**
   * @param state - SessionState or undefined
   * @returns {string[]} pending input kinds
   */
  function pendingOf(state) {
    return Array.isArray(state?.pendingInput) ? state.pendingInput.map(String) : []
  }

  /**
   * Build one model-facing row for a session.
   * @param row - SessionSummary
   * @param state - SessionState or undefined
   * @returns {object} row value
   */
  function toRow(row, state) {
    const title = titleOf(row) || (row?.cwd ? path.basename(String(row.cwd)) : '')
    return {
      session_id: String(row.sessionId),
      title: title || '(未命名)',
      cwd: typeof row?.cwd === 'string' ? row.cwd : '',
      status: statusOf(state),
      pending: pendingOf(state),
      queued: queuedOf(state),
      running: state ? state.running === true : row?.running === true,
      updated_at: iso(Number(row?.updatedAt ?? Date.now())),
    }
  }

  /**
   * Resolve a user-facing reference — exact id, id prefix, or title — to one session id.
   * @param target - id, id prefix, or title text
   * @param signal - cancellation
   * @returns {Promise<string>} exact session id
   */
  async function resolveSessionId(target, signal) {
    const text = String(target ?? '').trim()
    if (!text) throw new Error('请提供会话 id 或标题；可先调用 sessions_list 查看可用会话。')
    const rows = await listRows(signal)
    const exact = rows.find(row => String(row.sessionId) === text)
    if (exact) return String(exact.sessionId)
    const lower = text.toLowerCase()
    const byTitle = rows.filter(row => titleOf(row).toLowerCase() === lower)
    const byPrefix = rows.filter(row => String(row.sessionId).toLowerCase().startsWith(lower))
    const byContains = rows.filter(row => titleOf(row).toLowerCase().includes(lower))
    const candidates = []
    const seen = new Set()
    for (const row of [...byTitle, ...byPrefix, ...byContains]) {
      const id = String(row.sessionId)
      if (seen.has(id)) continue
      seen.add(id)
      candidates.push(row)
    }
    if (candidates.length === 1) return String(candidates[0].sessionId)
    if (candidates.length === 0) {
      throw new Error(`没有找到与会话「${text}」匹配的会话；请先调用 sessions_list 取得 session id。`)
    }
    const lines = candidates.slice(0, 8).map(row => `- ${titleOf(row) || '(未命名)'}｜${String(row.sessionId)}`)
    throw new Error(`会话「${text}」有 ${candidates.length} 个候选，请改用 session id：\n${lines.join('\n')}`)
  }

  /**
   * Resolve a target, but keep a literal id that list does not return — an
   * archived session is invisible yet still addressable by id.
   * @param target - id or title
   * @param signal - cancellation
   * @returns {Promise<string>} session id
   */
  async function resolveLoose(target, signal) {
    const text = String(target ?? '').trim()
    if (!text) throw new Error('请提供会话 id 或标题。')
    try {
      return await resolveSessionId(text, signal)
    } catch (error) {
      if (looksLikeSessionId(text)) return text
      throw error
    }
  }

  /**
   * Refuse to act destructively on the session that is running this call.
   * @param sessionId - resolved target
   * @param exec - tool run context
   * @param verb - what the caller was about to do
   */
  function assertNotSelf(sessionId, exec, verb) {
    const selfId = String(exec?.agent?.id ?? '')
    if (selfId && selfId === sessionId) {
      throw new Error(`${verb}的目标就是本会话自己；请指定另一个会话。`)
    }
  }

  // ------------------------------------------------------------------- tools

  tool({
    name: 'sessions_list',
    description:
      '列出本机可见的会话及其实时状态（running / idle / waiting-approval|question / queued），'
      + '用于在给别的会话发消息、停止、归档或等待之前找到它的 session id。'
      + '默认隐藏空白会话、子代理会话和调用者自己；结果按最近活动排序。'
      + '返回的 total 是符合筛选条件的会话总数，shown 是本次返回的行数。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        cwd: { type: 'string', description: '只看该目录（含子目录）下的会话；省略则列全部可见会话。' },
        sessionId: { type: 'string', description: '只看一个会话：id、id 前缀或标题；可用于查看它此刻的状态。' },
        runningOnly: { type: 'boolean', description: '只列出正在运行（有回合在执行）的会话，默认 false。' },
        includeBlank: { type: 'boolean', description: '包含还没有任何消息的空白会话，默认 false。' },
        includeSubagents: { type: 'boolean', description: '包含子代理会话，默认 false。' },
        limit: { type: 'integer', description: '最多返回多少行，默认 20，最大 200。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          total: { type: 'integer' },
          shown: { type: 'integer' },
          running_only: { type: 'boolean' },
          sessions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                session_id: { type: 'string' },
                title: { type: 'string' },
                cwd: { type: 'string' },
                status: { type: 'string' },
                pending: { type: 'array', items: { type: 'string' } },
                queued: { type: 'integer' },
                running: { type: 'boolean' },
                updated_at: { type: 'string' },
              },
              required: ['session_id', 'title', 'cwd', 'status', 'queued', 'updated_at'],
              additionalProperties: true,
            },
          },
        },
        required: ['total', 'shown', 'sessions'],
        additionalProperties: true,
      },
      render: (_args, value) => [{ type: 'text', text: renderList(value) }],
    },
    async execute(args, exec) {
      const input = asObject(args)
      const signal = exec?.signal ?? lifecycle.signal
      const limit = clampInt(input.limit, 1, MAX_LIST_ROWS, 20)
      const selfId = String(exec?.agent?.id ?? '')

      if (input.sessionId) {
        const sessionId = await resolveLoose(input.sessionId, signal)
        const rows = (await listRows(signal)).filter(row => String(row.sessionId) === sessionId)
        const states = await statesOf([sessionId], signal)
        const state = states.get(sessionId)
        const row = rows[0] ?? { sessionId, cwd: '', updatedAt: Date.now() }
        const single = toRow(row, state)
        return { total: 1, shown: 1, sessions: [single] }
      }

      const filterCwd = typeof input.cwd === 'string' && input.cwd.trim()
        ? path.resolve(expandHome(input.cwd.trim()))
        : ''
      let rows = await listRows(signal)
      rows = rows.filter((row) => {
        if (String(row.sessionId) === selfId) return false
        if (input.includeSubagents !== true && row.origin === 'subagent') return false
        if (input.includeBlank !== true && row.blank === true) return false
        if (filterCwd) {
          const cwd = typeof row.cwd === 'string' ? row.cwd : ''
          if (cwd !== filterCwd && !cwd.startsWith(`${filterCwd}${path.sep}`)) return false
        }
        return true
      })
      rows.sort((left, right) => Number(right.updatedAt ?? 0) - Number(left.updatedAt ?? 0))
      const matched = rows
      const selected = []
      if (input.runningOnly !== true) {
        const page = matched.slice(0, limit)
        const states = await statesOf(page.map(row => String(row.sessionId)), signal)
        for (const row of page) selected.push(toRow(row, states.get(String(row.sessionId))))
      } else {
        // Running sessions can sit anywhere in the ordering: scan in chunks until the page fills.
        for (let index = 0; index < matched.length && selected.length < limit; index += 20) {
          const chunk = matched.slice(index, index + 20)
          const states = await statesOf(chunk.map(row => String(row.sessionId)), signal)
          for (const row of chunk) {
            const value = toRow(row, states.get(String(row.sessionId)))
            if (!value.running) continue
            selected.push(value)
            if (selected.length >= limit) break
          }
        }
      }
      return {
        total: matched.length,
        shown: selected.length,
        sessions: selected,
        ...(input.runningOnly === true ? { running_only: true } : {}),
      }
    },
  })

  tool({
    name: 'sessions_create',
    description:
      '在指定项目目录新开一个会话（加入该目录对应的工作区），可选立刻发第一条消息让它开始干活。'
      + '新会话默认使用当前 profile 的默认模型与预设；不会把本会话的上下文带过去，所以消息要写完整。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['cwd'],
      properties: {
        cwd: { type: 'string', description: '项目目录的绝对路径；不存在会自动创建。' },
        title: { type: 'string', description: '会话标题，显示在会话列表里。' },
        message: { type: 'string', description: '发给新会话的第一条消息；省略则只创建空会话，等以后再发。' },
        agentPreset: { type: 'string', description: '该会话使用的 agent 预设 id；省略则用部署默认。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          title: { type: 'string' },
          cwd: { type: 'string' },
          status: { type: 'string' },
          workspace: { type: 'string' },
          agent_preset: { type: 'string' },
        },
        required: ['session_id', 'title', 'cwd', 'status'],
        additionalProperties: true,
      },
      render: (_args, value) => [{
        type: 'text',
        text: `已在 ${value.cwd} 新开会话「${value.title}」｜${value.session_id}｜${value.status}`
          + (value.workspace ? `\n工作区：${value.workspace}` : ''),
      }],
    },
    async execute(args, exec) {
      const input = asObject(args)
      const signal = exec?.signal ?? lifecycle.signal
      const cwd = path.resolve(expandHome(requireText(input.cwd, 'cwd')))
      await mkdir(cwd, { recursive: true })
      const preset = typeof input.agentPreset === 'string' && input.agentPreset.trim()
        ? input.agentPreset.trim()
        : settings.agentPreset
      const created = await controller().create({
        cwd,
        ...(preset ? { agentPreset: preset } : {}),
      })
      const sessionId = String(created?.sessionId ?? '')
      if (!sessionId) throw new Error('sessionController.create 没有返回 sessionId。')
      const title = typeof input.title === 'string' && input.title.trim()
        ? input.title.trim()
        : path.basename(cwd)
      await nameSession(sessionId, title)
      const workspace = await joinWorkspace(sessionId, cwd, title)
      const message = typeof input.message === 'string' ? input.message.trim() : ''
      if (message) {
        await controller().prompt({
          requestId: `sessionScheduler-${randomUUID()}`,
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: message }],
        }, signal)
      }
      return {
        session_id: sessionId,
        title,
        cwd,
        status: message ? '已启动，正在执行' : '空会话，等待消息',
        ...(workspace ? { workspace } : {}),
        ...(created?.agentPreset ? { agent_preset: String(created.agentPreset) } : {}),
      }
    },
  })

  tool({
    name: 'sessions_send',
    description:
      '向任意会话发一条消息。会话已停止时消息会让它接着跑；会话正在运行时由 mode 决定：'
      + 'queue（默认）排队等当前回合结束，steer 立即打断当前回合并插入这条消息。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['sessionId', 'text'],
      properties: {
        sessionId: { type: 'string', description: '目标会话：id、id 前缀或标题。' },
        text: { type: 'string', description: '要发的内容。目标会话看不到本会话的上下文，需要的信息都要写进来。' },
        mode: {
          type: 'string',
          enum: ['queue', 'steer'],
          description: 'queue=排队等当前回合结束；steer=打断当前回合并立即插入。默认 queue。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          mode: { type: 'string' },
          effect: { type: 'string' },
          was_running: { type: 'boolean' },
          queued: { type: 'integer' },
        },
        required: ['session_id', 'mode', 'effect', 'was_running', 'queued'],
        additionalProperties: true,
      },
      render: (_args, value) => [{
        type: 'text',
        text: `消息已交给会话 ${value.session_id}（${value.mode}）：${value.effect}`
          + (value.queued > 0 ? `。该会话队列里还有 ${value.queued} 条消息` : ''),
      }],
    },
    async execute(args, exec) {
      const input = asObject(args)
      const signal = exec?.signal ?? lifecycle.signal
      const sessionId = await resolveSessionId(input.sessionId, signal)
      const text = requireText(input.text ?? input.message ?? input.content, 'text')
      const mode = input.mode === 'steer' ? 'steer' : 'queue'
      const service = controller()
      const before = await service.state({ sessionId }, signal)
      const wasRunning = before?.running === true
      await service.prompt({
        requestId: `sessionScheduler-${randomUUID()}`,
        sessionId,
        mode,
        content: [{ type: 'text', text }],
      }, signal)
      let after
      try {
        after = await service.state({ sessionId }, signal)
      } catch {
        after = before
      }
      const effect = !wasRunning
        ? '会话之前是停止的，这条消息已让它开始新回合'
        : mode === 'steer'
          ? '已打断当前回合，这条消息已插入'
          : '当前回合结束后执行'
      return {
        session_id: sessionId,
        mode,
        effect,
        was_running: wasRunning,
        queued: queuedOf(after),
      }
    },
  })

  tool({
    name: 'sessions_stop',
    description:
      '停止某个会话正在执行的回合（等同 GUI 里的停止按钮）。'
      + '默认只中止当前回合，已排队的消息会留下并在之后继续执行；dropQueue 为 true 时连队列一起清空。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['sessionId'],
      properties: {
        sessionId: { type: 'string', description: '目标会话：id、id 前缀或标题。' },
        dropQueue: { type: 'boolean', description: '同时丢弃该会话队列里尚未执行的用户消息，默认 false。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          stopped: { type: 'boolean' },
          status: { type: 'string' },
          dropped: { type: 'integer' },
          queued: { type: 'integer' },
          note: { type: 'string' },
        },
        required: ['session_id', 'stopped', 'status', 'dropped', 'queued'],
        additionalProperties: true,
      },
      render: (_args, value) => [{
        type: 'text',
        text: `会话 ${value.session_id}：${value.stopped ? '已停止当前回合' : '当前没有在运行的回合'}`
          + `（状态 ${value.status}）`
          + (value.dropped > 0 ? `，已丢弃 ${value.dropped} 条排队消息` : '')
          + (value.queued > 0 ? `，队列里还剩 ${value.queued} 条` : '')
          + (value.note ? `\n${value.note}` : ''),
      }],
    },
    async execute(args, exec) {
      const input = asObject(args)
      const signal = exec?.signal ?? lifecycle.signal
      const sessionId = await resolveSessionId(input.sessionId, signal)
      assertNotSelf(sessionId, exec, '停止')
      const service = controller()
      const before = await service.state({ sessionId }, signal)
      const wasRunning = before?.running === true
      let dropped = 0
      if (wasRunning) {
        await service.cancel({ sessionId })
        await waitForStop(sessionId, signal)
      }
      if (input.dropQueue === true) {
        let queue = []
        try {
          const current = await service.state({ sessionId }, signal)
          queue = Array.isArray(current?.queue) ? current.queue : []
        } catch {
          queue = Array.isArray(before?.queue) ? before.queue : []
        }
        for (const item of queue) {
          if (!item?.id) continue
          try {
            await service.updateQueue({ sessionId, itemId: item.id, action: { kind: 'remove' } })
            dropped += 1
          } catch (error) {
            warn(`queued message ${String(item.id)} of ${sessionId} was not removed: ${messageOf(error)}`)
          }
        }
      }
      let after
      try {
        after = await service.state({ sessionId }, signal)
      } catch {
        after = before
      }
      const queued = queuedOf(after)
      const note = !wasRunning && queued > 0
        ? '该会话没有在运行，但队列里还有消息；要看它自己继续，可调用 sessions_wait。'
        : queued > 0 ? '队列里还有消息，它们在停止检查之后仍可能开始新回合；需要彻底停下请传 dropQueue: true。' : ''
      return {
        session_id: sessionId,
        stopped: wasRunning,
        status: statusOf(after),
        dropped,
        queued,
        ...(note ? { note } : {}),
      }
    },
  })

  tool({
    name: 'sessions_archive',
    description:
      '归档一个会话：它从会话列表里隐藏，但会话日志保留，可用 sessions_unarchive 恢复。'
      + '默认只归档已经不在运行的会话；对正在运行的会话必须显式传 stopIfRunning: true（等于先停止再归档）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['sessionId'],
      properties: {
        sessionId: { type: 'string', description: '目标会话：id、id 前缀或标题。' },
        stopIfRunning: { type: 'boolean', description: '会话正在运行时是否先停止它再归档，默认 false（此时会拒绝归档）。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          archived: { type: 'boolean' },
          stopped: { type: 'boolean' },
        },
        required: ['session_id', 'archived'],
        additionalProperties: true,
      },
      render: (_args, value) => [{
        type: 'text',
        text: `已归档会话 ${value.session_id}${value.stopped ? '（归档前已停止它的运行回合）' : ''}。恢复用 sessions_unarchive。`,
      }],
    },
    async execute(args, exec) {
      const input = asObject(args)
      const signal = exec?.signal ?? lifecycle.signal
      const sessionId = await resolveLoose(input.sessionId, signal)
      assertNotSelf(sessionId, exec, '归档')
      const stopActivity = input.stopIfRunning === true
      const service = controller()
      let running = false
      try {
        const state = await service.state({ sessionId }, signal)
        running = state?.running === true
      } catch {
        running = false
      }
      if (running && !stopActivity) {
        throw new Error(`会话 ${sessionId} 正在运行，未归档。先 sessions_stop，或传 stopIfRunning: true 让它停止后再归档。`)
      }
      try {
        await registry().archiveSession(sessionId, stopActivity ? { stopActivity: true } : {})
      } catch (error) {
        const text = messageOf(error)
        if (!stopActivity) {
          throw new Error(`归档 ${sessionId} 被拒绝（${text}）。该会话仍被判定为有活动；确认可以中断时重试并传 stopIfRunning: true。`)
        }
        throw error
      }
      return { session_id: sessionId, archived: true, ...(running ? { stopped: true } : {}) }
    },
  })

  tool({
    name: 'sessions_unarchive',
    description: '把一个已归档的会话恢复到它原来的位置。归档会话不出现在 sessions_list 里，所以通常要用完整 id。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['sessionId'],
      properties: {
        sessionId: { type: 'string', description: '已归档会话的 id（sessions_list 查不到它，请用完整 id）。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          restored: { type: 'boolean' },
        },
        required: ['session_id', 'restored'],
        additionalProperties: true,
      },
      render: (_args, value) => [{ type: 'text', text: `已恢复会话 ${value.session_id}。` }],
    },
    async execute(args) {
      const input = asObject(args)
      const sessionId = requireText(input.sessionId, 'sessionId')
      await registry().unarchiveSession(sessionId)
      return { session_id: sessionId, restored: true }
    },
  })

  tool({
    name: 'sessions_wait',
    description:
      '等某个会话结束当前这一轮：它的回合跑完、停下来等你确认/回答，或等待超时后返回。'
      + '返回那一刻的状态和它最后一条答复，用于「发完消息再收结果」。不会中断对方，也不会消费它的消息。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['sessionId'],
      properties: {
        sessionId: { type: 'string', description: '目标会话：id、id 前缀或标题。' },
        timeoutMs: { type: 'integer', description: `最多等待多久（毫秒），默认 ${DEFAULT_WAIT_MS}，最大 ${MAX_WAIT_MS}。` },
        maxChars: { type: 'integer', description: `返回的最后一条答复最多多少字，默认 ${MAX_TAIL_CHARS}。` },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          reason: { type: 'string' },
          status: { type: 'string' },
          pending: { type: 'array', items: { type: 'string' } },
          queued: { type: 'integer' },
          waited_ms: { type: 'integer' },
          text: { type: 'string' },
        },
        required: ['session_id', 'reason', 'status', 'queued', 'waited_ms', 'text'],
        additionalProperties: true,
      },
      render: (_args, value) => [{ type: 'text', text: renderWait(value) }],
    },
    timeoutMs: WAIT_TOOL_TIMEOUT_MS,
    async execute(args, exec) {
      const input = asObject(args)
      const signal = exec?.signal ?? lifecycle.signal
      const sessionId = await resolveSessionId(input.sessionId, signal)
      const timeoutMs = clampInt(input.timeoutMs, 1_000, settings.maxWaitMs, settings.defaultWaitMs)
      const maxChars = clampInt(input.maxChars, 200, 40_000, settings.maxTailChars)
      const service = controller()
      const startedAt = Date.now()
      const result = await service.wait(
        { sessionId, timeoutMs, maxMessages: MAX_MESSAGES },
        signal,
      )
      let state = result?.state
      if (!state) {
        try {
          state = await service.state({ sessionId }, signal)
        } catch {
          state = undefined
        }
      }
      return {
        session_id: sessionId,
        reason: String(result?.reason ?? 'timeout'),
        status: statusOf(state),
        pending: pendingOf(state),
        queued: queuedOf(state),
        waited_ms: Date.now() - startedAt,
        text: shorten(lastAssistantText(result?.output), maxChars) || '（没有新的答复）',
      }
    },
  })

  // ------------------------------------------------------------ session ops

  /**
   * Pin a Session title through the title service when the Session is already
   * registered, then fall back to the rename operation.
   * @param sessionId - target session
   * @param title - display title
   */
  async function nameSession(sessionId, title) {
    try {
      const sessions = ctx.get('sessions')
      const titles = ctx.get('sessionTitle')
      const session = typeof sessions?.get === 'function' ? sessions.get(sessionId) : undefined
      if (session && typeof titles?.rename === 'function') {
        titles.rename(session, title)
        return
      }
    } catch (error) {
      warn(`session ${sessionId} was not named through the title service: ${messageOf(error)}`)
    }
    try {
      await controller().rename({ sessionId, title })
    } catch (error) {
      warn(`session ${sessionId} was not renamed: ${messageOf(error)}`)
    }
  }

  /**
   * Attach a created Session to the Workspace that owns its directory, creating
   * that Workspace when the directory has none.
   * @param sessionId - created session
   * @param cwd - project directory
   * @param title - workspace title
   * @returns {Promise<string>} workspace title, or '' on failure
   */
  async function joinWorkspace(sessionId, cwd, title) {
    const service = ctx.get('workspaceRegistry')
    if (!service || typeof service.resolveByPath !== 'function') return ''
    try {
      let workspace = await service.resolveByPath(cwd)
      if (!workspace && typeof service.create === 'function') workspace = await service.create(cwd, title)
      if (!workspace) return ''
      if (typeof workspace.attachSession === 'function') await workspace.attachSession(sessionId)
      return String(workspace.title ?? path.basename(cwd))
    } catch (error) {
      warn(`session ${sessionId} did not join the Workspace at ${cwd}: ${messageOf(error)}`)
      return ''
    }
  }

  /**
   * Poll briefly until the cancelled turn is no longer running.
   * @param sessionId - target session
   * @param signal - cancellation
   */
  async function waitForStop(sessionId, signal) {
    const deadline = Date.now() + STOP_CONFIRM_MS
    for (;;) {
      try {
        const state = await controller().state({ sessionId }, signal)
        if (state?.running !== true) return
      } catch (error) {
        if (signal?.aborted) return
        warn(`state of ${sessionId} was not readable while stopping: ${messageOf(error)}`)
        return
      }
      if (Date.now() > deadline || signal?.aborted) return
      await sleep(400, signal)
    }
  }
}

// ---------------------------------------------------------------- rendering

/**
 * Render the list result.
 * @param value - tool value
 * @returns {string} model-facing text
 */
function renderList(value) {
  const sessions = Array.isArray(value?.sessions) ? value.sessions : []
  if (sessions.length === 0) {
    return value?.running_only
      ? `在 ${value.total} 个符合筛选条件的会话里没有正在运行的会话。`
      : '没有符合条件的会话。'
  }
  const lines = [value?.running_only
    ? `正在运行的会话 ${value.shown} 个（在这 ${value.total} 个会话里扫描到的）：`
    : `会话 ${value.shown}/${value.total}：`]
  for (const row of sessions) {
    const extras = []
    if (row.queued > 0) extras.push(`队列 ${row.queued}`)
    if (Array.isArray(row.pending) && row.pending.length > 0) extras.push(`等确认：${row.pending.join('/')}`)
    lines.push(
      `- [${row.status}] ${row.title}｜${row.session_id}｜${row.cwd}｜${row.updated_at}`
      + (extras.length ? `｜${extras.join('｜')}` : ''),
    )
  }
  return lines.join('\n')
}

/**
 * Render the wait result.
 * @param value - tool value
 * @returns {string} model-facing text
 */
function renderWait(value) {
  const label = value.reason === 'idle'
    ? '这一轮已结束'
    : value.reason === 'input-required'
      ? '它在等确认或回答'
      : '等待超时，它还在跑'
  const head = `会话 ${value.session_id}：${label}（状态 ${value.status}，等了 ${Math.round(Number(value.waited_ms ?? 0) / 1000)} 秒）`
  const extras = []
  if (value.queued > 0) extras.push(`队列里还有 ${value.queued} 条消息`)
  if (Array.isArray(value.pending) && value.pending.length > 0) extras.push(`待处理：${value.pending.join('/')}`)
  return [head, ...extras, '', value.text || '（没有新的答复）'].join('\n')
}

// ------------------------------------------------------------------ helpers

/**
 * Extract the last assistant text from a bounded Session output window.
 * @param output - SessionWaitOutput
 * @returns {string} last assistant text
 */
function lastAssistantText(output) {
  const records = Array.isArray(output?.records) ? output.records : []
  let text = ''
  for (const entry of records) {
    const event = entry?.event ?? entry
    if (event?.type !== 'assistant/message') continue
    const content = event?.data?.message?.content
    const blocks = Array.isArray(content) ? content : []
    const merged = blocks
      .filter(block => block && block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text)
      .join('\n')
      .trim()
    if (merged) text = merged
  }
  return text
}

/**
 * Normalize the loader row config.
 * @param config - raw config
 * @returns {object} effective settings
 */
function normalizeConfig(config) {
  const raw = asObject(config)
  return {
    defaultWaitMs: clampInt(raw.defaultWaitMs, 1_000, MAX_WAIT_MS, DEFAULT_WAIT_MS),
    maxWaitMs: clampInt(raw.maxWaitMs, 10_000, MAX_WAIT_MS, MAX_WAIT_MS),
    maxTailChars: clampInt(raw.maxTailChars, 200, 40_000, MAX_TAIL_CHARS),
    agentPreset: typeof raw.agentPreset === 'string' && raw.agentPreset.trim() ? raw.agentPreset.trim() : undefined,
  }
}

/**
 * @param value - candidate
 * @returns {Record<string, any>} plain object view
 */
function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

/**
 * Read one required non-empty string argument.
 * @param value - candidate
 * @param field - argument name for the error message
 * @returns {string} trimmed text
 */
function requireText(value, field) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) throw new Error(`${field} 不能为空。`)
  return text
}

/**
 * @param value - candidate
 * @param min - lower bound
 * @param max - upper bound
 * @param fallback - default
 * @returns {number} integer in range
 */
function clampInt(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

/**
 * @param value - text
 * @param limit - maximum characters
 * @returns {string} shortened text
 */
function shorten(value, limit) {
  const text = String(value ?? '')
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n…（已截断，原文 ${text.length} 字）`
}

/**
 * Expand a leading `~`.
 * @param value - path
 * @returns {string} expanded path
 */
function expandHome(value) {
  const text = String(value ?? '')
  if (text === '~') return homedir()
  if (text.startsWith('~/')) return path.join(homedir(), text.slice(2))
  return text
}

/**
 * @param value - candidate
 * @returns {boolean} whether the text looks like a Session id
 */
function looksLikeSessionId(value) {
  return /^session-[0-9a-zA-Z-]{6,}$/.test(String(value ?? '').trim())
}

/**
 * @param ms - epoch ms
 * @returns {string} local ISO-ish stamp
 */
function iso(ms) {
  return new Date(ms).toLocaleString('sv-SE', { hour12: false })
}

/**
 * @param error - thrown value
 * @returns {string} message
 */
function messageOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Abortable delay.
 * @param ms - delay
 * @param signal - cancellation
 * @returns {Promise<void>} resolves after the delay
 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}
