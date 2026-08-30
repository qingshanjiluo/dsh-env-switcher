import React from 'react';
const NS = 'env-switcher';
const zh = { title: '环境变量管理', description: '.env 文件管理、切换、验证', enabled: '启用插件', backupEnabled: '启用备份', envFile: '配置文件路径' };
const en = { title: 'Environment Switcher', description: '.env file management, switch, validate', enabled: 'Enable plugin', backupEnabled: 'Enable backup', envFile: 'Config file path' };
export const inject = ['settingsScope', 'slots', 'locale'];
export function apply(ctx: any) {
  ctx.effect?.(() => ctx.locale?.register?.(NS, { zh, en }), 'dsh-env-switcher: locale');
  ctx.effect?.(() => { ctx.slots?.inject?.('settings.plugin.item', function* () { yield ctx.slots.register({ name: 'settings.plugin.item', key: NS, locale: NS, inject: () => ({}) }, Card); }); }, 'dsh-env-switcher: settings');
}
function Card(props: any) {
  const { scope, t } = props;
  const [open, setOpen] = React.useState(false);
  return React.createElement('li', null,
    React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', padding: '8px 0', cursor: 'pointer' }, onClick: () => setOpen(!open) },
      React.createElement('strong', null, '🔧 ', t('title')),
      React.createElement('span', { style: { fontSize: '12px', color: '#888' } }, open ? '▲' : '▼')),
    open ? React.createElement('div', { style: { padding: '8px 0', borderTop: '1px solid #333' } },
      React.createElement('label', { style: { display: 'flex', gap: '8px', cursor: 'pointer', marginBottom: '8px' } },
        React.createElement('input', { type: 'checkbox', checked: scope?.get?.('enabled') ?? true, onChange: (e: any) => scope?.set?.('enabled', e.target.checked) }), t('enabled')),
      React.createElement('label', { style: { display: 'flex', gap: '8px', cursor: 'pointer' } },
        React.createElement('input', { type: 'checkbox', checked: scope?.get?.('backupEnabled') ?? true, onChange: (e: any) => scope?.set?.('backupEnabled', e.target.checked) }), t('backupEnabled'))) : null);
}
