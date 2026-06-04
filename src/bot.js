import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const runtimeOptions = parseRuntimeOptions(process.argv.slice(2));
const activeEnvName = normalizeEnvName(runtimeOptions.envName || process.env.ZAPRY_ENV);

if (activeEnvName) {
  loadDotEnv(path.join(rootDir, `.env.${activeEnvName}`));
}
loadDotEnv(path.join(rootDir, ".env"));

const baseUrl = normalizeBaseUrl(process.env.ZAPRY_API_BASE_URL || process.env.OPENAPI || "https://openapi.mimo.immo");
const pollTimeout = Number(process.env.ZAPRY_POLL_TIMEOUT || 30);
const pollLimit = Number(process.env.ZAPRY_POLL_LIMIT || 10);
const bots = parseBotTokens();
const defaultWebhookPath = "/zapry/webhooks";
const maxWebhookBodyBytes = 1024 * 1024;
const logWebhookBody = isTruthy(process.env.ZAPRY_LOG_WEBHOOK_BODY);
let eventCounter = 0;

if (bots.length === 0) {
  console.error("Missing bot token. Put ZAPRY_BOT_TOKENS or ZAPRY_BOT_TOKEN in .env or the active .env.<env> file.");
  process.exit(1);
}

let stopping = false;
let activeServer = null;

process.on("SIGINT", requestStop);
process.on("SIGTERM", requestStop);

function requestStop() {
  if (stopping) return;
  stopping = true;
  console.log("\nStopping after current request...");
  if (activeServer) {
    activeServer.close(() => {
      console.log("Webhook server stopped.");
    });
  }
}

async function main() {
  const mode = normalizeRunMode(runtimeOptions.mode || process.env.ZAPRY_RUN_MODE || "polling");
  console.log(`Zapry API: ${baseUrl}${activeEnvName ? ` (${activeEnvName})` : ""}`);

  if (mode === "check") {
    for (const bot of bots) {
      await checkBot(bot);
    }
    return;
  }

  if (mode === "webhook") {
    await runWebhookMode();
    return;
  }

  await Promise.all(bots.map((bot) => preparePollingMode(bot)));

  if (mode === "once") {
    await Promise.all(bots.map((bot) => pollOnce(bot)));
    return;
  }

  await runPollingMode();
}

async function runPollingMode() {
  console.log(`Zapry test bot runner is running for ${bots.length} bot(s).`);
  console.log(`Bot IDs: ${bots.map((bot) => bot.id).join(", ")}`);
  console.log("Try sending /start, hello, /id, or /help to the bot.");

  while (!stopping) {
    await Promise.all(bots.map(async (bot) => {
      try {
        await pollOnce(bot);
      } catch (error) {
        console.error(`[bot ${bot.id}] Polling failed: ${error.message}`);
        await sleep(3000);
      }
    }));
  }
}

async function runWebhookMode() {
  const webhookConfig = buildWebhookConfig();
  const server = await listenWebhookServer(webhookConfig);
  const address = server.address();
  const localPort = typeof address === "object" && address ? address.port : webhookConfig.port;
  console.log(`Webhook receiver listening on http://${webhookConfig.host}:${localPort}${webhookConfig.path}`);
  console.log(`Webhook receiver accepts per-bot paths like ${webhookConfig.path}/${bots[0].id}`);

  if (webhookConfig.noSetWebhook) {
    console.log("Webhook registration skipped because --no-set-webhook / ZAPRY_WEBHOOK_NO_SET is enabled.");
  } else {
    await Promise.all(bots.map((bot) => prepareWebhookMode(bot, webhookConfig)));
  }

  console.log(`Zapry webhook bot runner is running for ${bots.length} bot(s).`);
  console.log(`Bot IDs: ${bots.map((bot) => bot.id).join(", ")}`);
  console.log("Try sending /start, hello, /id, or /help to the bot.");

  await waitForServerClose(server);
}

function buildWebhookConfig() {
  const publicUrl = normalizeWebhookUrl(runtimeOptions.webhookUrl || process.env.ZAPRY_WEBHOOK_URL || "");
  const urlPath = publicUrl ? new URL(publicUrl).pathname : "";
  const pathValue = runtimeOptions.webhookPath || process.env.ZAPRY_WEBHOOK_PATH || urlPath || defaultWebhookPath;
  const port = Number(runtimeOptions.webhookPort || process.env.ZAPRY_WEBHOOK_PORT || 8080);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("ZAPRY_WEBHOOK_PORT must be an integer from 0 to 65535.");
  }

  const noSetWebhook = runtimeOptions.noSetWebhook || isTruthy(process.env.ZAPRY_WEBHOOK_NO_SET);
  if (!publicUrl && !noSetWebhook) {
    throw new Error("Missing ZAPRY_WEBHOOK_URL. Set it to your public HTTPS callback URL, or pass --no-set-webhook for local receiver-only testing.");
  }

  return {
    publicUrl,
    path: normalizeWebhookPath(pathValue),
    host: runtimeOptions.webhookHost || process.env.ZAPRY_WEBHOOK_HOST || "0.0.0.0",
    port,
    secretToken: runtimeOptions.webhookSecretToken || process.env.ZAPRY_WEBHOOK_SECRET_TOKEN || "",
    verifySecret: runtimeOptions.verifyWebhookSecret || isTruthy(process.env.ZAPRY_WEBHOOK_VERIFY_SECRET),
    noSetWebhook,
  };
}

