import { createHmac, timingSafeEqual } from "node:crypto";

const BOT_API = "https://api.telegram.org";

export function verifyTelegramInitData(initData, botToken, now = Date.now()) {
  if (typeof initData !== "string" || initData.length > 16_384 || !botToken) return null;

  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");
  const authDate = Number(params.get("auth_date"));
  const userRaw = params.get("user");
  if (!receivedHash || !/^[a-f0-9]{64}$/i.test(receivedHash) || !Number.isInteger(authDate) || !userRaw) return null;
  if (authDate > Math.floor(now / 1000) + 60 || Math.floor(now / 1000) - authDate > 86_400) return null;

  params.delete("hash");
  const checkString = [...params.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expectedHash = createHmac("sha256", secret).update(checkString).digest();
  const actualHash = Buffer.from(receivedHash, "hex");
  if (actualHash.length !== expectedHash.length || !timingSafeEqual(actualHash, expectedHash)) return null;

  try {
    const user = JSON.parse(userRaw);
    if (!Number.isSafeInteger(user.id) || user.id <= 0 || typeof user.first_name !== "string") return null;
    return {
      id: String(user.id),
      firstName: user.first_name,
      lastName: typeof user.last_name === "string" ? user.last_name : "",
      username: typeof user.username === "string" ? user.username : "",
    };
  } catch {
    return null;
  }
}

export async function telegramRequest(token, method, body = {}, signal) {
  const response = await fetch(`${BOT_API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) {
    throw new Error(`Telegram ${method} failed: ${result.description ?? response.status}`);
  }
  return result.result;
}

export async function sendTelegramMessage(token, chatId, text) {
  return telegramRequest(token, "sendMessage", { chat_id: chatId, text });
}

export function startTelegramBot(config, storage) {
  if (!config.telegramBotToken || !config.telegramBotUsername || !config.publicAppUrl) return { stop() {} };

  const controller = new AbortController();
  const appUrl = config.publicAppUrl;
  const token = config.telegramBotToken;
  let offset = 0;

  const run = async () => {
    try {
      const bot = await telegramRequest(token, "getMe");
      if (bot.username.toLowerCase() !== config.telegramBotUsername.toLowerCase()) {
        throw new Error("TELEGRAM_BOT_USERNAME does not match the configured bot token");
      }
      await telegramRequest(token, "deleteWebhook", { drop_pending_updates: false });
      await telegramRequest(token, "setChatMenuButton", {
        menu_button: {
          type: "web_app",
          text: "Открыть приложение",
          web_app: { url: appUrl },
        },
      });

      while (!controller.signal.aborted) {
        let updates;
        try {
          updates = await telegramRequest(token, "getUpdates", {
            offset,
            timeout: 50,
            allowed_updates: ["message"],
          }, controller.signal);
        } catch (error) {
          if (controller.signal.aborted) break;
          console.error("Telegram polling temporarily failed:", error.message);
          await new Promise((resolve) => setTimeout(resolve, 3000));
          continue;
        }

        for (const update of updates) {
          offset = update.update_id + 1;
          const message = update.message;
          if (!message?.from || message.chat?.type !== "private") continue;
          const command = String(message.text ?? "").split(/\s+/, 1)[0].split("@")[0];
          if (!["/start", "/id", "/help"].includes(command)) continue;

          const userId = String(message.from.id);
          const master = storage.getActiveMasterByTelegramId(userId);
          const greeting = master
            ? `Здравствуйте, ${master.name}! Это бот записи салона. Ваш Telegram ID: ${userId}.`
            : `Здравствуйте! Это бот записи в салон. Ваш Telegram ID: ${userId}.`;
          const instructions = command === "/id"
            ? `Ваш Telegram ID: ${userId}. Для доступа мастера откройте приложение и отправьте заявку главному мастеру.`
            : `${greeting}\n\nНажмите кнопку ниже, чтобы открыть приложение.`;
          try {
            await telegramRequest(token, "sendMessage", {
              chat_id: message.chat.id,
              text: instructions,
              reply_markup: {
                inline_keyboard: [[{
                  text: "Открыть приложение",
                  web_app: { url: appUrl },
                }]],
              },
            });
          } catch (error) {
            console.error("Could not reply to a Telegram bot command:", error.message);
          }
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) console.error("Telegram bot setup failed:", error.message);
    }
  };

  void run();
  return { stop: () => controller.abort() };
}
