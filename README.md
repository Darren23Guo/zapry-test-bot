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
/card
/choice
/modal
```

## 配置

项目会读取仓库中的 `.env`。该文件包含开源测试 bot token，拉取项目后可直接运行。

`.env` 配置：

```bash
ZAPRY_BOT_TOKENS=603876:49b22aaf413b403db9c794a2734c6fd9,602446:f7c661e051774f82a4a65459ae850ec8,603876:03f3885752754fe183e837d831e115ab # 开源测试 bot token，可直接使用；多个 bot 用英文逗号分隔
ZAPRY_API_BASE_URL=https://openapi.mimo.immo
ZAPRY_POLL_TIMEOUT=30
ZAPRY_POLL_LIMIT=10
```

如果要换成自己的 bot，把 `ZAPRY_BOT_TOKENS` 改成你的 token；多个 bot 用英文逗号分隔。

## Agent Card 测试

当前测试 bot 支持一组非支付类 Agent Card smoke 用例：

- `/card`：发送基础 Agent Card，包含 toast ack、`defer + editMessage`、服务端 Modal、本地 Modal、打开文档按钮。
- `/choice`：发送 `choice_group` 测试卡，提交时会把 `component_values` 回传给 bot，并用 `editMessage` 原地更新卡片。
- `/modal`：发送 Modal 测试卡，覆盖 client-side Modal 和 server-side Modal。

也可以发送中文触发词：

```text
测试卡片
测试选择
测试modal
```

为了避免误触发钱包签名或真实支付，当前测试 bot 不直接发送真实 `payment_card`。PaymentCard 请使用测试钱包和专门业务 bot 跑。

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