function listenWebhookServer(webhookConfig) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      handleWebhookRequest(req, res, webhookConfig).catch((error) => {
        console.error(`Webhook request failed: ${error.message}`);
        if (!res.headersSent) {
          sendJson(res, 500, { ok: false, error: error.message });
        } else {
          res.end();
        }
      });
    });

    server.once("error", reject);
    server.listen(webhookConfig.port, webhookConfig.host, () => {
      server.off("error", reject);
      activeServer = server;
      resolve(server);
    });
  });
}

async function handleWebhookRequest(req, res, webhookConfig) {
  const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const eventId = nextEventId();
  const startedAt = Date.now();
  console.log(`[webhook ${eventId}] Incoming ${req.method} ${requestUrl.pathname} ua=${req.headers["user-agent"] || "(empty)"} len=${req.headers["content-length"] || "unknown"}`);

  if ((req.method === "GET" || req.method === "HEAD") && requestUrl.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(req.method === "HEAD" ? "" : "ok\n");
    console.log(`[webhook ${eventId}] Health OK duration_ms=${Date.now() - startedAt}`);
    return;
  }

  const pathMatch = matchWebhookPath(requestUrl.pathname, webhookConfig.path);
  if (!pathMatch) {
    sendJson(res, 404, { ok: false, error: "webhook path not found" });
    console.warn(`[webhook ${eventId}] Reject path not found path=${requestUrl.pathname} expected=${webhookConfig.path} duration_ms=${Date.now() - startedAt}`);
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, error: "webhook requires POST" });
    console.warn(`[webhook ${eventId}] Reject method=${req.method} duration_ms=${Date.now() - startedAt}`);
    return;
  }

  if (webhookConfig.verifySecret && !requestHasWebhookSecret(req, webhookConfig.secretToken)) {
    sendJson(res, 403, { ok: false, error: "webhook secret token mismatch" });
    console.warn(`[webhook ${eventId}] Reject secret mismatch bot_path=${pathMatch.botId || "(empty)"} duration_ms=${Date.now() - startedAt}`);
    return;
  }

  const rawBody = await readRequestBody(req, maxWebhookBodyBytes);
  if (logWebhookBody) {
    console.log(`[webhook ${eventId}] Body ${truncateForLog(rawBody, 4000)}`);
  }
  const body = parseJSONBody(rawBody);
  if (!body || typeof body !== "object") {
    sendJson(res, 400, { ok: false, error: "webhook JSON body required" });
    console.warn(`[webhook ${eventId}] Reject invalid JSON duration_ms=${Date.now() - startedAt}`);
    return;
  }

  const bot = resolveWebhookBot(pathMatch.botId || requestUrl.searchParams.get("bot_id") || "", body);
  if (!bot) {
    sendJson(res, 400, { ok: false, error: "cannot resolve bot for webhook request" });
    console.warn(`[webhook ${eventId}] Reject cannot resolve bot path_bot=${pathMatch.botId || "(empty)"} duration_ms=${Date.now() - startedAt}`);
    return;
  }

  const updates = extractWebhookUpdates(body);
  if (updates.length === 0) {
    console.warn(`[bot ${bot.id}] Webhook received but no update payload was found.`);
    sendJson(res, 400, { ok: false, error: "webhook update payload required" });
    console.warn(`[webhook ${eventId}] Reject no update payload bot=${bot.id} payload_keys=${Object.keys(body).join(",") || "(empty)"} duration_ms=${Date.now() - startedAt}`);
    return;
  }

  for (const update of updates) {
    const summary = describeUpdate(update);
    console.log(`[webhook ${eventId}] Dispatch bot=${bot.id} ${summary}`);
    await handleUpdate(bot, update, { source: "webhook", eventId }).catch((error) => {
      console.error(`[webhook ${eventId}] Handler failed bot=${bot.id} ${summary}: ${error.message}`);
      throw error;
    });
  }

  sendJson(res, 200, { ok: true });
  console.log(`[webhook ${eventId}] OK bot=${bot.id} updates=${updates.length} duration_ms=${Date.now() - startedAt}`);
}

function waitForServerClose(server) {
  return new Promise((resolve) => {
    server.once("close", resolve);
  });
}

function matchWebhookPath(pathname, basePath) {
  const requestPath = normalizeWebhookPath(pathname);
  const normalizedBase = normalizeWebhookPath(basePath);
  if (requestPath === normalizedBase) {
    return { botId: "" };
  }
  const prefix = `${normalizedBase}/`;
  if (!requestPath.startsWith(prefix)) {
    return null;
  }
  const botId = decodeURIComponent(requestPath.slice(prefix.length).split("/")[0] || "");
  return { botId };
}

function resolveWebhookBot(botId, body) {
  const explicitBotId = String(botId || inferWebhookBotId(body) || "").trim();
  if (explicitBotId) {
    return bots.find((bot) => bot.id === explicitBotId || tokenOwnerPrefix(bot.token) === explicitBotId) || null;
  }
  if (bots.length === 1) {
    return bots[0];
  }
  return null;
}

function inferWebhookBotId(body) {
  const payload = parseMaybeJSON(body.payload) || body.payload || body;
  return body.bot_id
    || body.botId
    || body.bot?.id
    || payload?.bot_id
    || payload?.botId
    || payload?.bot?.id
    || "";
}

