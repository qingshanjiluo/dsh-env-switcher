import React from 'react';
import { createSettingsCard } from '@deepseek-ai/dsh-settings';

export default createSettingsCard({
  title: 'env-switcher',
  description: '环境变量管理',
  config: [
    { key: 'enabled', type: 'boolean', label: '启用插件', default: true },
    { key: 'envFile', type: 'string', label: '配置文件路径', default: '.env' },
    { key: 'backupEnabled', type: 'boolean', label: '启用备份', default: true },
  ],
});
