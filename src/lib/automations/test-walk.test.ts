import { describe, expect, it } from 'vitest'

import {
  describeNode,
  emptyContext,
  evaluateCondition,
  interpolateVars,
  resolveNext,
  simulateTriggerMatch,
  type TestContext,
} from './test-walk'
import {
  type AutomationEdgeRow,
  type AutomationNodeRow,
  type AutomationNodeType,
} from './graph-types'

// ------------------------------------------------------------
// Pure walker helpers + a hand-assembled multi-node walk, mirroring
// what the Test panel does at runtime — with ZERO DB / Meta effects
// (these are the same functions the panel calls).
// ------------------------------------------------------------

const baseResources = {
  tagNames: { 'tag-hot': 'Hot Lead', 'tag-city': 'City' },
  templates: { welcome: { body_text: 'Hi {{1}}, welcome!', buttons: [{ text: 'OK' }] } },
  flowNames: { 'flow-1': 'Lead Form' },
}

function node(id: string, type: AutomationNodeType, config: Record<string, unknown> = {}): AutomationNodeRow {
  return {
    id,
    automation_id: 'a1',
    account_id: 'acct1',
    type,
    config,
    position_x: 0,
    position_y: 0,
  }
}

function edge(id: string, source: string, target: string, handle: 'yes' | 'no' | null = null): AutomationEdgeRow {
  return { id, automation_id: 'a1', account_id: 'acct1', source_node_id: source, target_node_id: target, source_handle: handle }
}

describe('simulateTriggerMatch', () => {
  it('matches a contains keyword', () => {
    const r = simulateTriggerMatch('keyword_match', { keywords: ['price'], match_type: 'contains' }, 'What is the PRICE?')
    expect(r.matched).toBe(true)
  })
  it('does not match when keyword absent', () => {
    const r = simulateTriggerMatch('keyword_match', { keywords: ['price'], match_type: 'contains' }, 'hello there')
    expect(r.matched).toBe(false)
    expect(r.reason).toContain('did not match')
  })
  it('whole-word match respects boundaries', () => {
    const cfg = { keywords: ['hi'], match_type: 'word' }
    expect(simulateTriggerMatch('keyword_match', cfg, 'say hi!').matched).toBe(true)
    expect(simulateTriggerMatch('keyword_match', cfg, 'history').matched).toBe(false)
  })
  it('fails when no keywords configured', () => {
    expect(simulateTriggerMatch('keyword_match', { keywords: [], match_type: 'contains' }, 'hi').matched).toBe(false)
  })
})

describe('interpolateVars', () => {
  it('substitutes message + vars tokens', () => {
    const ctx: TestContext = { ...emptyContext(), messageText: 'Mumbai', vars: { name: 'Ash' } }
    expect(interpolateVars('Hi {{vars.name}}, city {{ message.text }}', ctx)).toBe('Hi Ash, city Mumbai')
  })
  it('leaves unknown tokens empty', () => {
    expect(interpolateVars('[{{ vars.missing }}]', emptyContext())).toBe('[]')
  })
})

describe('resolveNext', () => {
  const edges = [edge('e1', 'start', 'n1'), edge('e2', 'cond', 'yes', 'yes'), edge('e3', 'cond', 'no', 'no')]
  it('follows linear edge', () => expect(resolveNext(edges, 'start', null)).toBe('n1'))
  it('follows yes branch', () => expect(resolveNext(edges, 'cond', 'yes')).toBe('yes'))
  it('returns null when branch not connected', () => expect(resolveNext(edges, 'n1', null)).toBeNull())
})

describe('evaluateCondition', () => {
  const ctx: TestContext = {
    ...emptyContext(),
    messageText: 'I want a demo',
    contact: { name: 'X', fields: { city: 'Pune' }, tagIds: ['tag-hot'] },
  }
  it('tag_presence true', () => expect(evaluateCondition({ subject: 'tag_presence', operand: 'tag-hot' }, ctx).result).toBe(true))
  it('tag_presence false when missing', () => expect(evaluateCondition({ subject: 'tag_presence', operand: 'tag-city' }, ctx).result).toBe(false))
  it('contact_field equality', () => expect(evaluateCondition({ subject: 'contact_field', operand: 'city', value: 'Pune' }, ctx).result).toBe(true))
  it('contact_field missing attribute → false (Next Step path, not an error)', () =>
    expect(evaluateCondition({ subject: 'contact_field', operand: 'email', value: 'x@y.z' }, ctx).result).toBe(false))
  it('message_content contains', () => expect(evaluateCondition({ subject: 'message_content', value: 'demo' }, ctx).result).toBe(true))
})