function extractWebhookUpdates(body) {
  const payload = parseMaybeJSON(body.payload) || body.payload;
  const candidates = [
    payload?.update,
    payload,
    body.update,
    body,
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.filter(isWebhookUpdate);
    }
    if (Array.isArray(candidate?.updates)) {
      return candidate.updates.filter(isWebhookUpdate);
    }
    if (isWebhookUpdate(candidate)) {
      return [candidate];
    }
  }
  return [];
}

function isWebhookUpdate(value) {
  return Boolean(value && typeof value === "object" && (
    value.message
      || value.callback_query
      || value.callbackQuery
      || value.modal_submit
      || value.modalSubmit
  ));
}

function webhookUrlForBot(bot, webhookConfig) {
  const replaced = webhookConfig.publicUrl
    .replaceAll("{bot_id}", encodeURIComponent(bot.id))
    .replaceAll("{botId}", encodeURIComponent(bot.id))
    .replaceAll(":bot_id", encodeURIComponent(bot.id))
    .replaceAll(":botId", encodeURIComponent(bot.id));
  if (replaced !== webhookConfig.publicUrl || bots.length === 1) {
    return replaced;
  }

  const url = new URL(webhookConfig.publicUrl);
  url.pathname = appendPathSegment(url.pathname, bot.id);
  return url.toString();
}

function requestHasWebhookSecret(req, secretToken) {
  if (!secretToken) return true;
  const candidates = [
    req.headers["x-zapry-webhook-secret-token"],
    req.headers["x-zapry-webhook-secret"],
    req.headers["x-webhook-secret-token"],
    req.headers["x-webhook-secret"],
    req.headers["x-telegram-bot-api-secret-token"],
    bearerToken(req.headers.authorization),
  ].flatMap((value) => Array.isArray(value) ? value : [value]);

  return candidates.some((value) => String(value || "") === secretToken);
}

function bearerToken(value) {
  const text = String(value || "");
  const match = text.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : "";
}

function readRequestBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error("webhook request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(`${JSON.stringify(body)}\n`);
}

async function checkBot(bot) {
  const me = await apiGet(bot, "getMe");
  const webhook = await apiPost(bot, "getWebhookInfo");

  console.log(`[bot ${bot.id}] Bot check OK`);
  console.log(`Name: ${me.result?.name || "(unknown)"}`);
  console.log(`User ID: ${me.result?.user_id || "(unknown)"}`);
  console.log(`Webhook URL: ${webhook.result?.url || "(empty, getUpdates mode)"}`);
}

async function preparePollingMode(bot) {
  const webhook = await apiPost(bot, "getWebhookInfo");
  if (webhook.result?.url) {
    console.log(`[bot ${bot.id}] Webhook is set. Deleting it so local getUpdates polling can work...`);
    await apiPost(bot, "deleteWebhook");
  }
}

async function prepareWebhookMode(bot, webhookConfig) {
  const url = webhookUrlForBot(bot, webhookConfig);
  const body = { url };
  if (webhookConfig.secretToken) {
    body.secret_token = webhookConfig.secretToken;
  }

  console.log(`[bot ${bot.id}] setWebhook -> url=${url} secret=${webhookConfig.secretToken ? "configured" : "none"}`);
  await apiPost(bot, "setWebhook", body);
  console.log(`[bot ${bot.id}] Webhook was set: ${url}`);

  const webhook = await apiPost(bot, "getWebhookInfo").catch((error) => {
    console.warn(`[bot ${bot.id}] Failed to verify webhook info: ${error.message}`);
    return null;
  });
  if (webhook?.result) {
    console.log([
      `[bot ${bot.id}] Webhook info`,
      `url=${webhook.result.url || "(empty)"}`,
      `pending=${webhook.result.pending_update_count ?? "(unknown)"}`,
      `last_error=${webhook.result.last_error_message || "(none)"}`,
    ].join(" "));
  }
}

async function pollOnce(bot) {
  const updates = await apiPost(bot, "getUpdates", {
    offset: bot.offset,
    limit: pollLimit,
    timeout: pollTimeout,
  });

  const resultUpdates = updates.result || [];
  if (resultUpdates.length > 0) {
    console.log(`[bot ${bot.id}] Poll received updates=${resultUpdates.length} offset=${bot.offset}`);
  }

  for (const update of resultUpdates) {
    if (typeof update.update_id === "number") {
      bot.offset = update.update_id + 1;
      writeState(bot.stateFile, { offset: bot.offset });
    }

    const summary = describeUpdate(update);
    console.log(`[bot ${bot.id}] Poll dispatch ${summary}`);
    await handleUpdate(bot, update, { source: "polling" }).catch((error) => {
      console.error(`[bot ${bot.id}] Failed to handle update ${summary}: ${error.message}`);
    });
  }
}

