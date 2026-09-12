/**
 * Loads the built artifact and asserts it exports the Cordis function-plugin
 * face the harness loader requires, then registers all four tools and calls
 * each one once. Run after `npm run build`.
 * @module
 */
import assert from 'node:assert/strict'

const mod = await import(new URL('../lib/index.js', import.meta.url).href)

assert.equal(mod.name, 'dsh-env-switcher', 'plugin name export')
assert.deepEqual(mod.inject, ['tools'], 'inject declares the tools service')
assert.equal(typeof mod.apply, 'function', 'apply is a function')
assert.ok(mod.Config, 'Config schema export present')
assert.deepEqual(
  mod.Config({}),
  { allowExportPrefix: true, stripInlineComments: true, maxKeyLength: 128 },
  'Config fills deployment defaults',
)

const registered = []
mod.apply(
  { tools: { register: def => registered.push(def) } },
  { allowExportPrefix: true, stripInlineComments: true, maxKeyLength: 128 },
)
assert.deepEqual(
  registered.map(def => def.name).sort(),
  ['env_diff', 'env_parse', 'env_serialize', 'env_validate'],
  'all four tools register',
)

const byName = new Map(registered.map(def => [def.name, def]))
const noopExec = {}

const parsed = await byName.get('env_parse').execute({ text: '# profile\nAPP=demo\nPORT="8080" # inline\nBROKEN line' }, noopExec)
assert.deepEqual(parsed.values, { APP: 'demo', PORT: '8080' }, 'env_parse reads dotenv text')
assert.equal(parsed.invalid.length, 1, 'env_parse reports the unreadable line')

const diff = await byName.get('env_diff').execute({ a: 'A=1\nGONE=1', b: 'A=2' }, noopExec)
assert.deepEqual(
  { added: diff.added, removed: diff.removed, changed: diff.changed, identical: diff.identical },
  { added: [], removed: ['GONE'], changed: [{ key: 'A', from: '1', to: '2' }], identical: false },
  'env_diff reports key differences',
)

const validated = await byName.get('env_validate').execute({
  text: 'PORT=8080\nEXTRA=1',
  schema: {
    required: ['PORT', 'HOST'],
    optional: [],
    checks: [{ key: 'PORT', check: 'port', pattern: '' }],
  },
}, noopExec)
assert.equal(validated.valid, false, 'env_validate flags the incomplete file')
assert.deepEqual(validated.missing, ['HOST'], 'env_validate reports missing required keys')
assert.deepEqual(validated.extra, ['EXTRA'], 'env_validate reports undeclared keys')

const serialized = await byName.get('env_serialize').execute({ values: { APP: 'demo', NOTE: 'two words' }, sortKeys: true }, noopExec)
assert.equal(serialized.text, 'APP=demo\nNOTE="two words"\n', 'env_serialize emits file-ready text')

console.log('load-smoke: ok —', registered.length, 'tools registered from built artifact')
