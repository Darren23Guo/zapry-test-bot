# Zapry Test Bot

本地测试用 Zapry bot 后台服务。它使用 `getUpdates` 长轮询收消息，再用 `sendMessage` 回复。

## 启动

```bash
npm run check
npm run service:start
```

启动后，在 Zapry iOS / Android 里给 bot 发：

```text
/start
hello
/id
/help
```

## 配置

项目会读取 `.env`，再读取可选的 `.env.local`。`.env` 会提交到仓库，适合放开源默认配置；`.env.local` 已被忽略，适合放你本机真实 token。

`.env` 默认内容：

```bash
ZAPRY_BOT_TOKENS=replace_with_your_bot_token # 替换为你的 bot token；多个 bot 用英文逗号分隔
ZAPRY_API_BASE_URL=https://openapi.mimo.immo
ZAPRY_POLL_TIMEOUT=30
ZAPRY_POLL_LIMIT=10
```

本地真实配置可以写到 `.env.local`：

```bash
ZAPRY_BOT_TOKENS=603876:your_real_token,602446:your_real_token
```

## 工作方式

- 本地调试：使用 `getUpdates`，不需要公网地址。
- 多个 bot：用英文逗号把多个 token 写进 `ZAPRY_BOT_TOKENS`，同一个后台进程会同时轮询。token 前缀重复时会自动生成 `603876_2` 这类本地 id，避免状态文件冲突。
- 线上服务：建议改成 `Webhook`，需要公网 HTTPS endpoint。
- 如果 webhook 已经设置，本服务启动时会先调用 `deleteWebhook`，让本地轮询模式可用。

## 后台服务

当前已注册为 macOS 用户级 LaunchAgent：

```bash
npm run service:status
npm run service:restart
npm run service:stop
npm run logs
```

LaunchAgent 配置文件：

```text
/Users/dazhaoguo/Library/LaunchAgents/com.zapry.test-bot.plist
```
