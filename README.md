# dsh-env-switcher

DeepSeek Harness tool plugin: four pure tools for working with `.env` file
**content**. The model passes dotenv text in and gets structured data or ready
file text out — the plugin never opens a file, spawns a process, reads the host
environment, or talks to the network, so every call is deterministic and
parallel-safe.

## Install

```bash
npx -y @deepseek-ai/dsh plugin --profile web add @qingshanjiluo/dsh-env-switcher
```

The bundle layer (`cordis.patch.yml`) inserts the plugin into the profile's
layer stack; the tools appear in the model's tool list on the next session.

## Tools

| Tool | Input | Output |
| --- | --- | --- |
| `env_parse` | `text` — complete `.env` content | `values` (ordered key → string map), `count`, `invalid` (one note per unreadable line) |
| `env_diff` | `a` — original content, `b` — updated content | `added`, `removed`, `changed` (`{ key, from, to }`), `identical` |
| `env_validate` | `text` — `.env` content, `schema` (`required[]`, `optional[]`, `checks[{ key, check, pattern }]`) | `valid`, `count`, `missing`, `extra`, `errors` |
| `env_serialize` | `values` — key → scalar map, `sortKeys` — emit alphabetically | `text` (file-ready content ending in a newline), `count`, `skipped` |

### Parsing rules

- Blank lines and `#` comment lines are ignored; `export KEY=value` is accepted.
- Single-quoted values are literal. Double-quoted values expand `\n`, `\r`,
  `\t`, `\"`, `\\`. An unterminated quote or trailing junk after the closing
  quote is reported in `invalid` and never throws.
- Unquoted values drop a ` # comment` when it is preceded by whitespace
  (configurable); `KEY=#thing` becomes an empty value.
- Duplicate keys: the last value wins, the first position is kept.
- Keys must match `[A-Za-z_][A-Za-z0-9_]*` and stay within `maxKeyLength`;
  anything else is reported in `invalid` / `errors` / `skipped`.

### Validation checks

`check` accepts `nonempty`, `integer`, `number`, `boolean`
(`true/false/1/0/yes/no/on/off`, case-insensitive), `port` (1–65535), `url`
(http/https), `email`, `csv` (comma-separated, no empty items), and `pattern`
(a regex source in the same check entry — an invalid regex is reported as an
error instead of throwing). A check for a key that is absent is skipped; keys
named in a check count as declared, so they are not reported as `extra`.

## Configuration

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `allowExportPrefix` | boolean | `true` | Accept `export KEY=value` lines when parsing |
| `stripInlineComments` | boolean | `true` | Drop trailing ` # comment` from unquoted values |
| `maxKeyLength` | number | `128` | Report keys longer than this instead of storing them |

## Example

```text
env_validate({
  text: "PORT=8080\nEXTRA=1",
  schema: {
    required: ["PORT", "HOST"],
    optional: [],
    checks: [{ key: "PORT", check: "port", pattern: "" }],
  },
})
# -> missing: HOST · extra: EXTRA · valid: false
```

## Development

```bash
npm install --no-audit --no-fund
npx tsc --noEmit
npm run build          # lib/index.js + lib/index.d.ts
npx vitest run         # 23 behaviour cases
node scripts/load-smoke.mjs
```

## License

MIT
