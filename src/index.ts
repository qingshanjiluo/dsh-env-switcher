/**
 * Pure `.env` text toolkit for DeepSeek Harness. Four tools — `env_parse`,
 * `env_diff`, `env_validate`, `env_serialize` — read and write dotenv file
 * *content* that the caller supplies as text. The plugin never opens a file,
 * spawns a process, or reads the host's real environment, so every call is
 * deterministic and safe to run in parallel.
 * @module @qingshanjiluo/dsh-env-switcher
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-env-switcher'
export const inject = ['tools']

/** Deployment policy shared by the env text tools. */
export interface Config {
  /** Accept `export KEY=value` statements while parsing. */
  allowExportPrefix: boolean
  /** Strip a trailing ` # comment` from unquoted values while parsing. */
  stripInlineComments: boolean
  /** Keys longer than this many characters are reported invalid, never stored. */
  maxKeyLength: number
}

/** Schemastery configuration for the env text tools. */
export const Config: z<Config> = z.object({
  allowExportPrefix: z.boolean().default(true),
  stripInlineComments: z.boolean().default(true),
  maxKeyLength: z.number().default(128),
})

/** Parse policy resolved from {@link Config} (defensively normalised). */
interface ParseOptions {
  allowExportPrefix: boolean
  stripInlineComments: boolean
  maxKeyLength: number
}

/** Parsed dotenv content: values in first-seen order plus skipped lines. */
interface ParsedEnv {
  values: Record<string, string>
  invalid: string[]
}

/** Per-key failure kinds accepted by `env_validate`. */
type CheckName = 'nonempty' | 'integer' | 'number' | 'boolean' | 'port' | 'url' | 'email' | 'csv' | 'pattern'

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const INTEGER_PATTERN = /^[+-]?\d+$/
const BOOLEAN_PATTERN = /^(?:true|false|1|0|yes|no|on|off)$/i
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/
const SAFE_VALUE_PATTERN = /^[A-Za-z0-9_./:+~@-]*$/

/** Shorten one source line for use inside a diagnostic message. */
function preview(text: string): string {
  return text.length > 48 ? `${text.slice(0, 48)}...` : text
}

/** Assign one key without ever triggering prototype setters (`__proto__`). */
function setKey(target: Record<string, string>, key: string, value: string): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true })
}

/**
 * Read the value term of one assignment: optional single or double quotes
 * (double quotes expand `\n`, `\r`, `\t`, `\\`, `\"`), and optional inline
 * comment on unquoted values.
 * @param raw - text right of the first `=`, already trimmed.
 * @param options - shared parse policy.
 * @param invalid - diagnostic sink (mutated).
 * @param lineNumber - 1-based line the value came from.
 * @param key - owning key, for the diagnostic text.
 * @returns The decoded value.
 */
