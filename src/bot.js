import fs from "node:fs";
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

if (bots.length === 0) {
  console.error("Missing bot token. Put ZAPRY_BOT_TOKENS or ZAPRY_BOT_TOKEN in .env or the active .env.<env> file.");
  process.exit(1);
}

let stopping = false;

process.on("SIGINT", () => {
  stopping = true;
  console.log("\nStopping after current request...");
});

process.on("SIGTERM", () => {
  stopping = true;
  console.log("\nStopping after current request...");
});

async function main() {
  const mode = runtimeOptions.mode || "start";
  console.log(`Zapry API: ${baseUrl}${activeEnvName ? ` (${activeEnvName})` : ""}`);

  if (mode === "--check") {
    for (const bot of bots) {
      await checkBot(bot);
    }
    return;
  }

  await Promise.all(bots.map((bot) => preparePollingMode(bot)));

  if (mode === "--once") {
    await Promise.all(bots.map((bot) => pollOnce(bot)));
    return;
  }

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

async function pollOnce(bot) {
  const updates = await apiPost(bot, "getUpdates", {
    offset: bot.offset,
    limit: pollLimit,
    timeout: pollTimeout,
  });

  for (const update of updates.result || []) {
    if (typeof update.update_id === "number") {
      bot.offset = update.update_id + 1;
      writeState(bot.stateFile, { offset: bot.offset });
    }

    await handleUpdate(bot, update).catch((error) => {
      console.error(`[bot ${bot.id}] Failed to handle update: ${error.message}`);
    });
  }
}

async function handleUpdate(bot, update) {
  if (update.callback_query) {
    await handleCallback(bot, update.callback_query);
    return;
  }

  if (update.modal_submit) {
    await handleModalSubmit(bot, update.modal_submit);
    return;
  }

  const message = update.message;
  if (!message?.chat?.id) return;

  const text = (message.text || "").trim();
  if (!text) return;

  console.log(`[bot ${bot.id}] Received from chat ${message.chat.id}: ${text}`);

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
  await apiPost(bot, "sendMessage", {
    chat_id: String(chatId),
    text,
  });
}

async function sendComponentMessage(bot, chatId, { text, fallback_text, components }) {
  await apiPost(bot, "sendMessage", {
    chat_id: String(chatId),
    text,
    fallback_text,
    components,
  });
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
  await apiPost(bot, "answerCallbackQuery", {
    chat_id: chatId ? String(chatId) : "",
    callback_query_id: callbackQuery.id,
    ...body,
  });
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

  await apiPost(bot, "editMessage", {
    chat_id: String(chatId),
    message_id: String(messageId),
    ...body,
  });
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
  const payload = await response.json().catch(() => null);

  if (!response.ok || !payload?.ok) {
    const description = payload?.description || response.statusText || "Unknown error";
    throw new Error(`${method} failed: ${description}`);
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
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--env" || arg === "-e") {
      options.envName = args[index + 1] || "";
      index += 1;
      continue;
    }
    if (arg.startsWith("--env=")) {
      options.envName = arg.slice("--env=".length);
      continue;
    }
    if (!options.mode) {
      options.mode = arg;
    }
  }

  return options;
}

function normalizeEnvName(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized || normalized === "production") return "";
  return normalized.replace(/[^a-z0-9_-]/g, "");
}

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
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