async function handleUpdate(bot, update, context = {}) {
  const source = context.source || "unknown";
  const callbackQuery = update.callback_query || update.callbackQuery;
  if (callbackQuery) {
    console.log(`[bot ${bot.id}] Handle callback source=${source} callback_id=${callbackQuery.id || "(empty)"} data=${callbackData(callbackQuery) || "(empty)"}`);
    await handleCallback(bot, callbackQuery);
    return;
  }

  const modalSubmit = update.modal_submit || update.modalSubmit;
  if (modalSubmit) {
    console.log(`[bot ${bot.id}] Handle modal_submit source=${source} modal_id=${modalSubmit.modal_id || modalSubmit.modalId || "(unknown)"}`);
    await handleModalSubmit(bot, modalSubmit);
    return;
  }

  const message = update.message;
  if (!message?.chat?.id) {
    console.warn(`[bot ${bot.id}] Skip update source=${source}: message/chat.id missing summary=${describeUpdate(update)}`);
    return;
  }

  const text = (message.text || "").trim();
  if (!text) {
    console.warn(`[bot ${bot.id}] Skip message source=${source}: empty text chat=${message.chat.id} message_id=${message.message_id || "(unknown)"} type=${message.chat.type || "(unknown)"}`);
    return;
  }

  console.log(`[bot ${bot.id}] Received message source=${source} chat=${message.chat.id} chat_type=${message.chat.type || "(unknown)"} from=${message.from?.id || "(unknown)"} message_id=${message.message_id || "(unknown)"} text=${truncateForLog(text, 500)}`);

  if (text === "/start") {
    await sendMessage(bot, message.chat.id, [
      `你好，我是本地测试 bot ${bot.id}，后台服务已经跑起来了。`,
      "",
      "可以试试：",
      "/help - 查看命令",
      "/id - 查看当前 chat/user 信息",
      "hello - 测试普通消息回复",
      "/card - 发送 Agent Card 测试卡",
      "/choice - 发送 choice_group 测试卡",
      "/modal - 发送 Modal 测试卡",
    ].join("\n"));
    return;
  }

  if (text === "/help" || text === "help" || text === "你可以做什么") {
    await sendMessage(bot, message.chat.id, [
      `我现在是一个最小测试 bot（${bot.id}）：`,
      "",
      "/start - 启动问候",
      "/id - 返回当前 chat_id 和 user_id",
      "hello - 回复一条测试消息",
      "/card - 发送 Agent Card 测试卡，包含 toast / defer + editMessage / 服务端 Modal / 本地 Modal",
      "/choice - 发送 choice_group 测试卡，按钮点击时提交 component_values",
      "/modal - 发送 Modal 测试卡，覆盖 client-side modal 和 server-side modal",
      "",
      "注意：当前测试 bot 不发送真实 PaymentCard，避免误触发钱包签名。"
    ].join("\n"));
    return;
  }

  if (text === "/id") {
    await sendMessage(bot, message.chat.id, [
      `bot_id: ${bot.id}`,
      `chat_id: ${message.chat.id}`,
      `chat_type: ${message.chat.type || "(unknown)"}`,
      `user_id: ${message.from?.id || "(unknown)"}`,
      `user_name: ${message.from?.name || "(unknown)"}`,
      `message_id: ${message.message_id || "(unknown)"}`,
    ].join("\n"));
    return;
  }

  if (text.toLowerCase() === "hello" || text === "你好") {
    await sendMessage(bot, message.chat.id, `Hello，${message.from?.name || "there"}，bot ${bot.id} 收到消息了。`);
    return;
  }

  if (isAgentCardCommand(text)) {
    await sendAgentCard(bot, message.chat.id);
    return;
  }

  if (isChoiceCommand(text)) {
    await sendChoiceCard(bot, message.chat.id);
    return;
  }

  if (isModalCommand(text)) {
    await sendModalCard(bot, message.chat.id);
    return;
  }

  if (isPaymentCardCommand(text)) {
    await sendMessage(bot, message.chat.id, [
      "PaymentCard 是高风险支付组件，测试 bot 暂不直接下发真实 payment_card。",
      "请先用 /card、/choice、/modal 验证基础 Agent Card 链路；真实 PaymentCard 建议用测试钱包和专门业务 bot 跑。"
    ].join("\n"));
    return;
  }

  await sendMessage(bot, message.chat.id, `收到：${text}`);
}

