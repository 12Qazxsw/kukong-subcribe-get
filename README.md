# 自动注册并抓取订阅（自动化脚本）

简体中文说明：本项目用于自动通过网站 API 注册账号、跟随重定向并从订阅中心抓取 `/sub/.../clash` 格式的订阅链接。

## 环境要求

- Node.js (建议 >=16)

## 安装

1. 切换到项目目录（本例为 C:\Users\Administrator\Desktop\api）
2. 安装依赖：

```bash
npm install
```

## 常用命令

- 创建 1 个账号并尝试复制订阅到系统剪贴板：

```bash
node register.js 1
```

- 创建 N 个账号：

```bash
node register.js 5
```

- 修复（登录并获取）第一个需要更新的账号的 `/sub/...` 订阅并复制：

```bash
node register.js fix
```

- 修复全部账号：

```bash
node register.js fix all
# 或
node register.js fix-all
```

## 行为与注意事项

- 启动时脚本会自动删除 `accounts.json` 中创建时间超过 24 小时的账号（只保留一天内创建的账号）。
- 注册后或修复成功会把第一个可用的 `/sub/.../clash` 订阅复制到系统剪贴板（使用 `clipboardy`）。
- 请求默认使用正常 TLS，遇到部分 TLS 错误会回退到“放宽验证”重试（会跳过证书校验，存在安全风险）。如需禁用回退或改为 Puppeteer，请联系我修改代码。

## 主要文件

- `register.js` — 主脚本，包含注册、抓取、登录修复与剪贴板复制逻辑。
- `package.json` — 依赖与脚本。
- `accounts.json` — 保存已创建账号与订阅（脚本会写入/更新该文件）。
- `used.json` — 记录已使用的用户名/邮箱，避免重复。

## 隐私与合规

- 请确保对目标站点的自动化操作符合该站点的服务条款与当地法律法规。不要用于未经授权的入侵、滥发或其他违规用途。

## AI相关

本项目大部分代码包括README 都是由AI辅助生成