function readValue(raw: string, options: ParseOptions, invalid: string[], lineNumber: number, key: string): string {
  const quote = raw[0]
  if (quote === '"' || quote === "'") {
    let index = 1
    let out = ''
    let closed = false
    while (index < raw.length) {
      const char = raw[index]!
      if (char === '\\' && quote === '"' && index + 1 < raw.length) {
        const next = raw[index + 1]!
        out += next === 'n' ? '\n' : next === 'r' ? '\r' : next === 't' ? '\t' : next
        index += 2
        continue
      }
      if (char === quote) {
        closed = true
        index += 1
        break
      }
      out += char
      index += 1
    }
    if (!closed) {
      invalid.push(`line ${lineNumber}: key "${key}" has an unterminated ${quote} quote; raw text was kept`)
      return raw
    }
    const rest = raw.slice(index).trim()
    if (rest !== '' && !rest.startsWith('#')) {
      invalid.push(`line ${lineNumber}: key "${key}" has unexpected text after the closing quote; it was dropped`)
    }
    return out
  }
  if (!options.stripInlineComments) return raw
  if (raw.startsWith('#')) return ''
  return raw.replace(/\s+#.*$/, '').trimEnd()
}

/**
 * Parse dotenv file content into an ordered key/value map.
 * @param text - complete file content.
 * @param options - shared parse policy.
 * @returns Values (last duplicate wins) and per-line skip notes.
 */
function parseEnv(text: string, options: ParseOptions): ParsedEnv {
  const values: Record<string, string> = {}
  const invalid: string[] = []
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1
    const line = lines[index]!.trim()
    if (line === '' || line.startsWith('#')) continue
    const statement = options.allowExportPrefix && /^export\s+/.test(line) ? line.replace(/^export\s+/, '') : line
    const separator = statement.indexOf('=')
    if (separator === -1) {
      invalid.push(`line ${lineNumber}: no "=" separator: ${preview(statement)}`)
      continue
    }
    const key = statement.slice(0, separator).trim()
    if (!KEY_PATTERN.test(key)) {
      invalid.push(`line ${lineNumber}: invalid key "${preview(key)}"`)
      continue
    }
    if (key.length > options.maxKeyLength) {
      invalid.push(`line ${lineNumber}: key "${key.slice(0, 24)}..." exceeds ${options.maxKeyLength} characters`)
      continue
    }
    setKey(values, key, readValue(statement.slice(separator + 1).trim(), options, invalid, lineNumber, key))
  }
  return { values, invalid }
}

/**
 * Compare two parsed env maps.
 * @param a - original side.
 * @param b - updated side.
 * @returns Added, removed, and changed keys, all sorted by key.
 */
function diffEnv(a: Record<string, string>, b: Record<string, string>): {
  added: string[]
  removed: string[]
  changed: { key: string; from: string; to: string }[]
  identical: boolean
} {
  const added: string[] = []
  const removed: string[] = []
  const changed: { key: string; from: string; to: string }[] = []
  for (const key of Object.keys(b)) {
    if (!Object.hasOwn(a, key)) added.push(key)
    else if (a[key] !== b[key]) changed.push({ key, from: a[key], to: b[key] })
  }
  for (const key of Object.keys(a)) if (!Object.hasOwn(b, key)) removed.push(key)
  return {
    added: added.sort(),
    removed: removed.sort(),
    changed: changed.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0)),
    identical: added.length === 0 && removed.length === 0 && changed.length === 0,
  }
}

/** Whether a value parses as an http(s) URL. */
function isUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Run one named check against one value.
 * @param check - check kind chosen by the schema.
 * @param value - parsed value.
 * @param pattern - regex source, used only by the `pattern` check.
 * @returns A failure phrase, or `undefined` when the value passes.
 */
function describeFailure(check: CheckName, value: string, pattern: string): string | undefined {
  switch (check) {
    case 'nonempty':
      return value === '' ? 'value is empty' : undefined
    case 'integer':
      return INTEGER_PATTERN.test(value) ? undefined : 'value is not an integer'
    case 'number':
      return value !== '' && Number.isFinite(Number(value)) ? undefined : 'value is not a number'
    case 'boolean':
      return BOOLEAN_PATTERN.test(value) ? undefined : 'value is not a boolean (true/false/1/0/yes/no/on/off)'
    case 'port': {
      if (!INTEGER_PATTERN.test(value)) return 'value is not a port number'
      const port = Number(value)
      return port >= 1 && port <= 65535 ? undefined : 'port must be between 1 and 65535'
    }
    case 'url':
      return isUrl(value) ? undefined : 'value is not an http(s) URL'
    case 'email':
      return EMAIL_PATTERN.test(value) ? undefined : 'value is not an email address'
    case 'csv':
      return value !== '' && value.split(',').every((item) => item.trim() !== '')
        ? undefined
        : 'value is not a comma-separated list of non-empty items'
    case 'pattern': {
      if (pattern === '') return 'check "pattern" needs a non-empty pattern'
      let expression: RegExp
      try {
        expression = new RegExp(pattern)
      } catch (error) {
        return `pattern is not a valid regex: ${error instanceof Error ? error.message : String(error)}`
      }
      return expression.test(value) ? undefined : `value does not match pattern ${pattern}`
    }
    default:
      return `unknown check "${String(check)}"`
  }
}

