import { describe, expect, it } from 'vitest'

import { blockingOnly, validateGraphConfig } from './graph'
import { validateTriggerForActivation } from './validate'
import type { AutomationEdgeRow, AutomationNodeRow } from './graph-types'

// ------------------------------------------------------------
// Publish gate: errors vs warnings. Mirrors exactly what
// POST /api/automations/[id]/publish computes (minus the live DB
// re-checks, which need a database). `blockingOnly()` is the filter
// that decides whether publish proceeds.
// ------------------------------------------------------------

function node(id: string, type: string, config: Record<string, unknown> = {}): AutomationNodeRow {
  return { id, automation_id: 'a', account_id: 'acct', type: type as never, config, position_x: 0, position_y: 0 }
}
function edge(source: string, target: string, handle: 'yes' | 'no' | null = null): AutomationEdgeRow {
  return { id: `${source}-${target}`, automation_id: 'a', account_id: 'acct', source_node_id: source, target_node_id: target, source_handle: handle }
}

const completeButton = { kind: 'buttons', body: 'Hello', buttons: [{ id: 'a', title: 'Yes' }] }

describe('validateGraphConfig severity split', () => {
  it('a complete connected graph has no errors and no warnings', () => {
    const issues = validateGraphConfig([node('start', 'starting_step'), node('b', 'text_button', completeButton)], [edge('start', 'b')])
    expect(issues).toEqual([])
  })

  it('blocks an incomplete Text + Button node with a node-specific error', () => {
    const issues = validateGraphConfig(
      [node('start', 'starting_step'), node('b', 'text_button', { kind: 'buttons', body: '', buttons: [{ id: '', title: '' }] })],
      [edge('start', 'b')],
    )
    const errors = blockingOnly(issues)
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.some((e) => e.path.startsWith('nodes.b'))).toBe(true)
    expect(errors.every((e) => e.severity !== 'warning')).toBe(true)
  })

  it('treats an unreachable draft node as a non-blocking WARNING', () => {
    const issues = validateGraphConfig(
      [
        node('start', 'starting_step'),
        node('b', 'text_button', completeButton),
        node('orphan', 'add_tag', { tag_id: 't1' }),
      ],
      [edge('start', 'b')],
    )
    expect(blockingOnly(issues)).toEqual([])
    const warn = issues.find((i) => i.severity === 'warning' && i.path === 'nodes.orphan')
    expect(warn?.message).toContain('unreachable')
  })

  it('a single unconnected condition branch is a WARNING, both missing is an ERROR', () => {
    const one = validateGraphConfig(
      [node('start', 'starting_step'), node('c', 'condition', { subject: 'tag_presence', operand: 't' }), node('b', 'text_button', completeButton)],
      [edge('start', 'c'), edge('c', 'b', 'yes')],
    )
    expect(blockingOnly(one)).toEqual([])
    expect(one.some((i) => i.severity === 'warning' && i.path === 'nodes.c.no')).toBe(true)

    const none = validateGraphConfig(
      [node('start', 'starting_step'), node('b', 'text_button', completeButton), node('c', 'condition', { subject: 'tag_presence', operand: 't' })],
      [edge('start', 'b'), edge('start', 'c')],
    )
    expect(blockingOnly(none).some((i) => i.path === 'nodes.c')).toBe(true)
  })

  it('a zero-length Time Delay warns but stays publishable', () => {
    const issues = validateGraphConfig(
      [node('start', 'starting_step'), node('d', 'time_delay', { amount: 0, unit: 'minutes' })],
      [edge('start', 'd')],
    )
    expect(blockingOnly(issues)).toEqual([])
    expect(issues.some((i) => i.severity === 'warning' && i.path === 'nodes.d.amount')).toBe(true)
  })

  it('a negative Time Delay is a blocking error', () => {
    const issues = validateGraphConfig(
      [node('start', 'starting_step'), node('d', 'time_delay', { amount: -5, unit: 'minutes' })],
      [edge('start', 'd')],
    )
    expect(blockingOnly(issues).length).toBeGreaterThan(0)
  })
})

describe('validateTriggerForActivation', () => {
  it('rejects a keyword trigger with no keywords', () => {
    const issues = validateTriggerForActivation('keyword_match', { keywords: [], match_type: 'contains' })
    expect(issues.length).toBeGreaterThan(0)
  })
  it('accepts a valid keyword trigger', () => {
    expect(validateTriggerForActivation('keyword_match', { keywords: ['hi'], match_type: 'contains' })).toEqual([])
  })
})
