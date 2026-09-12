import { describe, expect, it } from 'vitest'
import { apply, Config, inject, name } from '../src/index.ts'

interface RegisteredTool {
  name: string
  output: { render(args: unknown, value: unknown): { type: string; text: string }[] }
  execute(args: never, exec: never): Promise<unknown>
}

const FULL_CONFIG = { allowExportPrefix: true, stripInlineComments: true, maxKeyLength: 128 }

function mountPlugin(overrides: Partial<typeof FULL_CONFIG> = {}): RegisteredTool[] {
  const registered: RegisteredTool[] = []
  const ctx = { tools: { register: (def: RegisteredTool) => registered.push(def) } }
  // The plugin only reads ctx.tools; a partial stub is the real registrant surface it touches.
  apply(ctx as never, { ...FULL_CONFIG, ...overrides } as never)
  return registered
}

function tool(toolName: string, overrides: Partial<typeof FULL_CONFIG> = {}): RegisteredTool {
  const found = mountPlugin(overrides).find((def) => def.name === toolName)
  if (!found) throw new Error(`${toolName} is not registered`)
  return found
}

/** Loose result view so each case reads only the fields it asserts on. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool output shape varies per case
type Result = Record<string, any>

function run(toolName: string, args: Record<string, unknown>, overrides: Partial<typeof FULL_CONFIG> = {}): Promise<Result> {
  return tool(toolName, overrides).execute(args as never, {} as never) as Promise<Result>
}

const schema = (overrides: Record<string, unknown> = {}) => ({ required: [], optional: [], checks: [], ...overrides })

describe('dsh-env-switcher plugin contract', () => {
  it('exports the loader plugin face', () => {
    expect(name).toBe('dsh-env-switcher')
    expect(inject).toEqual(['tools'])
    expect(typeof apply).toBe('function')
    expect(Config).toBeInstanceOf(Object)
  })

  it('supplies config defaults through the schemastery schema', () => {
    expect(Config({})).toMatchObject({ allowExportPrefix: true, stripInlineComments: true, maxKeyLength: 128 })
    expect(Config({ maxKeyLength: 8 })).toMatchObject({ maxKeyLength: 8 })
  })

  it('registers the four documented tools', () => {
    expect(mountPlugin().map((def) => def.name).sort()).toEqual([
      'env_diff',
      'env_parse',
      'env_serialize',
      'env_validate',
    ])
  })

  it('declares every tool pure and renders each outcome as one text block', () => {
    const fixtures: Record<string, unknown> = {
      env_parse: { values: { A: '1' }, count: 1, invalid: ['line 2: no "=" separator: junk'] },
      env_diff: { added: [], removed: [], changed: [], identical: true },
      env_validate: { valid: false, count: 1, missing: ['HOST'], extra: ['X'], errors: ['A: value is empty'] },
      env_serialize: { text: 'A=1\n', count: 1, skipped: [] },
    }
    for (const def of mountPlugin()) {
      const blocks = def.output.render({} as never, fixtures[def.name])
      expect(blocks).toHaveLength(1)
      expect(blocks[0]!.type).toBe('text')
      expect(blocks[0]!.text.length).toBeGreaterThan(0)
    }
    expect(tool('env_diff').output.render({}, fixtures.env_diff)[0]!.text).toContain('Identical')
  })
})

describe('env_parse', () => {
  it('reads comments, quotes, inline comments, export prefixes, and empty values', async () => {
    const text = [
      '# dev profile',
      'APP_NAME=demo',
      'APP_PORT="8080"',
      'GREETING=hello world',
      'SECRET=  # inline',
      'export TOKEN=abc',
      'EMPTY=',
      'LIST=a,b,c',
      'BROKEN line without equals',
      '9BAD=x',
    ].join('\n')
    const result = await run('env_parse', { text })
    expect(result.count).toBe(7)
    expect(result.invalid).toHaveLength(2)
    expect(result.invalid[0]).toContain('line 9')
    expect(result.invalid[1]).toContain('invalid key "9BAD"')
    expect(result.values).toEqual({
      APP_NAME: 'demo',
      APP_PORT: '8080',
      GREETING: 'hello world',
      SECRET: '',
      TOKEN: 'abc',
      EMPTY: '',
      LIST: 'a,b,c',
    })
  })

  it('expands escapes in double quotes and lets the last duplicate win', async () => {
    const result = await run('env_parse', { text: 'A=1\nB=x\nA=2\nMSG="line\\nnext"\nSINGLE=\'raw \\n text\'' })
    expect(result.count).toBe(4)
    expect(result.invalid).toEqual([])
    expect(result.values).toEqual({ A: '2', B: 'x', MSG: 'line\nnext', SINGLE: 'raw \\n text' })
  })

  it('reports an unterminated quote and trailing junk instead of throwing', async () => {
    const unterminated = await run('env_parse', { text: 'A="oops\nB=2' })
    expect(unterminated.values).toEqual({ A: '"oops', B: '2' })
    expect(unterminated.invalid[0]).toContain('unterminated')

    const trailing = await run('env_parse', { text: 'A="ok" tail' })
    expect(trailing.values).toEqual({ A: 'ok' })
    expect(trailing.invalid[0]).toContain('after the closing quote')
  })

  it('honours allowExportPrefix: false', async () => {
    const result = await run('env_parse', { text: 'export TOKEN=abc' }, { allowExportPrefix: false })
    expect(result.count).toBe(0)
    expect(result.invalid[0]).toContain('invalid key "export TOKEN"')
  })

  it('honours stripInlineComments: false and maxKeyLength', async () => {
    const raw = await run('env_parse', { text: 'A=1 # keep me' }, { stripInlineComments: false })
    expect(raw.values).toEqual({ A: '1 # keep me' })
    expect(raw.invalid).toEqual([])

    const limited = await run('env_parse', { text: 'LONGERKEY=1\nOK=1' }, { maxKeyLength: 4 })
    expect(limited.values).toEqual({ OK: '1' })
    expect(limited.invalid).toEqual(['line 1: key "LONGERKEY..." exceeds 4 characters'])
  })
})

describe('env_diff', () => {
  it('reports added, removed, and changed keys', async () => {
    const result = await run('env_diff', { a: 'A=1\nB=2\nC=3', b: 'A=1\nB=99\nD=4' })
    expect(result.added).toEqual(['D'])
    expect(result.removed).toEqual(['C'])
    expect(result.changed).toEqual([{ key: 'B', from: '2', to: '99' }])
    expect(result.identical).toBe(false)
  })

  it('calls comment-only differences identical and sorts its output', async () => {
    const same = await run('env_diff', { a: '# one\nA=1', b: '# two\nA=1' })
    expect(same.identical).toBe(true)
    expect(same).toMatchObject({ added: [], removed: [], changed: [] })

    const sorted = await run('env_diff', { a: '', b: 'Z=1\nA=2\nM=3' })
    expect(sorted.added).toEqual(['A', 'M', 'Z'])
    expect(sorted.removed).toEqual([])
    expect(sorted.identical).toBe(false)
  })

  it('ignores unreadable lines on either side', async () => {
    const result = await run('env_diff', { a: 'garbage line', b: 'A=1\nalso garbage' })
    expect(result).toMatchObject({ added: ['A'], removed: [], changed: [], identical: false })
  })

  it('sees a key added through a duplicate override as changed, not added', async () => {
    const result = await run('env_diff', { a: 'A=1\nB=2', b: 'B=3\nB=4' })
    expect(result.changed).toEqual([{ key: 'B', from: '2', to: '4' }])
    expect(result.added).toEqual([])
  })
})

describe('env_validate', () => {
  it('passes a file that satisfies every declared rule', async () => {
    const result = await run('env_validate', {
      text: 'PORT=8080\nURL=https://example.com/x?y=1\nMAIL=dev@example.com\nNICK=optional',
      schema: schema({
        required: ['PORT', 'URL'],
        optional: ['NICK'],
        checks: [
          { key: 'PORT', check: 'port', pattern: '' },
          { key: 'URL', check: 'url', pattern: '' },
          { key: 'MAIL', check: 'email', pattern: '' },
          { key: 'NICK', check: 'nonempty', pattern: '' },
        ],
      }),
    })
    expect(result.valid).toBe(true)
    expect(result.count).toBe(4)
    expect(result).toMatchObject({ missing: [], extra: [], errors: [] })
  })

  it('reports missing keys, extras, and failing rules together', async () => {
    const result = await run('env_validate', {
      text: 'PORT=99999\nMAIL=nope\nEXTRA=x',
      schema: schema({
        required: ['PORT', 'HOST'],
        checks: [
          { key: 'PORT', check: 'port', pattern: '' },
          { key: 'MAIL', check: 'email', pattern: '' },
          { key: 'HOST', check: 'nonempty', pattern: '' },
        ],
      }),
    })
    expect(result.valid).toBe(false)
    expect(result.missing).toEqual(['HOST'])
    expect(result.extra).toEqual(['EXTRA'])
    expect(result.errors).toEqual(['PORT: port must be between 1 and 65535', 'MAIL: value is not an email address'])
  })

  it('skips rules for absent keys and never throws on a bad regex', async () => {
    const absent = await run('env_validate', {
      text: 'A=1',
      schema: schema({ optional: ['A'], checks: [{ key: 'GONE', check: 'integer', pattern: '' }] }),
    })
    expect(absent).toMatchObject({ valid: true, missing: [], extra: [], errors: [] })

    const badRegex = await run('env_validate', {
      text: 'CODE=abc',
      schema: schema({ optional: ['CODE'], checks: [{ key: 'CODE', check: 'pattern', pattern: '(' }] }),
    })
    expect(badRegex.valid).toBe(false)
    expect(badRegex.errors[0]).toContain('pattern is not a valid regex')

    const noPattern = await run('env_validate', {
      text: 'CODE=abc',
      schema: schema({ optional: ['CODE'], checks: [{ key: 'CODE', check: 'pattern', pattern: '' }] }),
    })
    expect(noPattern.errors[0]).toContain('needs a non-empty pattern')

    const matching = await run('env_validate', {
      text: 'CODE=ab12',
      schema: schema({ optional: ['CODE'], checks: [{ key: 'CODE', check: 'pattern', pattern: '^[a-z]{2}\\d{2}$' }] }),
    })
    expect(matching.valid).toBe(true)
  })

  it('checks csv, boolean, integer, and number rules, and flags an empty value', async () => {
    const ok = await run('env_validate', {
      text: 'FLAGS=TRUE\nCOUNT=-7\nRATIO=1.5e3\nHOSTS=a , b',
      schema: schema({
        required: ['FLAGS', 'COUNT', 'RATIO', 'HOSTS'],
        checks: [
          { key: 'FLAGS', check: 'boolean', pattern: '' },
          { key: 'COUNT', check: 'integer', pattern: '' },
          { key: 'RATIO', check: 'number', pattern: '' },
          { key: 'HOSTS', check: 'csv', pattern: '' },
        ],
      }),
    })
    expect(ok).toMatchObject({ valid: true, missing: [], extra: [], errors: [] })

    const empty = await run('env_validate', {
      text: 'MISSING=',
      schema: schema({ required: ['MISSING'], checks: [{ key: 'MISSING', check: 'nonempty', pattern: '' }] }),
    })
    expect(empty.valid).toBe(false)
    expect(empty).toMatchObject({ missing: [], extra: [], errors: ['MISSING: value is empty'] })
  })

  it('treats every key as extra against an empty schema and surfaces unreadable lines', async () => {
    const result = await run('env_validate', { text: 'A=1\nbroken line', schema: schema() })
    expect(result.valid).toBe(false)
    expect(result.count).toBe(1)
    expect(result.missing).toEqual([])
    expect(result.extra).toEqual(['A'])
    expect(result.errors[0]).toContain('no "=" separator')
  })

  it('applies the configured key limit to validation too', async () => {
    const result = await run('env_validate', { text: 'LONGERKEY=1', schema: schema({ optional: ['LONGERKEY'] }) }, { maxKeyLength: 4 })
    expect(result.valid).toBe(false)
    expect(result).toMatchObject({ count: 0, missing: [], extra: [] })
    expect(result.errors[0]).toContain('exceeds 4 characters')
  })
})

describe('env_serialize', () => {
  it('emits file-ready text and quotes only what needs it', async () => {
    const result = await run('env_serialize', {
      values: { APP_NAME: 'demo', PORT: 8080, DEBUG: true, NOTE: 'two words', HASH: 'a#b', NULLY: null, BLANK: '' },
      sortKeys: false,
    })
    expect(result.skipped).toEqual([])
    expect(result.count).toBe(7)
    expect(result.text).toBe('APP_NAME=demo\nPORT=8080\nDEBUG=true\nNOTE="two words"\nHASH="a#b"\nNULLY=\nBLANK=""\n')
  })

  it('escapes embedded quotes, tabs, and newlines so a reparse round-trips', async () => {
    const phrase = `he said "hi"\tnext\nline`
    const serialized = await run('env_serialize', { values: { PHRASE: phrase, PLAIN: 'a-b/c:d' }, sortKeys: false })
    expect(serialized.text).toBe('PHRASE="he said \\"hi\\"\\tnext\\nline"\nPLAIN=a-b/c:d\n')

    const reparsed = await run('env_parse', { text: serialized.text })
    expect(reparsed.values).toEqual({ PHRASE: phrase, PLAIN: 'a-b/c:d' })
    expect(reparsed.invalid).toEqual([])
  })

  it('sorts keys on request and skips invalid keys and non-scalar values', async () => {
    const sorted = await run('env_serialize', { values: { Z: '1', A: '2' }, sortKeys: true })
    expect(sorted.text).toBe('A=2\nZ=1\n')

    const messy = await run('env_serialize', {
      values: { 'bad-key': 'x', ok: 1, nested: { a: 1 }, list: ['a'], TOO_LONG: 'y' },
      sortKeys: false,
    })
    expect(messy.count).toBe(2)
    expect(messy.text).toBe('ok=1\nTOO_LONG=y\n')
    expect(messy.skipped).toEqual([
      '"bad-key": not a valid env key',
      'nested: object values are not supported',
      'list: array values are not supported',
    ])
  })

  it('returns empty text for an empty object and respects maxKeyLength', async () => {
    const empty = await run('env_serialize', { values: {}, sortKeys: true })
    expect(empty).toMatchObject({ text: '', count: 0, skipped: [] })

    const result = await run('env_serialize', { values: { TOOLONG: 'x', AB: 'y' }, sortKeys: false }, { maxKeyLength: 3 })
    expect(result.text).toBe('AB=y\n')
    expect(result.skipped).toEqual(['TOOLONG: key exceeds 3 characters'])
  })
})