/** Whether a value must be quoted to survive a re-parse. */
function needsQuotes(value: string): boolean {
  return value === '' || !SAFE_VALUE_PATTERN.test(value)
}

/** Escape one value into a double-quoted dotenv term. */
function quoteValue(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
  return `"${escaped}"`
}

/**
 * Render an object back into dotenv file content.
 * @param values - key/value map supplied by the caller.
 * @param sortKeys - emit keys alphabetically instead of in insertion order.
 * @param options - shared policy (key syntax and length limits).
 * @returns File text ending in a newline, plus counts and skip notes.
 */
function serializeEnv(values: Record<string, unknown>, sortKeys: boolean, options: ParseOptions): {
  text: string
  count: number
  skipped: string[]
} {
  const keys = Object.keys(values)
  if (sortKeys) keys.sort()
  const lines: string[] = []
  const skipped: string[] = []
  for (const key of keys) {
    if (!KEY_PATTERN.test(key)) {
      skipped.push(`"${preview(key)}": not a valid env key`)
      continue
    }
    if (key.length > options.maxKeyLength) {
      skipped.push(`${key}: key exceeds ${options.maxKeyLength} characters`)
      continue
    }
    const value = values[key]
    if (value === null || value === undefined) {
      lines.push(`${key}=`)
      continue
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      skipped.push(`${key}: non-finite number`)
      continue
    }
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      skipped.push(`${key}: ${Array.isArray(value) ? 'array' : typeof value} values are not supported`)
      continue
    }
    const text = typeof value === 'string' ? value : String(value)
    lines.push(`${key}=${needsQuotes(text) ? quoteValue(text) : text}`)
  }
  return { text: lines.length === 0 ? '' : `${lines.join('\n')}\n`, count: lines.length, skipped }
}

/**
 * Resolve the deployment configuration into a parse policy, tolerating a
 * partial or oddly-typed config object coming from a layer file.
 * @param config - explicit deployment config.
 * @returns Normalised parse policy.
 */
function toParseOptions(config: Config): ParseOptions {
  const length = Number(config.maxKeyLength)
  return {
    allowExportPrefix: config.allowExportPrefix !== false,
    stripInlineComments: config.stripInlineComments !== false,
    maxKeyLength: Number.isFinite(length) && length > 0 ? Math.floor(length) : 128,
  }
}

/**
 * Register the four env text tools on `ctx.tools`.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - deployment's explicit env policy.
 */
