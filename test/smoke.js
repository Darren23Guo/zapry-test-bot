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
const allBots = parseBotTokens();
const groupChatId = runtimeOptions.groupChatId || process.env.ZAPRY_SMOKE_GROUP_CHAT_ID || "";
const privateChatIdOverride = runtimeOptions.privateChatId || process.env.ZAPRY_SMOKE_PRIVATE_CHAT_ID || "";
const noSend = runtimeOptions.noSend || isTruthy(process.env.ZAPRY_SMOKE_NO_SEND);

if (allBots.length === 0) {
  console.error("Missing bot token. Put ZAPRY_BOT_TOKENS or ZAPRY_BOT_TOKEN in .env or the active .env.<env> file.");
  process.exit(1);
}

const bots = selectBots(allBots, runtimeOptions);

async function main() {
  console.log(`Zapry smoke API: ${baseUrl}${activeEnvName ? ` (${activeEnvName})` : ""}`);
  console.log(`Selected bot(s): ${bots.map((bot) => bot.id).join(", ")}`);
  if (noSend) {
    console.log("No-send mode: only getMe/getWebhookInfo will run.");
  }

  const results = [];
  for (const bot of bots) {
    results.push(await runSmokeForBot(bot));
  }

  const failures = results.filter((result) => !result.ok);
  console.log("");
  console.log(`Smoke summary: ${results.length - failures.length}/${results.length} bot(s) passed.`);
  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

async function runSmokeForBot(bot) {
  const steps = [];
  console.log("");
  console.log(`[bot ${bot.id}] Starting smoke`);

  const me = await runStep(steps, "getMe", () => apiGet(bot, "getMe"));
  await runStep(steps, "getWebhookInfo", () => apiPost(bot, "getWebhookInfo"));

  if (!noSend) {
    const privateChatId = privateChatIdOverride || tokenOwnerPrefix(bot.token);
    if (privateChatId) {
      await runStep(steps, `sendMessage private (${privateChatId})`, () => sendSmokeText(bot, privateChatId, me.payload));
      await runStep(steps, `sendLinkCard private (${privateChatId})`, () => sendSmokeLinkCard(bot, privateChatId, "Private link card smoke"));
    } else {
      steps.push({ name: "send private messages", ok: true, skipped: true });
      console.log(`[bot ${bot.id}] SKIP send private messages: cannot infer private chat id from token.`);
    }

    if (groupChatId) {
      await runStep(steps, `sendLinkCard group (${normalizeGroupChatId(groupChatId)})`, () => {
        return sendSmokeLinkCard(bot, normalizeGroupChatId(groupChatId), "Group link card smoke");
      });
    } else {
      steps.push({ name: "sendLinkCard group", ok: true, skipped: true });
      console.log(`[bot ${bot.id}] SKIP sendLinkCard group: set ZAPRY_SMOKE_GROUP_CHAT_ID=g_<group_id> to enable it.`);
    }
  }

  const failed = steps.filter((step) => !step.ok);
  if (failed.length === 0) {
    console.log(`[bot ${bot.id}] Smoke OK`);
    return { bot, ok: true, steps };
  }

  console.log(`[bot ${bot.id}] Smoke FAILED: ${failed.map((step) => step.name).join(", ")}`);
  return { bot, ok: false, steps };
}

async function runStep(steps, name, fn) {
  try {
    const payload = await fn();
    steps.push({ name, ok: true, payload });
    console.log(`  OK   ${name}${resultSuffix(payload)}`);
    return { ok: true, payload };
  } catch (error) {
    steps.push({ name, ok: false, error });
    console.log(`  FAIL ${name}: ${error.message}`);
    return { ok: false, error };
  }
}

function resultSuffix(payload) {
  const messageId = payload?.result?.message_id || payload?.result?.messageId;
  if (messageId) return ` message_id=${messageId}`;
  const userId = payload?.result?.user_id || payload?.result?.userId;
  const name = payload?.result?.name || payload?.result?.username;
  if (userId || name) return ` user_id=${userId || "(unknown)"} name=${name || "(unknown)"}`;
  const webhookUrl = payload?.result?.url;
  if (webhookUrl !== undefined) return ` webhook=${webhookUrl || "(empty)"}`;
  return "";
}

async function sendSmokeText(bot, chatId, mePayload) {
  const botName = mePayload?.result?.name || bot.id;
  return apiPost(bot, "sendMessage", {
    chat_id: String(chatId),
    text: `[smoke] ${botName} text message via ${baseUrl}`,
  });
}

async function sendSmokeLinkCard(bot, chatId, content) {
  return apiPost(bot, "sendLinkCard", {
    chat_id: String(chatId),
    url: "https://zapry.ai/developers",
    title: "Zapry Developers",
    content,
    icon_url: "https://zapry.ai/favicon.ico",
    image_url: "https://zapry.ai/og.png",
    source: "zapry-test-bot",
  });
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

async function parseResponse(method, response) {
  const text = await response.text();
  const payload = parseJSON(text);

  if (!response.ok || !payload?.ok) {
    const description = payload?.description || response.statusText || text || "Unknown error";
    throw new Error(`${method} failed: ${description}`);
  }

  return payload;
}

function parseRuntimeOptions(args) {
  const options = {
    all: false,
    botToken: "",
    botId: "",
    envName: "",
    groupChatId: "",
    privateChatId: "",
    noSend: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--all") {
      options.all = true;
      continue;
    }
    if (arg === "--no-send") {
      options.noSend = true;
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
    if (arg === "--bot-token") {
      options.botToken = args[index + 1] || "";
      index += 1;
      continue;
    }
    if (arg.startsWith("--bot-token=")) {
      options.botToken = arg.slice("--bot-token=".length);
      continue;
    }
    if (arg === "--bot-id") {
      options.botId = args[index + 1] || "";
      index += 1;
      continue;
    }
    if (arg.startsWith("--bot-id=")) {
      options.botId = arg.slice("--bot-id=".length);
      continue;
    }
    if (arg === "--group-chat-id") {
      options.groupChatId = args[index + 1] || "";
      index += 1;
      continue;
    }
    if (arg.startsWith("--group-chat-id=")) {
      options.groupChatId = arg.slice("--group-chat-id=".length);
      continue;
    }
    if (arg === "--private-chat-id") {
      options.privateChatId = args[index + 1] || "";
      index += 1;
      continue;
    }
    if (arg.startsWith("--private-chat-id=")) {
      options.privateChatId = arg.slice("--private-chat-id=".length);
    }
  }

  return options;
}

function selectBots(bots, options) {
  const botToken = options.botToken || process.env.ZAPRY_SMOKE_BOT_TOKEN || "";
  const botId = options.botId || process.env.ZAPRY_SMOKE_BOT_ID || "";

  if (botToken) {
    const selected = bots.find((bot) => bot.token === botToken);
    if (!selected) {
      throw new Error("ZAPRY_SMOKE_BOT_TOKEN does not match any configured bot token.");
    }
    return [selected];
  }

  if (botId) {
    const selected = bots.find((bot) => bot.id === botId);
    if (!selected) {
      throw new Error("ZAPRY_SMOKE_BOT_ID does not match any configured bot id.");
    }
    return [selected];
  }

  if (options.all || isTruthy(process.env.ZAPRY_SMOKE_ALL)) {
    return bots;
  }

  return [bots[0]];
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
    const baseId = sanitizeBotId(tokenOwnerPrefix(botToken) || botToken);
    const nextCount = (idCounts.get(baseId) || 0) + 1;
    idCounts.set(baseId, nextCount);
    const id = nextCount === 1 ? baseId : `${baseId}_${nextCount}`;

    return { id, token: botToken };
  });
}

function tokenOwnerPrefix(token) {
  return String(token || "").split(":")[0]?.trim() || "";
}

function sanitizeBotId(value) {
  return String(value || "").replace(/[^a-zA-Z0-9_-]/g, "_") || "unknown";
}

function normalizeEnvName(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized || normalized === "production") return "";
  return normalized.replace(/[^a-z0-9_-]/g, "");
}

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function normalizeGroupChatId(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  return trimmed.startsWith("g_") ? trimmed : `g_${trimmed}`;
}

function networkErrorMessage(error) {
  return error?.cause?.message || error?.message || "Unknown network error";
}

function parseJSON(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isTruthy(value) {
  return ["1", "true", "yes", "y", "on"].includes(String(value || "").trim().toLowerCase());
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
