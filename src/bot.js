import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

loadDotEnv(path.join(rootDir, ".env"));

const baseUrl = process.env.ZAPRY_API_BASE_URL || "https://openapi.mimo.immo";
const pollTimeout = Number(process.env.ZAPRY_POLL_TIMEOUT || 30);
const pollLimit = Number(process.env.ZAPRY_POLL_LIMIT || 10);
const bots = parseBotTokens();

if (bots.length === 0) {
  console.error("Missing bot token. Put ZAPRY_BOT_TOKENS or ZAPRY_BOT_TOKEN in .env.");
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
  const mode = process.argv[2] || "start";

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
      "",
      "后面可以在这里接你的业务逻辑，比如审批、查询、发卡片、调用 AI。"
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

  await sendMessage(bot, message.chat.id, `收到：${text}`);
}

async function handleCallback(bot, callbackQuery) {
  console.log(`[bot ${bot.id}] Received callback: ${callbackQuery.data || callbackQuery.value || "(empty)"}`);

  if (!callbackQuery.id) return;

  await apiPost(bot, "answerCallbackQuery", {
    callback_query_id: callbackQuery.id,
    response_type: "toast",
    text: "测试 bot 已收到按钮点击",
  });
}

async function sendMessage(bot, chatId, text) {
  await apiPost(bot, "sendMessage", {
    chat_id: String(chatId),
    text,
  });
}

async function apiGet(bot, method) {
  const response = await fetch(`${baseUrl}/${bot.token}/${method}`);
  return parseResponse(method, response);
}

async function apiPost(bot, method, body = {}) {
  const response = await fetch(`${baseUrl}/${bot.token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  return parseResponse(method, response);
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
    const stateFile = path.join(rootDir, `bot-state-${id}.json`);

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
