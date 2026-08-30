/**
 * dsh-env-switcher — 环境变量管理
 *
 * 功能：
 * 1. .env解析
 * 2. 变量设置
 * 3. 差异对比
 * 4. 环境切换
 * 5. 备份恢复
 * 6. 验证
 *
 * 工具：env_list, env_get, env_set, env_diff, env_switch, env_backup, env_validate
 * 命令：/env
 * 配置：enabled
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, copyFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { z } from 'zod';

export const name = 'dsh-env-switcher';
export const inject = ['settings', 'tools', 'commands'];

const configSchema = z.object({
  enabled: z.boolean().default(true),
  envFile: z.string().default('.env'),
  backupEnabled: z.boolean().default(true),
});

type Config = z.infer<typeof configSchema>;

function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const content = readFileSync(path, 'utf-8');
  const vars: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.substring(0, eqIdx).trim();
    let value = trimmed.substring(eqIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
}

function writeEnvFile(path: string, vars: Record<string, string>): void {
  const lines = Object.entries(vars).map(([k, v]) => {
    if (v.includes(' ') || v.includes('#')) return `${k}="${v}"`;
    return `${k}=${v}`;
  });
  writeFileSync(path, lines.join('\n') + '\n', 'utf-8');
}

function diffEnv(base: Record<string, string>, target: Record<string, string>) {
  const added: Record<string, string> = {};
  const removed: Record<string, string> = {};
  const changed: Record<string, { from: string; to: string }> = {};
  for (const [k, v] of Object.entries(target)) {
    if (!(k in base)) added[k] = v;
    else if (base[k] !== v) changed[k] = { from: base[k], to: v };
  }
  for (const k of Object.keys(base)) {
    if (!(k in target)) removed[k] = base[k];
  }
  return { added, removed, changed };
}

function backupEnv(path: string): string {
  const backupPath = path + '.backup.' + Date.now();
  copyFileSync(path, backupPath);
  return backupPath;
}

function validateEnvVars(vars: Record<string, string>): { key: string; issue: string }[] {
  const issues: { key: string; issue: string }[] = [];
  for (const [k, v] of Object.entries(vars)) {
    if (!v) issues.push({ key: k, issue: '值为空' });
    if (/^(password|secret|token|key)$/i.test(k) && v.length < 8) issues.push({ key: k, issue: '敏感字段值过短' });
    if (v === 'undefined' || v === 'null') issues.push({ key: k, issue: '值为字面量 undefined/null' });
  }
  return issues;
}

export function apply(ctx: any, config: Config) {
  if (!config.enabled) return;

  ctx.effect(() => ctx.tools.register({
    name: 'env_list',
    description: '列出 .env 文件中的所有环境变量。',
    parameters: { file: { type: 'string', description: '.env 文件路径（默认当前配置）' } },
    output: { schema: { type: 'json' }, render: (_a: unknown, v: unknown) => {
      const vars = v as Record<string, string>;
      const keys = Object.keys(vars);
      if (keys.length === 0) return [{ type: 'text', text: '📭 没有环境变量' }];
      return [{ type: 'text', text: `## 🔧 环境变量 (${keys.length})\n` + keys.map(k => `- \`${k}\` = \`${vars[k].substring(0, 30)}${vars[k].length > 30 ? '...' : ''}\``).join('\n') }];
    }},
    async execute(args: { file?: string }) { return parseEnvFile(resolve(args.file || config.envFile)); },
  }), 'dsh-env-switcher: env_list');

  ctx.effect(() => ctx.tools.register({
    name: 'env_get',
    description: '获取指定环境变量的值。',
    parameters: { key: { type: 'string', description: '变量名' }, file: { type: 'string', description: '文件路径' } },
    output: { schema: { type: 'json' }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: v as string }] },
    async execute(args: { key: string; file?: string }) {
      const vars = parseEnvFile(resolve(args.file || config.envFile));
      return vars[args.key] ?? `(未设置: ${args.key})`;
    },
  }), 'dsh-env-switcher: env_get');

  ctx.effect(() => ctx.tools.register({
    name: 'env_set',
    description: '设置环境变量（写入 .env 文件）。',
    parameters: { key: { type: 'string', description: '变量名' }, value: { type: 'string', description: '变量值' }, file: { type: 'string', description: '文件路径' } },
    output: { schema: { type: 'json' }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: `✅ ${v}` }] },
    async execute(args: { key: string; value: string; file?: string }) {
      const path = resolve(args.file || config.envFile);
      const vars = parseEnvFile(path);
      vars[args.key] = args.value;
      writeEnvFile(path, vars);
      return `已设置 ${args.key}=${args.value.substring(0, 20)}${args.value.length > 20 ? '...' : ''}`;
    },
  }), 'dsh-env-switcher: env_set');

  ctx.effect(() => ctx.tools.register({
    name: 'env_diff',
    description: '比较两个 .env 文件的差异。',
    parameters: { file1: { type: 'string', description: '第一个文件' }, file2: { type: 'string', description: '第二个文件' } },
    output: { schema: { type: 'json' }, render: (_a: unknown, v: unknown) => {
      const d = v as any;
      const lines = ['## 📊 环境变量差异'];
      if (Object.keys(d.added).length) { lines.push('### 新增'); for (const [k, v] of Object.entries(d.added)) lines.push(`+ ${k}=${v}`); }
      if (Object.keys(d.removed).length) { lines.push('### 删除'); for (const k of Object.keys(d.removed)) lines.push(`- ${k}`); }
      if (Object.keys(d.changed).length) { lines.push('### 修改'); for (const [k, c] of Object.entries(d.changed)) { const cv = c as any; lines.push(`~ ${k}: ${cv.from} → ${cv.to}`); } }
      return [{ type: 'text', text: lines.join('\n') }];
    }},
    async execute(args: { file1: string; file2: string }) {
      return diffEnv(parseEnvFile(resolve(args.file1)), parseEnvFile(resolve(args.file2)));
    },
  }), 'dsh-env-switcher: env_diff');

  ctx.effect(() => ctx.tools.register({
    name: 'env_switch',
    description: '切换到不同的环境配置文件（如 .env.development → .env.production）。',
    parameters: { profile: { type: 'string', description: '配置名（如 development, production, test）' } },
    output: { schema: { type: 'json' }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: `✅ ${v}` }] },
    async execute(args: { profile: string }) {
      const path = resolve(args.profile.includes('.') ? args.profile : `.env.${args.profile}`);
      if (!existsSync(path)) throw new Error(`配置文件不存在: ${path}`);
      const targetPath = resolve(config.envFile);
      if (config.backupEnabled && existsSync(targetPath)) backupEnv(targetPath);
      const vars = parseEnvFile(path);
      writeEnvFile(targetPath, vars);
      return `已切换到 ${args.profile} (${Object.keys(vars).length} 个变量)`;
    },
  }), 'dsh-env-switcher: env_switch');

  ctx.effect(() => ctx.tools.register({
    name: 'env_backup',
    description: '备份当前 .env 文件。',
    output: { schema: { type: 'json' }, render: (_a: unknown, v: unknown) => [{ type: 'text', text: `✅ 已备份到: ${v}` }] },
    async execute() {
      const path = resolve(config.envFile);
      if (!existsSync(path)) throw new Error('.env 文件不存在');
      return backupEnv(path);
    },
  }), 'dsh-env-switcher: env_backup');

  ctx.effect(() => ctx.tools.register({
    name: 'env_validate',
    description: '验证环境变量的完整性和安全性。',
    parameters: { file: { type: 'string', description: '文件路径' } },
    output: { schema: { type: 'json' }, render: (_a: unknown, v: unknown) => {
      const issues = v as { key: string; issue: string }[];
      if (issues.length === 0) return [{ type: 'text', text: '✅ 所有环境变量验证通过' }];
      return [{ type: 'text', text: `⚠️ 发现 ${issues.length} 个问题:\n` + issues.map(i => `- \`${i.key}\`: ${i.issue}`).join('\n') }];
    }},
    async execute(args: { file?: string }) {
      return validateEnvVars(parseEnvFile(resolve(args.file || config.envFile)));
    },
  }), 'dsh-env-switcher: env_validate');

  ctx.effect(() => ctx.commands.register({
    name: 'env',
    description: '环境变量管理',
    input: { hint: 'list | get <key> | set <key> <value> | switch <profile> | diff <f1> <f2> | backup | validate' },
    async handler(invocation: any) {
      const parts = invocation.rawInput.trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0) return { kind: 'text', text: '用法: /env list|get|set|switch|diff|backup|validate' };
      const cmd = parts[0];
      switch (cmd) {
        case 'list': { const v = parseEnvFile(resolve(config.envFile)); return { kind: 'text', text: Object.keys(v).join('\n') }; }
        case 'get': { const v = parseEnvFile(resolve(config.envFile)); return { kind: 'text', text: v[parts[1]] || '未设置' }; }
        case 'validate': { const v = validateEnvVars(parseEnvFile(resolve(config.envFile))); return { kind: 'text', text: v.length === 0 ? '通过' : v.map(i => `${i.key}: ${i.issue}`).join('\n') }; }
        default: return { kind: 'text', text: `未知命令: ${cmd}` };
      }
    },
  }), 'dsh-env-switcher: command');

  ctx.inject(['settings'], (sctx: any) => {
    const { settingsNamespace } = require('@deepseek-ai/dsh-settings');
    sctx.settings.register(settingsNamespace('env-switcher'), configSchema, { base: config, expose: true, applies: 'live' });
  });
}