export function apply(ctx: Context, config: Config): void {
  const options = toParseOptions(config)

  ctx.tools.register(defineTool({
    name: 'env_parse',
    description:
      'Parse dotenv file CONTENT (pass the text, never a path) into key/value pairs. ' +
      'Handles comments, blank lines, `export ` prefixes, single/double quotes with ' +
      '\\n \\t \\\\ escapes, and inline comments. Lines that cannot be read are listed in ' +
      '`invalid` instead of failing the call. On duplicate keys the last value wins.',
    parameters: {
      text: { type: 'string', required: true, description: 'The complete contents of one .env file.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          values: {
            type: 'object',
            required: true,
            additionalProperties: true,
            description: 'Parsed keys in first-seen order; every value is a string.',
          },
          count: { type: 'integer', required: true, description: 'Number of keys parsed.' },
          invalid: {
            type: 'array',
            required: true,
            description: 'One note per unreadable line; empty when the file parsed cleanly.',
            items: { type: 'string' },
          },
        },
      },
      render: (_args, value) => {
        const keys = Object.keys(value.values)
        const head = `${value.count} variable(s): ${keys.length === 0 ? 'none' : keys.join(', ')}`
        const tail = value.invalid.length === 0
          ? ''
          : `\nskipped ${value.invalid.length} line(s):\n- ${value.invalid.join('\n- ')}`
        return [{ type: 'text', text: head + tail }]
      },
    },
    isConcurrencySafe: () => true,
    execute(args) {
      const parsed = parseEnv(args.text, options)
      return Promise.resolve({
        values: parsed.values,
        count: Object.keys(parsed.values).length,
        invalid: parsed.invalid,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'env_diff',
    description:
      'Compare two dotenv files given as text and report the key differences: `added` ' +
      '(in b only), `removed` (in a only), and `changed` (present in both with a ' +
      'different value, reported as from -> to). Pass the original content as `a` and ' +
      'the updated content as `b`; unreadable lines are ignored on both sides.',
    parameters: {
      a: { type: 'string', required: true, description: 'Original / left-hand .env content.' },
      b: { type: 'string', required: true, description: 'Updated / right-hand .env content.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          added: { type: 'array', required: true, description: 'Keys present only in b, sorted.', items: { type: 'string' } },
          removed: { type: 'array', required: true, description: 'Keys present only in a, sorted.', items: { type: 'string' } },
          changed: {
            type: 'array',
            required: true,
            description: 'Keys present in both with different values, sorted by key.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                key: { type: 'string', required: true, description: 'Variable name that changed.' },
                from: { type: 'string', required: true, description: 'Value in a.' },
                to: { type: 'string', required: true, description: 'Value in b.' },
              },
            },
          },
          identical: { type: 'boolean', required: true, description: 'True when the two files define the same keys with the same values.' },
        },
      },
      render: (_args, value) => {
        if (value.identical) return [{ type: 'text', text: 'Identical: same keys, same values.' }]
        const lines = [
          value.added.length === 0 ? '' : `added (${value.added.length}): ${value.added.join(', ')}`,
          value.removed.length === 0 ? '' : `removed (${value.removed.length}): ${value.removed.join(', ')}`,
          value.changed.length === 0
            ? ''
            : `changed (${value.changed.length}): ${value.changed.map((c) => `${c.key}: ${JSON.stringify(c.from)} -> ${JSON.stringify(c.to)}`).join('; ')}`,
        ].filter((line) => line !== '')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe: () => true,
    execute(args) {
      return Promise.resolve(diffEnv(parseEnv(args.a, options).values, parseEnv(args.b, options).values))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'env_validate',
    description:
      'Check dotenv file CONTENT (text, not a path) against a schema you pass inline: ' +
      '`required` and `optional` list the expected key names, and `checks` gives per-key ' +
      'value rules (nonempty, integer, number, boolean, port, url, email, csv, pattern). ' +
      'Reported: `missing` required keys, `extra` keys not declared anywhere in the ' +
      'schema, and `errors` for rule failures and unreadable lines. Keys named in a ' +
      'check count as declared. Set pattern to "" for every check that is not "pattern".',
    parameters: {
      text: { type: 'string', required: true, description: 'The complete contents of the .env file to check.' },
      schema: {
        type: 'object',
        required: true,
        additionalProperties: false,
        description: 'Expected keys and per-key value rules.',
        properties: {
          required: {
            type: 'array',
            required: true,
            description: 'Keys that must be present. Pass [] when none are required.',
            items: { type: 'string' },
          },
          optional: {
            type: 'array',
            required: true,
            description: 'Keys that are allowed but not required. Pass [] when none are optional.',
            items: { type: 'string' },
          },
          checks: {
            type: 'array',
            required: true,
            description: 'Per-key value rules; skipped when the key is absent. Pass [] for no rules.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                key: { type: 'string', required: true, description: 'Variable to check.' },
                check: {
                  type: 'string',
                  required: true,
                  description: 'Rule kind: nonempty, integer, number, boolean, port, url, email, csv, or pattern.',
                  enum: ['nonempty', 'integer', 'number', 'boolean', 'port', 'url', 'email', 'csv', 'pattern'],
                },
                pattern: {
                  type: 'string',
                  required: true,
                  description: 'Regex source used only when check is "pattern"; pass "" otherwise.',
                },
              },
            },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          valid: { type: 'boolean', required: true, description: 'True when nothing is missing, extra, or failing.' },
          count: { type: 'integer', required: true, description: 'Number of keys parsed from the text.' },
          missing: { type: 'array', required: true, description: 'Required keys absent from the file, sorted.', items: { type: 'string' } },
          extra: { type: 'array', required: true, description: 'Keys not declared by the schema, sorted.', items: { type: 'string' } },
          errors: {
            type: 'array',
            required: true,
            description: 'Rule failures plus unreadable-line notes, in check order.',
            items: { type: 'string' },
          },
        },
      },
      render: (_args, value) => {
        if (value.valid) return [{ type: 'text', text: `Valid: ${value.count} variable(s), schema satisfied.` }]
        const lines = [`Invalid (${value.count} variable(s) parsed):`]
        if (value.missing.length > 0) lines.push(`- missing: ${value.missing.join(', ')}`)
        if (value.extra.length > 0) lines.push(`- extra: ${value.extra.join(', ')}`)
        for (const error of value.errors) lines.push(`- ${error}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe: () => true,
    execute(args) {
      const parsed = parseEnv(args.text, options)
      const declared = new Set([...args.schema.required, ...args.schema.optional, ...args.schema.checks.map((c) => c.key)])
      const missing = args.schema.required.filter((key) => !Object.hasOwn(parsed.values, key)).sort()
      const extra = Object.keys(parsed.values).filter((key) => !declared.has(key)).sort()
      const errors = [...parsed.invalid]
      for (const rule of args.schema.checks) {
        if (!Object.hasOwn(parsed.values, rule.key)) continue
        const failure = describeFailure(rule.check, parsed.values[rule.key], rule.pattern)
        if (failure !== undefined) errors.push(`${rule.key}: ${failure}`)
      }
      return Promise.resolve({
        valid: missing.length === 0 && extra.length === 0 && errors.length === 0,
        count: Object.keys(parsed.values).length,
        missing,
        extra,
        errors,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'env_serialize',
    description:
      'Turn a key/value object back into dotenv file text (one `KEY=value` line per ' +
      'entry, ending with a newline) so the caller can write the file itself. Values ' +
      'are quoted only when needed; strings with spaces, `#`, quotes, `=` or newlines ' +
      'get double quotes with escapes, `null` becomes `KEY=`, and array or object ' +
      'values are refused and listed in `skipped`. Set sortKeys to true for an ' +
      'alphabetical .env, false to keep the object key order.',
    parameters: {
      values: {
        type: 'object',
        required: true,
        additionalProperties: true,
        description: 'Map of variable name to string / number / boolean / null value.',
      },
      sortKeys: { type: 'boolean', required: true, description: 'Emit keys alphabetically instead of in insertion order.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true, description: 'Dotenv file content, ready to write; empty when nothing serialized.' },
          count: { type: 'integer', required: true, description: 'Number of lines emitted.' },
          skipped: {
            type: 'array',
            required: true,
            description: 'One note per entry that could not be serialized; empty otherwise.',
            items: { type: 'string' },
          },
        },
      },
      render: (_args, value) => {
        const head = `${value.count} line(s) serialized${value.skipped.length === 0 ? '' : `, ${value.skipped.length} skipped`}`
        const body = value.text === '' ? head : `${head}\n\n${value.text.replace(/\n$/, '')}`
        const tail = value.skipped.length === 0 ? '' : `\nskipped:\n- ${value.skipped.join('\n- ')}`
        return [{ type: 'text', text: body + tail }]
      },
    },
    isConcurrencySafe: () => true,
    execute(args) {
      return Promise.resolve(serializeEnv(args.values, args.sortKeys, options))
    },
  }))
}