async function handleCallback(bot, callbackQuery) {
  const data = callbackData(callbackQuery);
  console.log(`[bot ${bot.id}] Received callback: ${data || "(empty)"}`);

  if (!callbackQuery.id) return;

  if (data === "agent_card:toast") {
    await answerCallback(bot, callbackQuery, {
      response_type: "toast",
      text: "测试 bot 已收到按钮点击",
    });
    return;
  }

  if (data === "agent_card:defer_edit") {
    await answerCallback(bot, callbackQuery, {
      response_type: "defer",
    });
    await sleep(1200);
    await editCallbackSource(bot, callbackQuery, {
      fallback_text: "Agent Card 测试：已通过 editMessage 更新",
      components: [
        { type: "section", id: "agent_card_done_title", text: "Agent Card 已更新" },
        { type: "status", id: "agent_card_done_status", text: "状态：success" },
        { type: "notice", id: "agent_card_done_notice", text: "这条消息由 bot 调用 editMessage 原地更新，没有新增聊天消息。" },
        {
          type: "action_group",
          id: "agent_card_done_actions",
          components: [
            {
              type: "button",
              id: "agent_card_done_button",
              text: "已完成",
              style: "secondary",
              state: "disabled",
              disabled: true
            }
          ]
        }
      ]
    });
    return;
  }

  if (data === "agent_card:server_modal") {
    await answerCallback(bot, callbackQuery, {
      response_type: "open_modal",
      modal: {
        modal_id: "agent_card_server_modal",
        title: "服务端 Modal 测试",
        metadata: { source: "zapry-test-bot", callback_data: data },
        components: [
          {
            type: "text_input",
            id: "note",
            label: "备注",
            placeholder: "输入一段测试内容"
          },
          {
            type: "choice_group",
            id: "priority",
            title: "优先级",
            mode: "single",
            style: "radio",
            value: "normal",
            options: [
              { value: "low", label: "低" },
              { value: "normal", label: "普通" },
              { value: "high", label: "高" }
            ]
          }
        ]
      }
    });
    return;
  }

  if (data === "agent_card:submit_choice") {
    const values = componentValues(callbackQuery);
    const selected = humanReadableValues(values);
    await answerCallback(bot, callbackQuery, {
      response_type: "toast",
      text: `已收到选择：${selected || "空"}`,
    });
    await editCallbackSource(bot, callbackQuery, {
      fallback_text: `Agent Card choice_group：${selected || "未选择"}`,
      components: [
        { type: "section", id: "choice_done_title", text: "choice_group 已提交" },
        { type: "notice", id: "choice_done_notice", text: `收到的 component_values：${selected || "空"}` },
        {
          type: "action_group",
          id: "choice_done_actions",
          components: [
            {
              type: "button",
              id: "choice_done_button",
              text: "重新发送选择卡",
              style: "primary",
              action: { type: "callback", value: "agent_card:resend_choice" },
              callback_data: "agent_card:resend_choice"
            }
          ]
        }
      ]
    });
    return;
  }

  if (data === "agent_card:resend_choice") {
    await answerCallback(bot, callbackQuery, {
      response_type: "toast",
      text: "正在重新发送选择卡",
    });
    const chatId = callbackChatId(callbackQuery);
    if (chatId) {
      await sendChoiceCard(bot, chatId);
    }
    return;
  }

  await answerCallback(bot, callbackQuery, {
    response_type: "toast",
    text: "测试 bot 已收到按钮点击",
  });
}

async function handleModalSubmit(bot, modalSubmit) {
  const modalId = modalSubmit.modal_id || modalSubmit.modalId || "(unknown)";
  const values = parseMaybeJSON(modalSubmit.values) || modalSubmit.values || {};
  console.log(`[bot ${bot.id}] Received modal_submit: ${modalId} values=${JSON.stringify(values)}`);

  const chatId = modalSubmit.source_message?.chat?.id
    || modalSubmit.sourceMessage?.chat?.id
    || modalSubmit.chat?.id
    || modalSubmit.chat_id
    || modalSubmit.chatId;

  if (chatId) {
    await sendMessage(bot, chatId, [
      `收到 Modal 提交：${modalId}`,
      `values: ${humanReadableValues(values) || "空"}`
    ].join("\n"));
  }
}

async function sendMessage(bot, chatId, text) {
  console.log(`[bot ${bot.id}] sendMessage -> chat=${chatId} text_len=${String(text || "").length}`);
  const result = await apiPost(bot, "sendMessage", {
    chat_id: String(chatId),
    text,
  });
  console.log(`[bot ${bot.id}] sendMessage OK chat=${chatId} message_id=${result?.result?.message_id || result?.result?.messageId || "(unknown)"}`);
  return result;
}

async function sendComponentMessage(bot, chatId, { text, fallback_text, components }) {
  console.log(`[bot ${bot.id}] sendComponentMessage -> chat=${chatId} text_len=${String(text || "").length} components=${Array.isArray(components) ? components.length : 0}`);
  const result = await apiPost(bot, "sendMessage", {
    chat_id: String(chatId),
    text,
    fallback_text,
    components,
  });
  console.log(`[bot ${bot.id}] sendComponentMessage OK chat=${chatId} message_id=${result?.result?.message_id || result?.result?.messageId || "(unknown)"}`);
  return result;
}

async function sendAgentCard(bot, chatId) {
  await sendComponentMessage(bot, chatId, {
    text: "Agent Card 测试",
    fallback_text: "Agent Card 测试：按钮、Modal、editMessage",
    components: [
      { type: "section", id: "agent_card_title", text: "Agent Card 测试" },
      { type: "notice", id: "agent_card_notice", text: "这张卡用于验证 sendMessage.components、callback_query、answerCallbackQuery 和 editMessage。" },
      {
        type: "action_group",
        id: "agent_card_actions",
        components: [
          callbackButton("agent_card_toast", "Toast", "agent_card:toast", "secondary"),
          callbackButton("agent_card_defer", "Defer + edit", "agent_card:defer_edit", "primary"),
          callbackButton("agent_card_server_modal", "服务端 Modal", "agent_card:server_modal", "secondary")
        ]
      },
      {
        type: "action_group",
        id: "agent_card_more_actions",
        components: [
          {
            type: "button",
            id: "agent_card_client_modal",
            text: "本地 Modal",
            style: "secondary",
            action: {
              type: "open_modal",
              modal: clientSideModalPayload()
            }
          },
          {
            type: "button",
            id: "agent_card_docs",
            text: "打开文档",
            style: "secondary",
            action: {
              type: "open_url",
              value: "https://zapry.ai/developers/docs/api-reference"
            }
          }
        ]
      }
    ]
  });
}