describe('describeNode', () => {
  it('text_button yields tappable buttons and pauses', () => {
    const r = describeNode(
      node('b', 'text_button', { kind: 'buttons', body: 'Menu', buttons: [{ id: 'a', title: 'Talk' }] }),
      emptyContext(),
      baseResources,
    )
    expect(r.awaits).toBe('buttons')
    expect(r.bubble?.type).toBe('buttons')
    expect(r.system).toHaveLength(0)
  })

  it('ask_question pauses and names its variable', () => {
    const r = describeNode(node('q', 'ask_question', { text: 'Your city?', variable: 'city' }), emptyContext(), baseResources)
    expect(r.awaits).toBe('question')
    if (r.bubble?.type === 'question') expect(r.bubble.variable).toBe('city')
  })

  it('template resolves body from resources with substituted var', () => {
    const ctx = { ...emptyContext(), vars: { name: 'Ash' } }
    const r = describeNode(
      node('t', 'template', { template_name: 'welcome', language: 'en_US', body: ['{{ vars.name }}'] }),
      ctx,
      baseResources,
    )
    expect(r.bubble?.type).toBe('template')
    if (r.bubble?.type === 'template') expect(r.bubble.body).toBe('Hi Ash, welcome!')
  })

  it('dry-run action nodes emit "Would …" lines only', () => {
    const ctx = { ...emptyContext(), vars: { city: 'Mumbai' } }
    const save = describeNode(node('s', 'save_attribute', { field: 'city', value: '{{ vars.city }}' }), ctx, baseResources)
    expect(save.system[0]?.text).toBe('Would save attribute: city = Mumbai')
    expect(save.bubble).toBeNull()

    const tag = describeNode(node('g', 'add_tag', { tag_id: 'tag-hot' }), ctx, baseResources)
    expect(tag.system[0]?.text).toBe('Would add tag: Hot Lead')

    const hook = describeNode(node('w', 'webhook', { method: 'POST', url: 'https://x/y' }), ctx, baseResources)
    expect(hook.system[0]?.text).toBe('Would call webhook: POST https://x/y')

    const delay = describeNode(node('d', 'time_delay', { amount: 2, unit: 'hours' }), ctx, baseResources)
    expect(delay.system[0]?.text).toBe('Would pause for 2 hours before continuing')
  })

  it('condition records the branch taken and why', () => {
    const ctx: TestContext = { ...emptyContext(), contact: { name: 'X', fields: {}, tagIds: [] } }
    const r = describeNode(node('c', 'condition', { subject: 'tag_presence', operand: 'tag-hot' }), ctx, baseResources)
    expect(r.nextHandle).toBe('no')
    expect(r.system[0]?.text).toContain('No')
  })

  it('empty required fields warn rather than crash', () => {
    const r = describeNode(node('m', 'media', { media_kind: 'image', url: '' }), emptyContext(), baseResources)
    expect(r.system[0]?.tone).toBe('warn')
  })
})

describe('end-to-end simulated walk (draft graph, no side effects)', () => {
  // start → ask_question(city) → condition tag-hot? → [no] time_delay → save_attribute → text_button
  const nodes = [
    node('start', 'starting_step'),
    node('q', 'ask_question', { text: 'City?', variable: 'city' }),
    node('cond', 'condition', { subject: 'tag_presence', operand: 'tag-hot' }),
    node('d', 'time_delay', { amount: 1, unit: 'hours' }),
    node('s', 'save_attribute', { field: 'city', value: '{{ vars.city }}' }),
    node('b', 'text_button', { kind: 'buttons', body: 'Done', buttons: [{ id: 'x', title: 'OK' }] }),
  ]
  const edges = [
    edge('e0', 'start', 'q'),
    edge('e1', 'q', 'cond'),
    edge('eNo', 'cond', 'd', 'no'),
    edge('e2', 'd', 's'),
    edge('e3', 's', 'b'),
  ]

  // Mirror the panel's walk loop.
  function walk(fromId: string | null, ctx: TestContext) {
    const out: string[] = []
    let id = fromId
    let guard = 0
    while (id && guard++ < 100) {
      const n = nodes.find((x) => x.id === id)!
      const proc = describeNode(n, ctx, baseResources)
      if (proc.bubble) out.push(`bubble:${proc.bubble.type}`)
      proc.system.forEach((s) => out.push(`${s.tone}:${s.text}`))
      if (proc.awaits) return { out, pausedAt: n.id, kind: proc.awaits }
      const next = resolveNext(edges, n.id, proc.nextHandle)
      if (!next) return { out, pausedAt: null, kind: null }
      id = next
    }
    return { out, pausedAt: null, kind: null }
  }

  it('captures the answer, routes to Next Step (not False), then pauses on buttons', () => {
    const ctx: TestContext = { ...emptyContext(), contact: { name: 'X', fields: {}, tagIds: [] } }
    // entry from the question's next (after tester replies)
    ctx.vars.city = 'Mumbai'
    ctx.messageText = 'Mumbai'
    const startedAt = resolveNext(edges, 'start', null)
    // Walk from ask_question: it pauses for the reply.
    const step1 = walk(startedAt, ctx)
    expect(step1.kind).toBe('question')
    expect(step1.pausedAt).toBe('q')

    // Tester answered → resume from q's next.
    const step2 = walk(resolveNext(edges, 'q', null), ctx)
    expect(step2.out.join(' |')).toContain('Would save attribute: city = Mumbai')
    // condition had no tag → 'no' branch → time_delay → save → buttons
    expect(step2.out.join(' |')).toContain('Condition → No')
    expect(step2.kind).toBe('buttons')
    expect(step2.pausedAt).toBe('b')
  })
})
