# Zapry Test Bot

本地测试用 Zapry bot 后台服务。支持 `getUpdates` 长轮询和 webhook 两种收消息方式，再用 `sendMessage` 回复。

## 启动

```bash
npm run check
npm run service:start
```

测试服务环境：

```bash
npm run check:test
npm run smoke:check:test
npm run smoke:test
npm run start:test
npm run webhook:test
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

项目默认读取仓库中的 `.env`。该文件包含开源测试 bot token，拉取项目后可直接运行。

`.env` 配置：

```bash
ZAPRY_BOT_TOKENS=603876:49b22aaf413b403db9c794a2734c6fd9,602446:f7c661e051774f82a4a65459ae850ec8,603876:03f3885752754fe183e837d831e115ab # 开源测试 bot token，可直接使用；多个 bot 用英文逗号分隔
ZAPRY_API_BASE_URL=https://openapi.mimo.immo
ZAPRY_POLL_TIMEOUT=30
ZAPRY_POLL_LIMIT=10
```

如果要换成自己的 bot，把 `ZAPRY_BOT_TOKENS` 改成你的 token；多个 bot 用英文逗号分隔。

测试服务环境使用 `.env.test`，并配置测试环境 bot token：

```bash
ZAPRY_API_BASE_URL=https://openapi-dev.mimo.immo
ZAPRY_BOT_TOKENS=850672:637158a8a29f4d45a62afb1e736039e9,850709:d06709013bca4533ae42e3bd0b5bedbd
ZAPRY_POLL_TIMEOUT=30
ZAPRY_POLL_LIMIT=10
```

脚本也兼容 `OPENAPI=https://openapi-dev.mimo.immo` 这个别名，但推荐继续使用 `ZAPRY_API_BASE_URL`。

也可以通过命令行临时切换：

```bash
node src/bot.js --env test --check
```

## getUpdates / Webhook 模式

轮询模式仍然是默认启动方式，会先调用 `deleteWebhook`，保证 `getUpdates` 可用：

```bash
npm run start:test
```

webhook 模式会启动本地 HTTP receiver，并调用 `setWebhook` 把 bot 的 webhook URL 设置到 OpenAPI：

```bash
ZAPRY_WEBHOOK_URL=https://你的公网域名/zapry/webhooks npm run webhook:test
```

本地 receiver 默认监听：

```text
0.0.0.0:8080/zapry/webhooks
```

如果配置了多个 bot，脚本会自动给每个 bot 设置独立路径，例如：

```text
https://你的公网域名/zapry/webhooks/850672
https://你的公网域名/zapry/webhooks/850709
```

常用配置：

```bash
ZAPRY_WEBHOOK_URL=https://你的公网域名/zapry/webhooks
ZAPRY_WEBHOOK_HOST=0.0.0.0
ZAPRY_WEBHOOK_PORT=8080
ZAPRY_WEBHOOK_PATH=/zapry/webhooks
ZAPRY_WEBHOOK_SECRET_TOKEN=optional-secret
```

也可以用命令行参数：

```bash
node src/bot.js --env test --webhook --webhook-url https://你的公网域名/zapry/webhooks --webhook-port 8080
```

如果只想本地启动 receiver，不想自动调用 `setWebhook`：

```bash
node src/bot.js --env test --webhook --no-set-webhook
```

收到 webhook 后，处理逻辑和轮询模式复用同一套命令，所以仍然可以在 App 里发送：

```text
/start
hello
/id
/card
/choice
/modal
```

## OpenAPI Smoke 验证

不启动长轮询 bot，也可以直接跑 OpenAPI 链路 smoke：

```bash
npm run smoke:test
```

smoke 脚本放在 `test/smoke.js`，和 `src/bot.js` 运行时代码分开。

默认只使用 `ZAPRY_BOT_TOKENS` 里的第一个 token，验证：

- `getMe`
- `getWebhookInfo`
- 私聊 `sendMessage`
- 私聊 `sendLinkCard`
- 群聊 `sendLinkCard`（需要额外配置群 id）

只检查环境和 token，不发送消息：

```bash
npm run smoke:check:test
```

验证群聊 link card：

```bash
ZAPRY_SMOKE_GROUP_CHAT_ID=g_<测试群id> npm run smoke:test
```

如果只知道纯群号，也可以不写 `g_`，脚本会自动补前缀：

```bash
ZAPRY_SMOKE_GROUP_CHAT_ID=<测试群id> npm run smoke:test
```

测试所有配置的 bot：

```bash
npm run smoke:all:test
```

指定某个 bot：

```bash
ZAPRY_SMOKE_BOT_ID=850709 npm run smoke:test
```

期望结果：

```text
OK   getMe
OK   getWebhookInfo
OK   sendMessage private
OK   sendLinkCard private
OK   sendLinkCard group
Smoke summary: 1/1 bot(s) passed.
```

常见失败含义：

- `invalid message type`：群 link card 还在旧环信 group send 路径，或 `huanxin-im-provider` 未部署修复。
- `bot_private_dm_unsupported_message_type`：`mimo-im/im-rpc` 未部署支持 `link_share_card` 的版本。
- `access denied` / `403`：bot 没进群，或群权限 / group privacy 不允许。
- `ENOTFOUND` / timeout：本机 DNS、VPN、网络或测试入口不可达。

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
- Webhook 调试：使用 `npm run webhook:test`，需要公网 HTTPS endpoint 转发到本地 receiver。
- 多个 bot：用英文逗号把多个 token 写进 `ZAPRY_BOT_TOKENS`，同一个后台进程会同时处理。token 前缀重复时会自动生成 `603876_2` 这类本地 id，避免状态文件冲突。
- 轮询模式启动时会先调用 `deleteWebhook`，让 `getUpdates` 可用；webhook 模式启动时会调用 `setWebhook`。

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