async function sendChoiceCard(bot, chatId) {
  await sendComponentMessage(bot, chatId, {
    text: "Agent Card choice_group 测试",
    fallback_text: "Agent Card choice_group 测试",
    components: [
      { type: "section", id: "choice_title", text: "选择一个测试场景" },
      {
        type: "choice_group",
        id: "agent_card_case",
        title: "场景",
        mode: "single",
        style: "radio",
        value: "render",
        options: [
          { value: "render", label: "渲染", description: "验证 section/notice/button" },
          { value: "modal", label: "Modal", description: "验证表单弹出和提交" },
          { value: "edit", label: "状态更新", description: "验证 editMessage 原地更新" }
        ]
      },
      {
        type: "choice_group",
        id: "agent_card_platforms",
        title: "平台",
        mode: "multiple",
        style: "checkbox",
        value: ["ios"],
        options: [
          { value: "ios", label: "iOS" },
          { value: "android", label: "Android" },
          { value: "server", label: "Server" }
        ]
      },
      {
        type: "action_group",
        id: "choice_actions",
        components: [
          {
            ...callbackButton("choice_submit", "提交选择", "agent_card:submit_choice", "primary"),
            include_values: ["agent_card_case", "agent_card_platforms"]
          }
        ]
      }
    ]
  });
}

async function sendModalCard(bot, chatId) {
  await sendComponentMessage(bot, chatId, {
    text: "Agent Card Modal 测试",
    fallback_text: "Agent Card Modal 测试",
    components: [
      { type: "section", id: "modal_title", text: "Modal 测试" },
      { type: "notice", id: "modal_notice", text: "本地 Modal 不产生 callback；服务端 Modal 通过 answerCallbackQuery.open_modal 下发。" },
      {
        type: "action_group",
        id: "modal_actions",
        components: [
          {
            type: "button",
            id: "client_modal",
            text: "本地 Modal",
            style: "primary",
            action: {
              type: "open_modal",
              modal: clientSideModalPayload()
            }
          },
          callbackButton("server_modal", "服务端 Modal", "agent_card:server_modal", "secondary")
        ]
      }
    ]
  });
}

function callbackButton(id, text, value, style = "secondary") {
  return {
    type: "button",
    id,
    text,
    style,
    action: { type: "callback", value },
    callback_data: value,
  };
}

function clientSideModalPayload() {
  return {
    modal_id: "agent_card_client_modal",
    title: "本地 Modal 测试",
    description: "这个 Modal 由客户端直接打开，不先发送 callback_query。",
    submit_text: "提交",
    components: [
      {
        type: "text_input",
        id: "comment",
        label: "备注",
        placeholder: "输入任意测试内容"
      },
      {
        type: "choice_group",
        id: "channel",
        title: "提交来源",
        mode: "single",
        style: "radio",
        value: "client_modal",
        options: [
          { value: "client_modal", label: "本地 Modal" },
          { value: "manual", label: "手动测试" }
        ]
      }
    ],
    metadata: { source: "zapry-test-bot" }
  };
}

async function answerCallback(bot, callbackQuery, body) {
  const chatId = callbackChatId(callbackQuery);
  console.log(`[bot ${bot.id}] answerCallbackQuery -> callback_id=${callbackQuery.id || "(empty)"} chat=${chatId || "(empty)"} response_type=${body.response_type || "(empty)"}`);
  const result = await apiPost(bot, "answerCallbackQuery", {
    chat_id: chatId ? String(chatId) : "",
    callback_query_id: callbackQuery.id,
    ...body,
  });
  console.log(`[bot ${bot.id}] answerCallbackQuery OK callback_id=${callbackQuery.id || "(empty)"}`);
  return result;
}

async function editCallbackSource(bot, callbackQuery, body) {
  const chatId = callbackChatId(callbackQuery);
  const messageId = callbackMessageId(callbackQuery);
  if (!chatId || !messageId) {
    await answerCallback(bot, callbackQuery, {
      response_type: "alert",
      text: "缺少 source message，无法 editMessage",
    }).catch(() => {});
    console.warn(`[bot ${bot.id}] Missing source message for editMessage: chat=${chatId || "(empty)"} message=${messageId || "(empty)"}`);
    return;
  }

  console.log(`[bot ${bot.id}] editMessage -> chat=${chatId} message=${messageId}`);
  const result = await apiPost(bot, "editMessage", {
    chat_id: String(chatId),
    message_id: String(messageId),
    ...body,
  });
  console.log(`[bot ${bot.id}] editMessage OK chat=${chatId} message=${messageId}`);
  return result;
}

function isAgentCardCommand(text) {
  const normalized = text.toLowerCase();
  return normalized === "/card"
    || normalized === "card"
    || normalized === "agent card"
    || text === "测试卡片"
    || text === "测试Agent Card"
    || text === "测试agent card";
}

function isChoiceCommand(text) {
  const normalized = text.toLowerCase();
  return normalized === "/choice"
    || normalized === "choice"
    || text === "测试选择"
    || text === "测试choice";
}

function isModalCommand(text) {
  const normalized = text.toLowerCase();
  return normalized === "/modal"
    || normalized === "modal"
    || text === "测试modal"
    || text === "测试Modal";
}

function isPaymentCardCommand(text) {
  const normalized = text.toLowerCase();
  return normalized === "/payment"
    || normalized === "/paymentcard"
    || normalized === "paymentcard"
    || normalized === "payment card"
    || text === "测试支付卡";
}

