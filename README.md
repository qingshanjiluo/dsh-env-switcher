# dsh-env-switcher

> DeepSeek Harness 环境变量管理

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## ✨ 功能特性

- 🔧 **环境管理**: 解析、写入、验证 .env 文件
- 🔄 **环境切换**: 快速切换 .env.development/.env.production
- 📊 **差异对比**: 比较两个 .env 文件的差异
- 💾 **备份恢复**: 备份和恢复环境配置
- ✅ **验证**: 空值、敏感字段长度、字面量检测

## 📦 安装

```bash
npm install dsh-env-switcher
```

## 🛠️ 工具

| 工具名 | 描述 | 参数 |
|--------|------|------|
| `env_list` | 列出环境变量 | `file` |
| `env_get` | 获取变量值 | `key`, `file` |
| `env_set` | 设置变量 | `key`, `value`, `file` |
| `env_diff` | 对比两个 .env | `file1`, `file2` |
| `env_switch` | 切换环境配置 | `profile` |
| `env_backup` | 备份 .env | 无 |
| `env_validate` | 验证变量 | `file` |

## 📋 命令

- `/env list` — 列出变量
- `/env get <key>` — 获取值
- `/env set <key> <value>` — 设置值
- `/env switch <profile>` — 切换环境
- `/env validate` — 验证

## ⚙️ 配置

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `enabled` | boolean | `true` | 启用插件 |
| `envFile` | string | `.env` | 配置文件路径 |
| `backupEnabled` | boolean | `true` | 启用备份 |

## 📄 License

MIT