function callbackData(callbackQuery) {
  return callbackQuery.data
    || callbackQuery.value
    || callbackQuery.callback_data
    || callbackQuery.callbackData
    || "";
}

function callbackChatId(callbackQuery) {
  return callbackQuery.message?.chat?.id
    || callbackQuery.source_message?.chat?.id
    || callbackQuery.sourceMessage?.chat?.id
    || callbackQuery.chat?.id
    || callbackQuery.chat_id
    || callbackQuery.chatId
    || "";
}

function callbackMessageId(callbackQuery) {
  return callbackQuery.message?.message_id
    || callbackQuery.message?.messageId
    || callbackQuery.source_message?.message_id
    || callbackQuery.sourceMessage?.messageId
    || callbackQuery.message_id
    || callbackQuery.messageId
    || "";
}

function componentValues(callbackQuery) {
  return parseMaybeJSON(callbackQuery.component_values)
    || parseMaybeJSON(callbackQuery.componentValues)
    || callbackQuery.component_values
    || callbackQuery.componentValues
    || {};
}

function parseMaybeJSON(value) {
  if (!value || typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseJSONBody(value) {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return null;
  }
}

function nextEventId() {
  eventCounter += 1;
  return `${Date.now().toString(36)}-${eventCounter}`;
}

function describeUpdate(update) {
  if (!update || typeof update !== "object") {
    return "type=unknown";
  }

  const callbackQuery = update.callback_query || update.callbackQuery;
  if (callbackQuery) {
    return [
      "type=callback_query",
      `update_id=${update.update_id ?? "(none)"}`,
      `callback_id=${callbackQuery.id || "(empty)"}`,
      `data=${truncateForLog(callbackData(callbackQuery) || "(empty)", 120)}`,
      `chat=${callbackChatId(callbackQuery) || "(empty)"}`,
      `message=${callbackMessageId(callbackQuery) || "(empty)"}`,
    ].join(" ");
  }

  const modalSubmit = update.modal_submit || update.modalSubmit;
  if (modalSubmit) {
    const chatId = modalSubmit.source_message?.chat?.id
      || modalSubmit.sourceMessage?.chat?.id
      || modalSubmit.chat?.id
      || modalSubmit.chat_id
      || modalSubmit.chatId
      || "";
    return [
      "type=modal_submit",
      `update_id=${update.update_id ?? "(none)"}`,
      `modal_id=${modalSubmit.modal_id || modalSubmit.modalId || "(unknown)"}`,
      `chat=${chatId || "(empty)"}`,
    ].join(" ");
  }

  const message = update.message;
  if (message) {
    return [
      "type=message",
      `update_id=${update.update_id ?? "(none)"}`,
      `chat=${message.chat?.id || "(empty)"}`,
      `chat_type=${message.chat?.type || "(unknown)"}`,
      `from=${message.from?.id || "(unknown)"}`,
      `message=${message.message_id || message.messageId || "(unknown)"}`,
      `text=${truncateForLog((message.text || "").trim() || "(empty)", 120)}`,
    ].join(" ");
  }

  return `type=unsupported update_id=${update.update_id ?? "(none)"} keys=${Object.keys(update).join(",") || "(empty)"}`;
}

function truncateForLog(value, maxLength) {
  const text = String(value ?? "");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...(${text.length} chars)`;
}

function humanReadableValues(values) {
  if (!values || typeof values !== "object") return "";
  return Object.entries(values)
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join("|") : String(value)}`)
    .join(", ");
}

async function apiGet(bot, method) {
  const response = await fetchAPI(bot, method);
  return parseResponse(method, response);
}

async function apiPost(bot, method, body = {}) {
  if (method === "setWebhook" || method === "deleteWebhook" || method === "getWebhookInfo") {
    console.log(`[bot ${bot.id}] API ${method} -> ${baseUrl}/${redactToken(bot.token)}/${method}`);
  }
  const response = await fetchAPI(bot, method, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  return parseResponse(method, response);
}

async function fetchAPI(bot, method, options) {
  try {
    return await fetch(`${baseUrl}/${bot.token}/${method}`, options);
  } catch (error) {
    throw new Error(`${method} request failed for ${baseUrl}: ${networkErrorMessage(error)}`);
  }
}

function networkErrorMessage(error) {
  return error?.cause?.message || error?.message || "Unknown network error";
}

async function parseResponse(method, response) {
  const text = await response.text();
  const payload = parseJSONBody(text);

  if (!response.ok || !payload?.ok) {
    const description = payload?.description || payload?.error || response.statusText || "Unknown error";
    throw new Error(`${method} failed: status=${response.status} description=${description} body=${truncateForLog(text, 1000)}`);
  }

  return payload;
}

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;

  const content = fs.readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    const value = stripInlineComment(trimmed.slice(separator + 1).trim()).replace(/^["']|["']$/g, "");
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

function stripInlineComment(value) {
  if (value.startsWith("\"") || value.startsWith("'")) return value;

  const hashCommentStart = value.search(/\s#/);
  const slashCommentStart = value.search(/\s\/\//);
  const commentStarts = [hashCommentStart, slashCommentStart].filter((index) => index !== -1);
  const commentStart = commentStarts.length > 0 ? Math.min(...commentStarts) : -1;

  return commentStart === -1 ? value : value.slice(0, commentStart).trim();
}

function parseRuntimeOptions(args) {
  const options = {
    mode: "",
    envName: "",
    webhookUrl: "",
    webhookHost: "",
    webhookPort: "",
    webhookPath: "",
    webhookSecretToken: "",
    verifyWebhookSecret: false,
    noSetWebhook: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--mode") {
      options.mode = args[index + 1] || "";
      index += 1;
      continue;
    }
    if (arg.startsWith("--mode=")) {
      options.mode = arg.slice("--mode=".length);
      continue;
    }
    if (arg === "--env" || arg === "-e") {
      options.envName = args[index + 1] || "";
      index += 1;
      continue;
    }
    if (arg.startsWith("--env=")) {
      options.envName = arg.slice("--env=".length);
      continue;
    }
    if (arg === "--webhook-url") {
      options.webhookUrl = args[index + 1] || "";
      index += 1;
      continue;
    }
    if (arg.startsWith("--webhook-url=")) {
      options.webhookUrl = arg.slice("--webhook-url=".length);
      continue;
    }
    if (arg === "--webhook-host") {
      options.webhookHost = args[index + 1] || "";
      index += 1;
      continue;
    }
    if (arg.startsWith("--webhook-host=")) {
      options.webhookHost = arg.slice("--webhook-host=".length);
      continue;
    }
    if (arg === "--webhook-port") {
      options.webhookPort = args[index + 1] || "";
      index += 1;
      continue;
    }
    if (arg.startsWith("--webhook-port=")) {
      options.webhookPort = arg.slice("--webhook-port=".length);
      continue;
    }
    if (arg === "--webhook-path") {
      options.webhookPath = args[index + 1] || "";
      index += 1;
      continue;
    }
    if (arg.startsWith("--webhook-path=")) {
      options.webhookPath = arg.slice("--webhook-path=".length);
      continue;
    }
    if (arg === "--webhook-secret-token") {
      options.webhookSecretToken = args[index + 1] || "";
      index += 1;
      continue;
    }
    if (arg.startsWith("--webhook-secret-token=")) {
      options.webhookSecretToken = arg.slice("--webhook-secret-token=".length);
      continue;
    }
    if (arg === "--verify-webhook-secret") {
      options.verifyWebhookSecret = true;
      continue;
    }
    if (arg === "--no-set-webhook") {
      options.noSetWebhook = true;
      continue;
    }
    if (!options.mode) {
      options.mode = arg;
    }
  }

  return options;
}

function normalizeRunMode(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized || normalized === "start" || normalized === "--start" || normalized === "poll" || normalized === "polling" || normalized === "--polling") {
    return "polling";
  }
  if (normalized === "--check" || normalized === "check") {
    return "check";
  }
  if (normalized === "--once" || normalized === "once") {
    return "once";
  }
  if (normalized === "--webhook" || normalized === "webhook") {
    return "webhook";
  }
  return normalized;
}

function normalizeEnvName(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized || normalized === "production") return "";
  return normalized.replace(/[^a-z0-9_-]/g, "");
}

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function normalizeWebhookUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    const url = new URL(text);
    url.pathname = normalizeWebhookPath(url.pathname);
    return url.toString().replace(/\/$/, "");
  } catch {
    throw new Error(`Invalid ZAPRY_WEBHOOK_URL: ${text}`);
  }
}

function normalizeWebhookPath(value) {
  const text = String(value || defaultWebhookPath).trim();
  const pathname = text.startsWith("http://") || text.startsWith("https://")
    ? new URL(text).pathname
    : text;
  const withLeadingSlash = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return withLeadingSlash.replace(/\/+$/, "") || "/";
}

function appendPathSegment(pathname, segment) {
  const basePath = normalizeWebhookPath(pathname);
  const encoded = encodeURIComponent(segment);
  return basePath === "/" ? `/${encoded}` : `${basePath}/${encoded}`;
}

function isTruthy(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function tokenOwnerPrefix(token) {
  return String(token || "").split(":")[0] || "";
}

function redactToken(token) {
  const text = String(token || "");
  const [prefix, secret = ""] = text.split(":");
  if (!secret) return prefix ? `${prefix}:***` : "***";
  return `${prefix}:${secret.slice(0, 4)}...${secret.slice(-4)}`;
}

function parseBotTokens() {
  const rawTokens = process.env.ZAPRY_BOT_TOKENS || process.env.ZAPRY_BOT_TOKEN || "";
  const tokens = rawTokens
    .split(",")
    .map((tokenValue) => tokenValue.trim())
    .filter(Boolean);
  const idCounts = new Map();

  return tokens.map((botToken) => {
    const baseId = sanitizeBotId(botToken.split(":")[0] || botToken);
    const nextCount = (idCounts.get(baseId) || 0) + 1;
    idCounts.set(baseId, nextCount);

    const id = nextCount === 1 ? baseId : `${baseId}_${nextCount}`;
    const stateEnvPrefix = activeEnvName ? `${activeEnvName}-` : "";
    const stateFile = path.join(rootDir, `bot-state-${stateEnvPrefix}${id}.json`);

    return {
      id,
      token: botToken,
      stateFile,
      offset: readState(stateFile).offset || 0,
    };
  });
}

function sanitizeBotId(value) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_") || "unknown";
}

function readState(stateFile) {
  if (!fs.existsSync(stateFile)) return {};

  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return {};
  }
}

function writeState(stateFile, state) {
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
