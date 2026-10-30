/**
 * Telegram-бот для СОТРУДНИКОВ и ВЛАДЕЛЬЦЕВ (3-й Worker: vodomat-staff-bot)
 * Работает с той же базой Cloudflare D1 (DB), что и основной бот.
 * 
 * ИЗМЕНЕНИЯ:
 * - Автоматический вход отключён: вход строго по 6-значному коду доступа!
 * - Добавлено красивое приветственное письмо на /start;
 * - Добавлено постоянное нижнее меню (Reply Keyboard) для сотрудников и владельцев.
 */

const APP_URL = "https://vodomat-staff-bot.lomakindaniil2005.workers.dev/app";

// Список команд (кнопка «/») и кнопка меню слева от поля ввода, открывающая приложение
async function setupBotUi(env, chatId) {
  const call = async (method, body) => {
    const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) console.error(`${method} failed: ${JSON.stringify(j)}`);
  };
  const menu_button = { type: "web_app", text: "Водомат", web_app: { url: APP_URL } };
  await call("setMyCommands", { commands: [
    { command: "start", description: "Запуск бота" },
    { command: "menu", description: "Главное меню" },
    { command: "app", description: "Открыть приложение" },
    { command: "code", description: "Ввести код доступа" }
  ] });
  await call("setChatMenuButton", { menu_button });                       // для всех
  if (chatId) await call("setChatMenuButton", { chat_id: Number(chatId), menu_button }); // для этого чата сразу
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/app") {
      return new Response(MINIAPP_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (request.method === "POST" && url.pathname.startsWith("/api/")) {
      try { return await handleApi(request, env, url.pathname); }
      catch (err) { console.error(`API error: ${err && err.stack ? err.stack : String(err)}`); return new Response(JSON.stringify({ error: "server error" }), { status: 500, headers: { "content-type": "application/json" } }); }
    }
    if (request.method !== "POST") {
      return new Response("ok — этот адрес принимает только Telegram webhook", { status: 200 });
    }
    const secretHeader = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (env.TELEGRAM_WEBHOOK_SECRET && secretHeader !== env.TELEGRAM_WEBHOOK_SECRET) {
      return new Response("forbidden", { status: 403 });
    }
    let update;
    try {
      update = await request.json();
    } catch (e) {
      return new Response("bad request", { status: 400 });
    }

    try {
      if (update.message) {
        await handleMessage(update.message, env);
      } else if (update.callback_query) {
        await handleCallback(update.callback_query, env);
      }
    } catch (err) {
      console.error(`Error handling update: ${err && err.stack ? err.stack : String(err)}`);
    }
    return new Response("ok", { status: 200 });
  }
};

// ============================================================
// База данных (D1): Создание и обновление таблиц
// ============================================================

async function ensureEmployeeTables(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS employee_codes (
      code TEXT PRIMARY KEY,
      owner_chat_id TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS employees (
      employee_chat_id TEXT PRIMARY KEY,
      owner_chat_id TEXT NOT NULL,
      name TEXT,
      assigned_machines TEXT NOT NULL DEFAULT '[]',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS authorized_owners (
      owner_chat_id TEXT PRIMARY KEY,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS owner_codes (
      code TEXT PRIMARY KEY,
      owner_chat_id TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS employee_sessions (
      chat_id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS service_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_chat_id TEXT NOT NULL,
      employee_chat_id TEXT NOT NULL,
      employee_name TEXT,
      machine_id TEXT NOT NULL,
      machine_name TEXT,
      filters_changed TEXT NOT NULL DEFAULT '[]',
      readings TEXT NOT NULL DEFAULT '{}',
      sanitization TEXT NOT NULL DEFAULT '{}',
      photos TEXT NOT NULL DEFAULT '[]',
      meter_photos TEXT NOT NULL DEFAULT '[]',
      comment TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS employee_issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_chat_id TEXT NOT NULL,
      employee_chat_id TEXT NOT NULL,
      machine_id TEXT NOT NULL,
      machine_name TEXT,
      text TEXT,
      photos TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'open',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS employee_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_chat_id TEXT NOT NULL,
      employee_chat_id TEXT NOT NULL,
      machine_id TEXT NOT NULL,
      machine_name TEXT,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME
    )
  `).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS filter_stock (
      owner_chat_id TEXT NOT NULL,
      machine_id TEXT NOT NULL,
      filter_id TEXT NOT NULL,
      filter_name TEXT NOT NULL,
      stock_qty INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (owner_chat_id, machine_id, filter_id)
    )
  `).run();
}

// Пресеты порогов для автоматического предупреждения
const YEARLY_KIT_PRESETS = [
  { keywords: ["5 мкр", "5мкр", "5 микрон"], name: "Полипропилен 5мкр Аквадело", qty: 12, warnAt: 2 },
  { keywords: ["1 мкр", "1мкр", "1 микрон"], name: "Полипропилен 1мкр Аквадело", qty: 6, warnAt: 1 },
  { keywords: ["уголь", "сорбент", "кокос"], name: "Уголь кокосовый Сорбент (5.2кг)", qty: 1, warnAt: 0 },
  { keywords: ["мембран", "vontron"], name: "Мембрана VONTRON 3013-400G", qty: 2, warnAt: 1 },
  { keywords: ["постуголь", "t33a"], name: "Постуголь NatureWater T33A", qty: 2, warnAt: 1 },
  { keywords: ["минерализатор", "мв-10"], name: "Минерализатор МВ-10 NatureWater", qty: 2, warnAt: 1 },
  { keywords: ["уф", "лампа", "15в"], name: "УФ лампа 15W", qty: 1, warnAt: 0 },
];

function getFilterThreshold(filterName) {
  const lower = filterName.toLowerCase();
  for (const item of YEARLY_KIT_PRESETS) {
    if (item.keywords.some(k => lower.includes(k))) {
      return item.warnAt;
    }
  }
  return 1;
}

// ============================================================
// Обработка текстовых сообщений
// ============================================================

async function handleMessage(message, env) {
  await ensureEmployeeTables(env);
  const chatId = String(message.chat.id);
  const text = (message.text || "").trim();

  const session = await getSession(env, chatId);
  const emp = await getEmployee(env, chatId);
  const isAuthorizedOwner = await isAuthorizedOwnerInDb(env, chatId);

  // Нажатие на кнопки нижнего меню
  if (text === "🔑 Ввести код доступа") {
    await clearSession(env, chatId);
    await setSession(env, chatId, { step: "enter_code" });
    await sendMessage(env, chatId, "🔑 <b>Введите 6-значный код доступа:</b>\n\n• Сотрудникам: код выдаёт владелец.\n• Владельцам: введите ваш Telegram ID из главного бота.", { parse_mode: "HTML" });
    return;
  }

  if (text === "🚰 Мои водоматы") {
    if (emp) await sendEmployeeMainMenu(env, chatId, emp);
    else if (isAuthorizedOwner) await sendOwnerMainMenu(env, chatId);
    else await sendWelcomeMessage(env, chatId);
    return;
  }

  if (text === "👷 Сотрудники" && isAuthorizedOwner) {
    await handleCallback({ message, data: "owner:list_emp", id: "0" }, env);
    return;
  }

  if (text === "📦 Склад фильтров" && isAuthorizedOwner) {
    await handleCallback({ message, data: "owner:stock_menu", id: "0" }, env);
    return;
  }

  if (text === "📋 Активные задания" && isAuthorizedOwner) {
    await handleCallback({ message, data: "owner:all_tasks", id: "0" }, env);
    return;
  }

  if (text === "🔑 Код сотрудника" && isAuthorizedOwner) {
    await handleCallback({ message, data: "owner:add_code", id: "0" }, env);
    return;
  }

  if (text === "📋 Мои задания" && emp) {
    const { results } = await env.DB.prepare("SELECT * FROM employee_tasks WHERE employee_chat_id = ? AND status = 'pending' ORDER BY created_at DESC").bind(chatId).all();
    if (!results.length) {
      await sendMessage(env, chatId, "📋 У вас нет активных заданий.", { keyboard: employeeReplyKeyboard() });
      return;
    }
    let txt = "📋 <b>Ваши активные задания:</b>\n\n";
    for (const t of results) {
      txt += `▪️ <b>${t.machine_name}</b>: ${t.title}\n`;
    }
    await sendMessage(env, chatId, txt, { parse_mode: "HTML", keyboard: employeeReplyKeyboard() });
    return;
  }

  if (text === "🔄 Главное меню") {
    if (emp) await sendEmployeeMainMenu(env, chatId, emp);
    else if (isAuthorizedOwner) await sendOwnerMainMenu(env, chatId);
    else await sendWelcomeMessage(env, chatId);
    return;
  }

  if (text.startsWith("/menu")) {
    if (emp) await sendEmployeeMainMenu(env, chatId, emp);
    else if (isAuthorizedOwner) await sendOwnerMainMenu(env, chatId);
    else await sendWelcomeMessage(env, chatId);
    return;
  }

  if (text === "📱 Приложение" || text.startsWith("/app")) {
    await sendMessage(env, chatId, "📱 <b>Мини-приложение «Водомат Сервис»</b>", {
      parse_mode: "HTML",
      inline_keyboard: [[{ text: "📱 Открыть приложение", web_app: { url: APP_URL } }]]
    });
    return;
  }

  if (text.startsWith("/code")) {
    await clearSession(env, chatId);
    await setSession(env, chatId, { step: "enter_code" });
    await sendMessage(env, chatId, "🔑 <b>Введите 6-значный код доступа:</b>", { parse_mode: "HTML" });
    return;
  }

  if (text.startsWith("/start")) {
    await clearSession(env, chatId);
    await setupBotUi(env, chatId).catch(e => console.error("setupBotUi: " + e));

    if (emp) {
      await sendEmployeeMainMenu(env, chatId, emp);
      return;
    }

    if (isAuthorizedOwner) {
      await sendOwnerMainMenu(env, chatId);
      return;
    }

    // Новый или незарегистрированный пользователь -> Отправляем Приветственное Письмо
    await sendWelcomeMessage(env, chatId);
    return;
  }

  // Если пользователь отправляет просто 6-значное число вне сессии — пробуем его как код
  if (!session && /^\d{5,12}$/.test(text)) {
    await processAccessCode(env, chatId, text, message.from.first_name || "Пользователь");
    return;
  }

  if (session) {
    if (session.step === "enter_code") {
      await processAccessCode(env, chatId, text, message.from.first_name || "Пользователь");
      return;
    }

    if (session.step === "owner_create_task_text") {
      if (!text) {
        await sendMessage(env, chatId, "Напишите текст задания.");
        return;
      }
      const { empChatId, machineId, machineName } = session;
      await env.DB.prepare(`
        INSERT INTO employee_tasks (owner_chat_id, employee_chat_id, machine_id, machine_name, title, status)
        VALUES (?, ?, ?, ?, ?, 'pending')
      `).bind(chatId, empChatId, machineId, machineName, text).run();

      const empObj = await getEmployee(env, empChatId);
      await clearSession(env, chatId);

      await sendMessage(env, chatId, `✅ Задание для ${empObj ? empObj.name : "сотрудника"} создано!`, {
        keyboard: ownerReplyKeyboard(),
        inline_keyboard: [[{ text: "🔙 Назад в меню", callback_data: "owner:menu" }]]
      });

      try {
        await sendMessage(env, empChatId, 
          `📋 <b>Вам выдано новое задание!</b>\n\n` +
          `🚰 Водомат: <b>${machineName}</b>\n` +
          `📝 Задание: ${text}`,
          { parse_mode: "HTML", keyboard: employeeReplyKeyboard() }
        );
      } catch (e) {}
      return;
    }

    if (session.step === "owner_set_stock_qty") {
      const qty = parseInt(text, 10);
      if (isNaN(qty) || qty < 0) {
        await sendMessage(env, chatId, "Введите целое число (например: 12).");
        return;
      }
      await env.DB.prepare(`
        INSERT INTO filter_stock (owner_chat_id, machine_id, filter_id, filter_name, stock_qty)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(owner_chat_id, machine_id, filter_id) DO UPDATE SET stock_qty = excluded.stock_qty
      `).bind(chatId, session.machine_id, session.filter_id, session.filter_name, qty).run();

      await clearSession(env, chatId);
      await sendMessage(env, chatId, `✅ Остаток фильтра «<b>${session.filter_name}</b>» установлен: <b>${qty} шт.</b>`, {
        parse_mode: "HTML",
        keyboard: ownerReplyKeyboard(),
        inline_keyboard: [[{ text: "🔙 К складу фильтров", callback_data: `owner:stock_m:${session.machine_id}` }]]
      });
      return;
    }

    if (session.step === "enter_readings") {
      const bits = text.split(/\s+/);
      const water = parseFloat((bits[0] || "").replace(",", "."));
      const elec = parseFloat((bits[1] || "").replace(",", "."));
      if (isNaN(water) || isNaN(elec)) {
        await sendMessage(env, chatId, "⚠️ Напишите два числа через пробел (вода и свет).\nПример: 120.5 450");
        return;
      }
      session.readings = { water, elec };
      session.step = "meter_photos";
      session.meter_photos = [];
      await setSession(env, chatId, session);
      await sendMessage(env, chatId, "📸 <b>Теперь обязательно прикрепите ФОТО СЧЁТЧИКОВ (вода и свет):</b>\nОтправьте фото, а затем напишите «Готово».");
      return;
    }

    if (session.step === "meter_photos") {
      if (/^готово$|^нет$/i.test(text)) {
        if (!session.meter_photos || !session.meter_photos.length) {
          await sendMessage(env, chatId, "⚠️ Пожалуйста, прикрепите хотя бы 1 фото счётчика для фиксации показаний!");
          return;
        }
        session.step = "service_draft";
        await setSession(env, chatId, session);
        await sendMessage(env, chatId, `✅ Фото счётчиков сохранены (${session.meter_photos.length} шт.).`);
        await sendServiceDraftMenu(env, chatId, session);
        return;
      }
    }

    if (session.step === "issue_text") {
      session.issue_text = text;
      session.step = "issue_photos";
      await setSession(env, chatId, session);
      await sendMessage(env, chatId, "📷 Пришлите фото поломки/проблемы (если есть), а когда закончите — напишите «Готово».");
      return;
    }

    if (session.step === "issue_photos") {
      if (/^готово$|^нет$/i.test(text)) {
        await finalizeIssueReport(env, chatId, session);
        return;
      }
    }

    if (session.step === "service_photos") {
      if (/^готово$|^нет$/i.test(text)) {
        session.step = "service_draft";
        await setSession(env, chatId, session);
        await sendServiceDraftMenu(env, chatId, session);
        return;
      }
    }
  }

  // Прием фото
  if (message.photo && message.photo.length && session) {
    const largestPhoto = message.photo[message.photo.length - 1].file_id;

    if (session.step === "meter_photos") {
      session.meter_photos = session.meter_photos || [];
      session.meter_photos.push(largestPhoto);
      await setSession(env, chatId, session);
      await sendMessage(env, chatId, `✅ Фото счётчика прикреплено (${session.meter_photos.length} шт.). Ещё фото или напишите «Готово».`);
      return;
    }

    if (session.step === "service_photos") {
      session.photos = session.photos || [];
      session.photos.push(largestPhoto);
      await setSession(env, chatId, session);
      await sendMessage(env, chatId, `✅ Фото добавлены (${session.photos.length} шт.). Ещё фото или напишите «Готово».`);
      return;
    }

    if (session.step === "issue_photos") {
      session.photos = session.photos || [];
      session.photos.push(largestPhoto);
      await setSession(env, chatId, session);
      await sendMessage(env, chatId, `✅ Фото проблемы прикреплено. Ещё фото или напишите «Готово».`);
      return;
    }
  }

  await sendMessage(env, chatId, "Нажмите /start или введите код доступа.");
}

// ============================================================
// Приветственное письмо и Клавиатуры
// ============================================================

async function sendWelcomeMessage(env, chatId) {
  const welcomeText =
    "👋 <b>Добро пожаловать в «Водомат Сервис»!</b>\n\n" +
    "Данный бот предназначен для <b>сотрудников</b> и <b>владельцев водоматов</b>:\n\n" +
    "🛠 <b>Сотрудникам:</b>\n" +
    "• Фиксация обслуживания и замен фильтров;\n" +
    "• Ввод показаний и фото счётчиков;\n" +
    "• Получение и отметка выполнения заданий;\n" +
    "• Сообщения о поломках с фотографиями.\n\n" +
    "👑 <b>Владельцам:</b>\n" +
    "• Автоматический учёт склада и списание картриджей;\n" +
    "• Выдача заданий и контроль работы сотрудников;\n" +
    "• Мгновенные фотоотчёты после каждого обслуживания.\n\n" +
    "🔑 <b>Вход осуществляется только по коду доступа:</b>\n" +
    "Введите 6-значный код, который вам передал руководитель, или нажмите кнопку ниже 👇";

  await sendMessage(env, chatId, welcomeText, {
    parse_mode: "HTML",
    keyboard: unauthReplyKeyboard(),
    inline_keyboard: [
      [{ text: "🔑 Ввести код доступа", callback_data: "role:enter_code" }]
    ]
  });
}

function unauthReplyKeyboard() {
  return [
    ["🔑 Ввести код доступа"]
  ];
}

function employeeReplyKeyboard() {
  return [
    ["🚰 Мои водоматы", "📋 Мои задания"],
    ["📱 Приложение", "🔄 Главное меню"]
  ];
}

function ownerReplyKeyboard() {
  return [
    ["👷 Сотрудники", "📦 Склад фильтров"],
    ["📋 Активные задания", "🔑 Код сотрудника"],
    ["📱 Приложение", "🔄 Главное меню"]
  ];
}

// ============================================================
// Обработка Callback-кнопок
// ============================================================

async function handleCallback(callback, env) {
  await ensureEmployeeTables(env);
  const chatId = String(callback.message.chat.id);
  const messageId = callback.message.message_id;
  const data = callback.data || "";

  // Если вызов пришёл с кнопки нижнего меню (id "0"), редактировать нечего:
  // message — это сообщение самого пользователя, его бот изменить не может. Шлём новое сообщение.
  const fromReplyKeyboard = callback.id === "0";
  const edit = (text, keyboard) => fromReplyKeyboard
    ? sendMessage(env, chatId, text, { parse_mode: "HTML", inline_keyboard: keyboard })
    : editMessageText(env, chatId, messageId, text, { parse_mode: "HTML", inline_keyboard: keyboard });

  if (data === "role:enter_code") {
    await answerCallback(env, callback.id);
    await setSession(env, chatId, { step: "enter_code" });
    await edit("🔑 <b>Введите 6-значный код доступа:</b>\n\nНапишите код от вашего руководителя сообщением.", []);
    return;
  }

  // Меню Владельца
  if (data === "owner:menu") {
    await answerCallback(env, callback.id);
    await sendOwnerMainMenu(env, chatId, messageId);
    return;
  }

  if (data === "owner:add_code") {
    await answerCallback(env, callback.id);
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    await env.DB.prepare("INSERT INTO employee_codes (code, owner_chat_id) VALUES (?, ?)").bind(code, chatId).run();

    await edit(
      `🔑 <b>Код подключения сотрудника:</b>\n\n` +
      `<code>${code}</code>\n\n` +
      `Передайте этот код сотруднику. Он должен запустить этого бота и ввести данный код.`,
      [[{ text: "🔙 Назад", callback_data: "owner:menu" }]]
    );
    return;
  }

  if (data === "owner:stock_menu") {
    await answerCallback(env, callback.id);
    const mainUser = await getMainDbUser(env, chatId);
    const machines = mainUser.machines || [];

    if (!machines.length) {
      await edit("У вас пока нет заведённых водоматов в основном боте.", [[{ text: "🔙 Назад", callback_data: "owner:menu" }]]);
      return;
    }

    const rows = machines.map(m => [{
      text: `📦 Склад: ${m.name}`,
      callback_data: `owner:stock_m:${m.id}`
    }]);
    rows.push([{ text: "🔙 Назад", callback_data: "owner:menu" }]);

    await edit("📦 <b>Управление складом фильтров по водоматам:</b>\nВыберите аппарат, чтобы проверить остатки или загрузить годовой комплект:", rows);
    return;
  }

  if (data.startsWith("owner:stock_m:")) {
    await answerCallback(env, callback.id);
    const machineId = data.slice("owner:stock_m:".length);
    const mainUser = await getMainDbUser(env, chatId);
    const machine = (mainUser.machines || []).find(m => m.id === machineId);

    if (!machine || !machine.filters.length) {
      await edit("У этого водомата не добавлены фильтры в основном боте.", [[{ text: "🔙 Назад", callback_data: "owner:stock_menu" }]]);
      return;
    }

    const { results } = await env.DB.prepare("SELECT * FROM filter_stock WHERE owner_chat_id = ? AND machine_id = ?").bind(chatId, machineId).all();
    const stockMap = {};
    for (const r of results) stockMap[r.filter_id] = r.stock_qty;

    let txt = `📦 <b>Запас фильтров — ${machine.name}</b>\n\n`;
    const rows = [];

    rows.push([{ text: "⚡️ Загрузить 1-годовой комплект", callback_data: `owner:stock_load_preset:${machineId}` }]);

    for (const f of machine.filters) {
      let defaultQty = 2;
      const lower = f.name.toLowerCase();
      if (lower.includes("5 мкр") || lower.includes("5мкр")) defaultQty = 12;
      else if (lower.includes("1 мкр") || lower.includes("1мкр")) defaultQty = 6;
      else if (lower.includes("уголь") || lower.includes("сорбент")) defaultQty = 1;

      const currentQty = stockMap[f.id] !== undefined ? stockMap[f.id] : defaultQty;
      const thresh = getFilterThreshold(f.name);
      const warning = currentQty <= thresh ? " ⚠️ <b>(Мало! Докупить)</b>" : "";

      txt += `• <b>${f.name}:</b> На складе: <b>${currentQty} шт.</b>${warning}\n`;

      rows.push([{
        text: `✏️ Изменить остаток: ${f.name}`,
        callback_data: `owner:set_stock_prompt:${machineId}:${f.id}`
      }]);
    }

    rows.push([{ text: "🔙 К списку водоматов", callback_data: "owner:stock_menu" }]);
    await edit(txt, rows);
    return;
  }

  if (data.startsWith("owner:stock_load_preset:")) {
    await answerCallback(env, callback.id, "Загрузка комплекта...");
    const machineId = data.slice("owner:stock_load_preset:".length);
    const mainUser = await getMainDbUser(env, chatId);
    const machine = (mainUser.machines || []).find(m => m.id === machineId);

    if (machine) {
      for (const f of machine.filters) {
        let presetQty = 2;
        const lower = f.name.toLowerCase();
        if (lower.includes("5 мкр") || lower.includes("5мкр")) presetQty = 12;
        else if (lower.includes("1 мкр") || lower.includes("1мкр")) presetQty = 6;
        else if (lower.includes("уголь") || lower.includes("сорбент")) presetQty = 1;
        else if (lower.includes("мембран") || lower.includes("vontron")) presetQty = 2;
        else if (lower.includes("постуголь") || lower.includes("t33a")) presetQty = 2;
        else if (lower.includes("минерализатор") || lower.includes("мв-10")) presetQty = 2;
        else if (lower.includes("уф") || lower.includes("лампа")) presetQty = 1;

        await env.DB.prepare(`
          INSERT INTO filter_stock (owner_chat_id, machine_id, filter_id, filter_name, stock_qty)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(owner_chat_id, machine_id, filter_id) DO UPDATE SET stock_qty = excluded.stock_qty
        `).bind(chatId, machineId, f.id, f.name, presetQty).run();
      }
    }

    await handleCallback({ message: callback.message, data: `owner:stock_m:${machineId}`, id: callback.id }, env);
    return;
  }

  if (data.startsWith("owner:set_stock_prompt:")) {
    await answerCallback(env, callback.id);
    const [, , machineId, filterId] = data.split(":");
    const mainUser = await getMainDbUser(env, chatId);
    const machine = (mainUser.machines || []).find(m => m.id === machineId);
    const filter = machine ? machine.filters.find(f => f.id === filterId) : null;

    await setSession(env, chatId, {
      step: "owner_set_stock_qty",
      machine_id: machineId,
      filter_id: filterId,
      filter_name: filter ? filter.name : "Фильтр"
    });

    await edit(`📦 <b>Укажите оставшееся количество (шт) для «${filter ? filter.name : ""}»:</b>\nНапишите число (например: 12 для 5мкр, 6 для 1мкр, 2 для мембран).`, []);
    return;
  }

  if (data === "owner:list_emp") {
    await answerCallback(env, callback.id);
    const emps = await getEmployeesByOwner(env, chatId);
    if (!emps.length) {
      await edit("👷 У вас пока нет подключённых сотрудников.", [
        [{ text: "➕ Создать код подключения", callback_data: "owner:add_code" }],
        [{ text: "🔙 Назад", callback_data: "owner:menu" }]
      ]);
      return;
    }
    const rows = emps.map(e => [
      { text: `👷 ${e.name || "Сотрудник"} (${JSON.parse(e.assigned_machines).length} т.)`, callback_data: `owner:emp_manage:${e.employee_chat_id}` }
    ]);
    rows.push([{ text: "➕ Создать код для нового сотрудника", callback_data: "owner:add_code" }]);
    rows.push([{ text: "🔙 Назад", callback_data: "owner:menu" }]);
    await edit("👷 <b>Управление сотрудниками:</b>", rows);
    return;
  }

  if (data.startsWith("owner:emp_manage:")) {
    await answerCallback(env, callback.id);
    const empChatId = data.slice("owner:emp_manage:".length);
    const emp = await getEmployee(env, empChatId);
    if (!emp) return;

    const mainUser = await getMainDbUser(env, chatId);
    const machines = mainUser.machines || [];
    const assignedIds = new Set(JSON.parse(emp.assigned_machines || "[]"));

    const rows = [];
    rows.push([{ text: "📋 Дать задание сотруднику", callback_data: `owner:add_task_select_m:${empChatId}` }]);
    rows.push([{ text: "📑 Список заданий сотрудника", callback_data: `owner:emp_tasks:${empChatId}` }]);

    rows.push([{ text: "─── Доступ к водоматам ───", callback_data: "ignore" }]);
    for (const m of machines) {
      const isAssigned = assignedIds.has(m.id);
      rows.push([{
        text: `${isAssigned ? "✅" : "☐"} ${m.name}`,
        callback_data: `owner:toggle_m:${empChatId}:${m.id}`
      }]);
    }

    rows.push([{ text: "❌ Уволить сотрудника", callback_data: `owner:fire_ask:${empChatId}` }]);
    rows.push([{ text: "🔙 К списку сотрудников", callback_data: "owner:list_emp" }]);

    await edit(`👷 <b>Сотрудник: ${emp.name}</b>\n\nНастройте доступ к точкам или выдайте задание:`, rows);
    return;
  }

  if (data.startsWith("owner:toggle_m:")) {
    await answerCallback(env, callback.id);
    const [, , empChatId, machineId] = data.split(":");
    const emp = await getEmployee(env, empChatId);
    if (!emp) return;

    let assigned = JSON.parse(emp.assigned_machines || "[]");
    if (assigned.includes(machineId)) {
      assigned = assigned.filter(id => id !== machineId);
    } else {
      assigned.push(machineId);
    }

    await env.DB.prepare("UPDATE employees SET assigned_machines = ? WHERE employee_chat_id = ?")
      .bind(JSON.stringify(assigned), empChatId)
      .run();

    await handleCallback({ message: callback.message, data: `owner:emp_manage:${empChatId}`, id: callback.id }, env);
    return;
  }

  if (data.startsWith("owner:fire_ask:")) {
    await answerCallback(env, callback.id);
    const empChatId = data.slice("owner:fire_ask:".length);
    const emp = await getEmployee(env, empChatId);
    if (!emp) return;

    await edit(`❓ Вы уверены, что хотите уволить сотрудника <b>${emp.name}</b>? Доступ будет моментально заблокирован.`, [
      [{ text: "🔥 Да, уволить сотрудника", callback_data: `owner:fire_yes:${empChatId}` }],
      [{ text: "❌ Отмена", callback_data: `owner:emp_manage:${empChatId}` }]
    ]);
    return;
  }

  if (data.startsWith("owner:fire_yes:")) {
    await answerCallback(env, callback.id);
    const empChatId = data.slice("owner:fire_yes:".length);
    const emp = await getEmployee(env, empChatId);
    
    await env.DB.prepare("DELETE FROM employees WHERE employee_chat_id = ?").bind(empChatId).run();
    await env.DB.prepare("DELETE FROM employee_tasks WHERE employee_chat_id = ? AND status = 'pending'").bind(empChatId).run();

    try {
      await sendMessage(env, empChatId, "⛔ <b>Ваш доступ отменён руководителем.</b> Вы уволены из системы.");
    } catch (e) {}

    await edit(`✅ Сотрудник <b>${emp ? emp.name : ""}</b> уволен.`, [[{ text: "🔙 К списку сотрудников", callback_data: "owner:list_emp" }]]);
    return;
  }

  // Задания
  if (data.startsWith("owner:add_task_select_m:")) {
    await answerCallback(env, callback.id);
    const empChatId = data.slice("owner:add_task_select_m:".length);
    const mainUser = await getMainDbUser(env, chatId);
    const machines = mainUser.machines || [];

    if (!machines.length) {
      await edit("У вас нет заведённых водоматов.", [[{ text: "🔙 Назад", callback_data: `owner:emp_manage:${empChatId}` }]]);
      return;
    }

    const rows = machines.map(m => [{
      text: `🚰 ${m.name}`,
      callback_data: `owner:add_task_prompt:${empChatId}:${m.id}`
    }]);
    rows.push([{ text: "🔙 Отмена", callback_data: `owner:emp_manage:${empChatId}` }]);

    await edit("🚰 Выберите водомат, для которого даётся задание:", rows);
    return;
  }

  if (data.startsWith("owner:add_task_prompt:")) {
    await answerCallback(env, callback.id);
    const [, , empChatId, machineId] = data.split(":");
    const mainUser = await getMainDbUser(env, chatId);
    const machine = (mainUser.machines || []).find(m => m.id === machineId);

    await setSession(env, chatId, {
      step: "owner_create_task_text",
      empChatId,
      machineId,
      machineName: machine ? machine.name : ""
    });

    await edit(`📋 <b>Напишите текстом суть задания для «${machine ? machine.name : ""}»:</b>`, []);
    return;
  }

  if (data === "owner:all_tasks" || data.startsWith("owner:emp_tasks:")) {
    await answerCallback(env, callback.id);
    const isEmpTasks = data.startsWith("owner:emp_tasks:");
    const empChatId = isEmpTasks ? data.slice("owner:emp_tasks:".length) : null;

    let query = "SELECT * FROM employee_tasks WHERE owner_chat_id = ? AND status = 'pending' ORDER BY created_at DESC";
    let params = [chatId];

    if (empChatId) {
      query = "SELECT * FROM employee_tasks WHERE owner_chat_id = ? AND employee_chat_id = ? AND status = 'pending' ORDER BY created_at DESC";
      params = [chatId, empChatId];
    }

    const { results } = await env.DB.prepare(query).bind(...params).all();

    if (!results.length) {
      await edit("📋 Активных заданий нет.", [[{ text: "🔙 Назад", callback_data: empChatId ? `owner:emp_manage:${empChatId}` : "owner:menu" }]]);
      return;
    }

    let txt = "📋 <b>Активные задания:</b>\n\n";
    const rows = [];
    for (const t of results) {
      txt += `▪️ <b>${t.machine_name}</b>\n   Задание: ${t.title}\n\n`;
      rows.push([{ text: `❌ Отозвать задание: "${t.title.slice(0, 15)}..."`, callback_data: `owner:revoke_task:${t.id}` }]);
    }

    rows.push([{ text: "🔙 Назад", callback_data: empChatId ? `owner:emp_manage:${empChatId}` : "owner:menu" }]);
    await edit(txt, rows);
    return;
  }

  if (data.startsWith("owner:revoke_task:")) {
    await answerCallback(env, callback.id);
    const taskId = data.slice("owner:revoke_task:".length);
    const task = await env.DB.prepare("SELECT * FROM employee_tasks WHERE id = ?").bind(taskId).first();

    if (task) {
      await env.DB.prepare("DELETE FROM employee_tasks WHERE id = ?").bind(taskId).run();
      try {
        await sendMessage(env, task.employee_chat_id, `ℹ️ Задание по аппарату «<b>${task.machine_name}</b>» было отозвано руководителем.`);
      } catch (e) {}
    }

    await edit("✅ Задание успешно отозвано.", [[{ text: "🔙 Назад", callback_data: "owner:menu" }]]);
    return;
  }

  // --- СОТРУДНИК: Работа на точке ---
  if (data.startsWith("emp:m:")) {
    await answerCallback(env, callback.id);
    const machineId = data.slice("emp:m:".length);
    const emp = await getEmployee(env, chatId);
    if (!emp) return;

    const mainUser = await getMainDbUser(env, emp.owner_chat_id);
    const machine = (mainUser.machines || []).find(m => m.id === machineId);
    if (!machine) { await edit("Водомат не найден.", []); return; }

    const { count } = await env.DB.prepare("SELECT COUNT(*) as count FROM employee_tasks WHERE employee_chat_id = ? AND machine_id = ? AND status = 'pending'").bind(chatId, machineId).first();

    await edit(
      `🚰 <b>${machine.name}</b>\n📍 ${machine.address}\n\nВыберите действие:`,
      [
        [{ text: `📋 Задания (${count})`, callback_data: `emp:tasks:${machine.id}` }],
        [{ text: "🔧 Обслуживание", callback_data: `emp:service_start:${machine.id}` }],
        [{ text: "⚠️ Сообщить о проблеме / Поломке", callback_data: `emp:issue_start:${machine.id}` }],
        [{ text: "🕐 История обслуживаний", callback_data: `emp:history:${machine.id}` }],
        [{ text: "🔙 К списку водоматов", callback_data: "emp:m_list" }]
      ]
    );
    return;
  }

  if (data === "emp:m_list") {
    await answerCallback(env, callback.id);
    const emp = await getEmployee(env, chatId);
    if (emp) await sendEmployeeMainMenu(env, chatId, emp, messageId);
    return;
  }

  if (data.startsWith("emp:tasks:")) {
    await answerCallback(env, callback.id);
    const machineId = data.slice("emp:tasks:".length);
    const { results } = await env.DB.prepare("SELECT * FROM employee_tasks WHERE employee_chat_id = ? AND machine_id = ? AND status = 'pending' ORDER BY created_at DESC").bind(chatId, machineId).all();

    if (!results.length) {
      await edit("📋 Заданий по этому водомату нет.", [[{ text: "🔙 Назад", callback_data: `emp:m:${machineId}` }]]);
      return;
    }

    let txt = "📋 <b>Список заданий:</b>\n\n";
    const rows = [];
    for (const t of results) {
      txt += `🔹 ${t.title}\n\n`;
      rows.push([{ text: `✅ Выполнено: ${t.title.slice(0, 20)}`, callback_data: `emp:task_done:${t.id}` }]);
    }
    rows.push([{ text: "🔙 Назад", callback_data: `emp:m:${machineId}` }]);

    await edit(txt, rows);
    return;
  }

  if (data.startsWith("emp:task_done:")) {
    await answerCallback(env, callback.id);
    const taskId = data.slice("emp:task_done:".length);
    const task = await env.DB.prepare("SELECT * FROM employee_tasks WHERE id = ?").bind(taskId).first();

    if (task) {
      await env.DB.prepare("UPDATE employee_tasks SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE id = ?").bind(taskId).run();

      const emp = await getEmployee(env, chatId);
      await sendNotificationToOwner(
        env, task.owner_chat_id,
        `✅ <b>Задание выполнено!</b>\n\n` +
        `🚰 Водомат: <b>${task.machine_name}</b>\n` +
        `👷 Сотрудник: ${emp ? emp.name : "Сотрудник"}\n` +
        `📝 Задание: ${task.title}`
      );
    }

    await edit("✅ Задание отмечено как выполненное!", [[{ text: "🔙 К водомату", callback_data: `emp:m:${task ? task.machine_id : ""}` }]]);
    return;
  }

  // Обслуживание
  if (data.startsWith("emp:service_start:")) {
    await answerCallback(env, callback.id);
    const machineId = data.slice("emp:service_start:".length);
    const emp = await getEmployee(env, chatId);
    const mainUser = await getMainDbUser(env, emp.owner_chat_id);
    const machine = (mainUser.machines || []).find(m => m.id === machineId);

    await setSession(env, chatId, {
      step: "service_draft",
      machine_id: machineId,
      machine_name: machine ? machine.name : "",
      filters_changed: [],
      readings: null,
      photos: [],
      meter_photos: []
    });

    await sendServiceDraftMenu(env, chatId, await getSession(env, chatId), messageId);
    return;
  }

  if (data === "emp:toggle_filter_menu") {
    await answerCallback(env, callback.id);
    const session = await getSession(env, chatId);
    if (!session) return;

    const emp = await getEmployee(env, chatId);
    const mainUser = await getMainDbUser(env, emp.owner_chat_id);
    const machine = (mainUser.machines || []).find(m => m.id === session.machine_id);

    if (!machine || !machine.filters.length) {
      await sendMessage(env, chatId, "У этого водомата не заведены фильтры.");
      return;
    }

    const rows = machine.filters.map(f => {
      const isSelected = session.filters_changed.includes(f.id);
      return [{
        text: `${isSelected ? "✅" : "☐"} ${f.name}`,
        callback_data: `emp:toggle_f:${f.id}`
      }];
    });

    rows.push([{ text: "🔙 Назад в меню обслуживания", callback_data: "emp:back_draft" }]);
    await edit("🔧 <b>Отметьте фильтры, которые были заменены:</b>\n<i>(Остаток на складе автоматически уменьшится на 1 шт.)</i>", rows);
    return;
  }

  if (data.startsWith("emp:toggle_f:")) {
    await answerCallback(env, callback.id);
    const filterId = data.slice("emp:toggle_f:".length);
    const session = await getSession(env, chatId);
    if (!session) return;

    if (session.filters_changed.includes(filterId)) {
      session.filters_changed = session.filters_changed.filter(id => id !== filterId);
    } else {
      session.filters_changed.push(filterId);
    }

    await setSession(env, chatId, session);
    await handleCallback({ message: callback.message, data: "emp:toggle_filter_menu", id: callback.id }, env);
    return;
  }

  if (data === "emp:input_readings_prompt") {
    await answerCallback(env, callback.id);
    const session = await getSession(env, chatId);
    session.step = "enter_readings";
    await setSession(env, chatId, session);
    await edit("📊 <b>Введите текущие показания счётчиков:</b>\nвода (м³) и свет (кВт·ч) через пробел.\n\nПример: <code>145.2 380</code>", []);
    return;
  }

  if (data === "emp:add_photo_prompt") {
    await answerCallback(env, callback.id);
    const session = await getSession(env, chatId);
    session.step = "service_photos";
    await setSession(env, chatId, session);
    await edit("📷 <b>Отправьте общий фотоотчёт</b> (чистый корпус, заменённые картриджи).\nПосле отправки всех фото напишите «Готово».", []);
    return;
  }

  if (data === "emp:back_draft") {
    await answerCallback(env, callback.id);
    const session = await getSession(env, chatId);
    await sendServiceDraftMenu(env, chatId, session, messageId);
    return;
  }

  if (data === "emp:service_finish") {
    await answerCallback(env, callback.id);
    const session = await getSession(env, chatId);
    if (!session) return;

    const emp = await getEmployee(env, chatId);
    const mainUser = await getMainDbUser(env, emp.owner_chat_id);
    const machine = (mainUser.machines || []).find(m => m.id === session.machine_id);

    const today = moscowDateString();
    const lowStockAlerts = [];
    let mainUserChanged = false;

    if (machine && session.filters_changed.length) {
      for (const filterId of session.filters_changed) {
        const filterObj = machine.filters.find(f => f.id === filterId);
        if (filterObj) {
          filterObj.last_replacement_date = today;
          filterObj.last_reminder_sent = null;

          let defaultQty = 2;
          const lower = filterObj.name.toLowerCase();
          if (lower.includes("5 мкр") || lower.includes("5мкр")) defaultQty = 12;
          else if (lower.includes("1 мкр") || lower.includes("1мкр")) defaultQty = 6;
          else if (lower.includes("уголь") || lower.includes("сорбент")) defaultQty = 1;

          const currentStockRow = await env.DB.prepare(
            "SELECT stock_qty FROM filter_stock WHERE owner_chat_id = ? AND machine_id = ? AND filter_id = ?"
          ).bind(emp.owner_chat_id, session.machine_id, filterId).first();

          let currentQty = currentStockRow ? currentStockRow.stock_qty : defaultQty;
          currentQty = Math.max(0, currentQty - 1);

          await env.DB.prepare(`
            INSERT INTO filter_stock (owner_chat_id, machine_id, filter_id, filter_name, stock_qty)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(owner_chat_id, machine_id, filter_id) DO UPDATE SET stock_qty = excluded.stock_qty
          `).bind(emp.owner_chat_id, session.machine_id, filterId, filterObj.name, currentQty).run();

          const thresh = getFilterThreshold(filterObj.name);
          if (currentQty <= thresh) {
            lowStockAlerts.push(`⚠️ <b>Запас «${filterObj.name}» снизился до ${currentQty} шт.! Пора докупить к этому водомату.</b>`);
          }
        }
      }
      mainUserChanged = true;
    }

    // Показания сотрудника — считаем реальную коммуналку так же, как в основном боте,
    // и кладём как pending_charge, чтобы владелец увидел сумму в разделе «Коммуналка»,
    // а не только текстом в уведомлении.
    let utilityChargeText = "";
    if (machine && session.readings && machine.utilities) {
      const u = machine.utilities;
      const waterDelta = Math.max(0, session.readings.water - (u.water_baseline || 0));
      const elecDelta = Math.max(0, session.readings.elec - (u.elec_baseline || 0));
      const waterCost = Math.round(waterDelta * (u.water_tariff || 0) * 100) / 100;
      const elecCost = Math.round(elecDelta * (u.elec_tariff || 0) * 100) / 100;
      const total = Math.round((waterCost + elecCost) * 100) / 100;

      u.pending_charge = {
        water_reading: session.readings.water,
        elec_reading: session.readings.elec,
        water_cost: waterCost,
        elec_cost: elecCost,
        total,
        created_at: new Date().toISOString(),
        entered_by: emp.name || "сотрудник",
      };
      utilityChargeText = `💧 <b>К оплате коммуналки: ${total} ₽</b> (вода ${waterCost} ₽, свет ${elecCost} ₽)\n\n`;
      mainUserChanged = true;
    }

    if (mainUserChanged) {
      await updateMainDbUser(env, emp.owner_chat_id, mainUser);
    }

    const filterNames = machine 
      ? machine.filters.filter(f => session.filters_changed.includes(f.id)).map(f => f.name)
      : [];

    await env.DB.prepare(`
      INSERT INTO service_logs (owner_chat_id, employee_chat_id, employee_name, machine_id, machine_name, filters_changed, readings, sanitization, photos, meter_photos)
      VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)
    `).bind(
      emp.owner_chat_id,
      chatId,
      emp.name || "Сотрудник",
      session.machine_id,
      machine ? machine.name : "",
      JSON.stringify(filterNames),
      JSON.stringify(session.readings || {}),
      JSON.stringify(session.photos || []),
      JSON.stringify(session.meter_photos || [])
    ).run();

    let notifyText = `🛠 <b>Отчёт об обслуживании водомата</b>\n\n` +
      `🚰 Аппарат: <b>${machine ? machine.name : ""}</b>\n` +
      `👷 Сотрудник: ${emp.name || "Сотрудник"}\n` +
      `📅 Дата: ${formatDate(today)}\n\n`;

    if (filterNames.length) {
      notifyText += `🔧 <b>Заменены фильтры:</b>\n• ${filterNames.join("\n• ")}\n\n`;
    } else {
      notifyText += `🔧 Фильтры не менялись.\n\n`;
    }

    if (session.readings) {
      notifyText += `📊 <b>Показания:</b> Вода: ${session.readings.water} м³, Свет: ${session.readings.elec} кВт·ч (Фото приложено ниже)\n\n`;
    }

    notifyText += utilityChargeText;

    if (lowStockAlerts.length) {
      notifyText += lowStockAlerts.join("\n") + "\n\n";
    }

    notifyText += `📷 Фотоотчёт работы: ${session.photos.length} шт., Фото счётчиков: ${session.meter_photos.length} шт.`;

    const allPhotos = [...(session.meter_photos || []), ...(session.photos || [])];
    await sendNotificationToOwner(env, emp.owner_chat_id, notifyText, allPhotos);

    await clearSession(env, chatId);
    await edit("✅ <b>Обслуживание завершено!</b>\nСклад фильтров обновился, а отчёт переданы владельцу.", []);
    return;
  }

  if (data.startsWith("emp:issue_start:")) {
    await answerCallback(env, callback.id);
    const machineId = data.slice("emp:issue_start:".length);
    await setSession(env, chatId, {
      step: "issue_text",
      machine_id: machineId,
      photos: []
    });
    await edit("⚠️ <b>Опишите проблему/поломку одним сообщением:</b>", []);
    return;
  }

  if (data.startsWith("emp:history:")) {
    await answerCallback(env, callback.id);
    const machineId = data.slice("emp:history:".length);
    const { results } = await env.DB.prepare("SELECT * FROM service_logs WHERE machine_id = ? ORDER BY created_at DESC LIMIT 5").bind(machineId).all();

    if (!results.length) {
      await edit("🕐 История обслуживаний пуста.", [[{ text: "🔙 Назад", callback_data: `emp:m:${machineId}` }]]);
      return;
    }

    let txt = "🕐 <b>История обслуживаний:</b>\n\n";
    for (const r of results) {
      const filters = JSON.parse(r.filters_changed || "[]");
      txt += `📅 ${formatDate(r.created_at.slice(0, 10))} — ${r.employee_name}\n`;
      if (filters.length) txt += `   🔧 Фильтры: ${filters.join(", ")}\n`;
      txt += `\n`;
    }

    await edit(txt, [[{ text: "🔙 Назад", callback_data: `emp:m:${machineId}` }]]);
    return;
  }
}

// ============================================================
// Вспомогательные функции взаимодействия и Проверки Кодов
// ============================================================

async function processAccessCode(env, chatId, code, defaultName) {
  // 1. Проверяем код сотрудника
  const empRow = await env.DB.prepare("SELECT owner_chat_id FROM employee_codes WHERE code = ?").bind(code).first();
  if (empRow) {
    await env.DB.prepare(
      `INSERT INTO employees (employee_chat_id, owner_chat_id, name, assigned_machines)
       VALUES (?, ?, ?, '[]')
       ON CONFLICT(employee_chat_id) DO UPDATE SET owner_chat_id = excluded.owner_chat_id`
    ).bind(chatId, empRow.owner_chat_id, defaultName).run();

    await env.DB.prepare("DELETE FROM employee_codes WHERE code = ?").bind(code).run();
    await clearSession(env, chatId);

    await sendMessage(env, chatId, 
      "✅ <b>Вы успешно подключены как Сотрудник!</b>\n\nОжидайте, пока владелец назначит вам доступ к водоматам.", 
      { parse_mode: "HTML", keyboard: employeeReplyKeyboard() }
    );

    await sendNotificationToOwner(
      env, empRow.owner_chat_id,
      `👷 <b>Новый сотрудник подключился!</b>\n\nИмя: ${defaultName}\nНазначьте ему водоматы в меню «👷 Сотрудники».`
    );
    return;
  }

  // 2. Проверяем, ввёл ли Владелец свой Telegram Chat ID (или ID из основной базы users)
  const isRealOwnerInUsers = await env.DB.prepare("SELECT 1 FROM users WHERE chat_id = ?").bind(code).first();
  const isEnvOwner = env.TELEGRAM_CHAT_ID && String(code) === String(env.TELEGRAM_CHAT_ID);

  if ((isRealOwnerInUsers && String(chatId) === String(code)) || isEnvOwner) {
    await authorizeOwnerInDb(env, chatId);
    await clearSession(env, chatId);
    await sendMessage(env, chatId, "👑 <b>Вы успешно авторизованы как Владелец!</b>", { parse_mode: "HTML", keyboard: ownerReplyKeyboard() });
    await sendOwnerMainMenu(env, chatId);
    return;
  }

  await sendMessage(env, chatId, "❌ Неверный код доступа. Перепроверьте 6-значный код от руководителя или Telegram ID и введите снова:");
}

async function finalizeIssueReport(env, chatId, session) {
  const emp = await getEmployee(env, chatId);
  const mainUser = await getMainDbUser(env, emp ? emp.owner_chat_id : chatId);
  const machine = (mainUser.machines || []).find(m => m.id === session.machine_id);

  if (emp) {
    await env.DB.prepare(`
      INSERT INTO employee_issues (owner_chat_id, employee_chat_id, machine_id, machine_name, text, photos)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      emp.owner_chat_id, chatId, session.machine_id,
      machine ? machine.name : "", session.issue_text, JSON.stringify(session.photos || [])
    ).run();

    const notifyText = `🚨 <b>Внимание! Сообщение о проблеме</b>\n\n` +
      `🚰 Аппарат: <b>${machine ? machine.name : ""}</b>\n` +
      `👷 Сотрудник: ${emp.name}\n\n` +
      `💬 <b>Описание:</b>\n${session.issue_text}\n\n` +
      `📷 Фото: ${session.photos.length} шт.`;

    await sendNotificationToOwner(env, emp.owner_chat_id, notifyText, session.photos);
  }

  await clearSession(env, chatId);
  await sendMessage(env, chatId, "✅ Сообщение о проблеме отправлено владельцу.", { keyboard: employeeReplyKeyboard() });
}

async function sendOwnerMainMenu(env, chatId, editMessageId) {
  const emps = await getEmployeesByOwner(env, chatId);
  const { count } = await env.DB.prepare("SELECT COUNT(*) as count FROM employee_tasks WHERE owner_chat_id = ? AND status = 'pending'").bind(chatId).first();

  const text = `👑 <b>Панель Владельца — Сотрудники и Склад</b>\n\n` +
    `• Подключено сотрудников: <b>${emps.length}</b>\n` +
    `• Активных заданий в работе: <b>${count}</b>`;

  const keyboard = [
    [{ text: "👷 Список сотрудников / Права", callback_data: "owner:list_emp" }],
    [{ text: "📦 Склад фильтров по водоматам", callback_data: "owner:stock_menu" }],
    [{ text: `📋 Активные задания (${count})`, callback_data: "owner:all_tasks" }],
    [{ text: "🔑 Создать код для сотрудника", callback_data: "owner:add_code" }]
  ];

  if (editMessageId) {
    await editMessageText(env, chatId, editMessageId, text, { parse_mode: "HTML", inline_keyboard: keyboard });
  } else {
    await sendMessage(env, chatId, text, { parse_mode: "HTML", keyboard: ownerReplyKeyboard(), inline_keyboard: keyboard });
  }
}

async function sendEmployeeMainMenu(env, chatId, emp, editMessageId) {
  const mainUser = await getMainDbUser(env, emp.owner_chat_id);
  const assignedIds = new Set(JSON.parse(emp.assigned_machines || "[]"));
  const machines = (mainUser.machines || []).filter(m => assignedIds.has(m.id));

  if (!machines.length) {
    const txt = "🚰 <b>Вам пока не назначено ни одного водомата.</b>\nОбратитесь к руководителю.";
    if (editMessageId) await editMessageText(env, chatId, editMessageId, txt, { parse_mode: "HTML" });
    else await sendMessage(env, chatId, txt, { parse_mode: "HTML", keyboard: employeeReplyKeyboard() });
    return;
  }

  const rows = machines.map(m => [{ text: `🚰 ${m.name}`, callback_data: `emp:m:${m.id}` }]);
  const txt = "🚰 <b>Ваши назначенные водоматы:</b>";

  if (editMessageId) await editMessageText(env, chatId, editMessageId, txt, { parse_mode: "HTML", inline_keyboard: rows });
  else await sendMessage(env, chatId, txt, { parse_mode: "HTML", keyboard: employeeReplyKeyboard(), inline_keyboard: rows });
}

async function sendServiceDraftMenu(env, chatId, session, editMessageId) {
  const emp = await getEmployee(env, chatId);
  const mainUser = await getMainDbUser(env, emp ? emp.owner_chat_id : chatId);
  const machine = (mainUser.machines || []).find(m => m.id === session.machine_id);

  const filtersCount = session.filters_changed.length;
  const readingsText = session.readings 
    ? `✅ Внесены (${session.readings.water} м³ / ${session.readings.elec} кВт·ч, фото: ${session.meter_photos ? session.meter_photos.length : 0})` 
    : "❌ Не внесены";
  const photosCount = session.photos ? session.photos.length : 0;

  const text = `🔧 <b>Обслуживание — ${machine ? machine.name : ""}</b>\n\n` +
    `• Замена фильтров: <b>${filtersCount} шт.</b>\n` +
    `• Показания и фото счётчиков: <b>${readingsText}</b>\n` +
    `• Общие фото работы: <b>${photosCount} шт.</b>\n\n` +
    `Заполните пункты и нажмите «Завершить обслуживание»:`;

  const keyboard = [
    [{ text: `🔧 Отметить замену фильтров (${filtersCount})`, callback_data: "emp:toggle_filter_menu" }],
    [{ text: `📊 Показания + Фото счётчиков`, callback_data: "emp:input_readings_prompt" }],
    [{ text: `📷 Добавить общие фото (${photosCount})`, callback_data: "emp:add_photo_prompt" }],
    [{ text: `✅ Завершить обслуживание`, callback_data: "emp:service_finish" }],
    [{ text: `🔙 Отмена`, callback_data: `emp:m:${session.machine_id}` }]
  ];

  if (editMessageId) await editMessageText(env, chatId, editMessageId, text, { parse_mode: "HTML", inline_keyboard: keyboard });
  else await sendMessage(env, chatId, text, { parse_mode: "HTML", inline_keyboard: keyboard });
}

// ============================================================
// Взаимодействие с D1 базой
// ============================================================

async function authorizeOwnerInDb(env, chatId) {
  await env.DB.prepare(
    `INSERT INTO authorized_owners (owner_chat_id) VALUES (?)
     ON CONFLICT(owner_chat_id) DO NOTHING`
  ).bind(String(chatId)).run();
}

async function isAuthorizedOwnerInDb(env, chatId) {
  const row = await env.DB.prepare("SELECT 1 FROM authorized_owners WHERE owner_chat_id = ?").bind(String(chatId)).first();
  return !!row;
}

async function getMainDbUser(env, chatId) {
  const row = await env.DB.prepare("SELECT data FROM users WHERE chat_id = ?").bind(String(chatId)).first();
  return row ? JSON.parse(row.data) : { machines: [] };
}

async function updateMainDbUser(env, chatId, userObj) {
  await env.DB.prepare(
    "UPDATE users SET data = ?, updated_at = CURRENT_TIMESTAMP WHERE chat_id = ?"
  ).bind(JSON.stringify(userObj), String(chatId)).run();
}

async function getEmployee(env, chatId) {
  return await env.DB.prepare("SELECT * FROM employees WHERE employee_chat_id = ?").bind(String(chatId)).first();
}

async function getEmployeesByOwner(env, ownerChatId) {
  const { results } = await env.DB.prepare("SELECT * FROM employees WHERE owner_chat_id = ?").bind(String(ownerChatId)).all();
  return results;
}

async function getSession(env, chatId) {
  const row = await env.DB.prepare("SELECT data FROM employee_sessions WHERE chat_id = ?").bind(String(chatId)).first();
  return row ? JSON.parse(row.data) : null;
}

async function setSession(env, chatId, sessionObj) {
  await env.DB.prepare(
    `INSERT INTO employee_sessions (chat_id, data, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(chat_id) DO UPDATE SET data = excluded.data, updated_at = CURRENT_TIMESTAMP`
  ).bind(String(chatId), JSON.stringify(sessionObj)).run();
}

async function clearSession(env, chatId) {
  await env.DB.prepare("DELETE FROM employee_sessions WHERE chat_id = ?").bind(String(chatId)).run();
}

async function sendNotificationToOwner(env, ownerChatId, text, photos = []) {
  const token = env.MAIN_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN;
  if (!token) return;

  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: ownerChatId, text, parse_mode: "HTML" })
  });

  for (const fileId of photos) {
    try {
      const resFile = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
      const dataFile = await resFile.json();
      if (!dataFile.ok) continue;

      const imgRes = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${dataFile.result.file_path}`);
      const blob = await imgRes.blob();

      const form = new FormData();
      form.append("chat_id", String(ownerChatId));
      form.append("photo", blob, "photo.jpg");

      await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: "POST", body: form });
    } catch (e) {
      console.error("Failed to send photo to owner:", e);
    }
  }
}

// ============================================================
// Вспомогательные функции
// ============================================================

async function sendMessage(env, chatId, text, options = {}) {
  const body = { chat_id: chatId, text };
  if (options.parse_mode) body.parse_mode = options.parse_mode;
  if (options.inline_keyboard) body.reply_markup = { inline_keyboard: options.inline_keyboard };
  if (options.keyboard) {
    body.reply_markup = body.reply_markup || {};
    body.reply_markup.keyboard = options.keyboard;
    body.reply_markup.resize_keyboard = true;
    body.reply_markup.is_persistent = true;
  }

  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function editMessageText(env, chatId, messageId, text, options = {}) {
  const body = { chat_id: chatId, message_id: messageId, text };
  if (options.parse_mode) body.parse_mode = options.parse_mode;
  if (options.inline_keyboard) body.reply_markup = { inline_keyboard: options.inline_keyboard };

  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function answerCallback(env, callbackId, text) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackId, text: text || "" })
  });
}

function moscowDateString() {
  const now = new Date(Date.now() + 3 * 3600000);
  return now.toISOString().slice(0, 10);
}

function formatDate(isoDate) {
  if (!isoDate) return "неизвестно";
  const [y, m, d] = isoDate.split("-");
  return `${d}.${m}.${y}`;
}

// ============================================================
// Мини-приложение (Telegram Web App): страница /app и API /api/*
// ============================================================

async function verifyInitData(initData, token) {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!initData) return { reason: "no_init_data" };
  if (!token) return { reason: "no_token" };
  if (!hash) return { reason: "no_hash" };
  params.delete("hash");
  const str = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const enc = new TextEncoder();
  const hmac = async (key, msg) => new Uint8Array(await crypto.subtle.sign(
    "HMAC", await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), enc.encode(msg)));
  const secret = await hmac(enc.encode("WebAppData"), token);
  const sig = [...await hmac(secret, str)].map(b => b.toString(16).padStart(2, "0")).join("");
  if (sig !== hash) return { reason: "bad_hash" };
  if (Date.now() / 1000 - Number(params.get("auth_date") || 0) > 86400) return { reason: "expired" };
  const user = params.get("user");
  return user ? { user: JSON.parse(user) } : { reason: "no_user" };
}

async function handleApi(request, env, path) {
  const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: "bad request" }, 400); }
  const v = await verifyInitData(body.initData || "", env.TELEGRAM_BOT_TOKEN).catch(() => ({ reason: "error" }));
  if (!v.user) return json({ error: "unauthorized", reason: v.reason }, 401);
  const user = v.user;

  await ensureEmployeeTables(env);
  const chatId = String(user.id);
  const emp = await getEmployee(env, chatId);
  const isOwner = !emp && await isAuthorizedOwnerInDb(env, chatId);
  const role = emp ? "employee" : isOwner ? "owner" : "none";
  if (role === "none") return json({ role });

  const ownerId = emp ? emp.owner_chat_id : chatId;
  const all = (await getMainDbUser(env, ownerId)).machines || [];
  const assigned = emp ? new Set(JSON.parse(emp.assigned_machines || "[]")) : null;
  const machines = all.filter(m => !assigned || assigned.has(m.id));
  const action = path.slice("/api/".length);
  const machine = body.machine_id ? machines.find(m => m.id === body.machine_id) : null;

  if (action === "me") {
    const q = emp
      ? env.DB.prepare("SELECT id, machine_id, machine_name, title FROM employee_tasks WHERE employee_chat_id = ? AND status = 'pending' ORDER BY created_at DESC").bind(chatId)
      : env.DB.prepare("SELECT id, machine_id, machine_name, title FROM employee_tasks WHERE owner_chat_id = ? AND status = 'pending' ORDER BY created_at DESC").bind(chatId);
    const tasks = (await q.all()).results;
    const out = { role, machines: machines.map(m => ({ id: m.id, name: m.name, address: m.address })), tasks };
    if (role === "owner") {
      out.employees = (await getEmployeesByOwner(env, chatId)).map(e => ({ id: e.employee_chat_id, name: e.name || "Сотрудник", n: JSON.parse(e.assigned_machines || "[]").length }));
      const st = (await env.DB.prepare("SELECT machine_id, filter_name, stock_qty FROM filter_stock WHERE owner_chat_id = ?").bind(chatId).all()).results;
      out.stock = st.map(s => ({ machine: (all.find(m => m.id === s.machine_id) || {}).name || "", name: s.filter_name, qty: s.stock_qty }));
    }
    return json(out);
  }

  if (action === "task_done" && emp) {
    const task = await env.DB.prepare("SELECT * FROM employee_tasks WHERE id = ? AND employee_chat_id = ?").bind(body.id, chatId).first();
    if (!task) return json({ error: "Задание не найдено" }, 404);
    await env.DB.prepare("UPDATE employee_tasks SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE id = ?").bind(task.id).run();
    await sendNotificationToOwner(env, task.owner_chat_id,
      `✅ <b>Задание выполнено!</b>\n\n🚰 Водомат: <b>${task.machine_name}</b>\n👷 Сотрудник: ${emp.name || "Сотрудник"}\n📝 Задание: ${task.title}`);
    return json({ ok: true });
  }

  if (action === "history" && machine) {
    const rows = (await env.DB.prepare("SELECT employee_name, filters_changed, created_at FROM service_logs WHERE machine_id = ? ORDER BY created_at DESC LIMIT 5").bind(machine.id).all()).results;
    return json({ rows: rows.map(r => ({ date: formatDate(r.created_at.slice(0, 10)), who: r.employee_name, filters: JSON.parse(r.filters_changed || "[]") })) });
  }

  // Тяжёлые сценарии (фильтры, показания, фото) остаются в чате — мини-приложение открывает их
  if (action === "service_start" && emp && machine) {
    await setSession(env, chatId, { step: "service_draft", machine_id: machine.id, machine_name: machine.name, filters_changed: [], readings: null, photos: [], meter_photos: [] });
    await sendServiceDraftMenu(env, chatId, await getSession(env, chatId));
    return json({ ok: true });
  }

  if (action === "issue_start" && emp && machine) {
    await setSession(env, chatId, { step: "issue_text", machine_id: machine.id, photos: [] });
    await sendMessage(env, chatId, "⚠️ <b>Опишите проблему/поломку одним сообщением:</b>", { parse_mode: "HTML" });
    return json({ ok: true });
  }

  if (action === "code" && role === "owner") {
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    await env.DB.prepare("INSERT INTO employee_codes (code, owner_chat_id) VALUES (?, ?)").bind(code, chatId).run();
    return json({ code });
  }

  if (action === "add_task" && role === "owner" && machine) {
    const title = String(body.title || "").trim().slice(0, 300);
    const target = await env.DB.prepare("SELECT * FROM employees WHERE employee_chat_id = ? AND owner_chat_id = ?").bind(String(body.emp_id), chatId).first();
    if (!title || !target) return json({ error: "Неверные данные" }, 400);
    await env.DB.prepare("INSERT INTO employee_tasks (owner_chat_id, employee_chat_id, machine_id, machine_name, title) VALUES (?, ?, ?, ?, ?)").bind(chatId, target.employee_chat_id, machine.id, machine.name, title).run();
    await sendMessage(env, target.employee_chat_id, `📋 <b>Новое задание</b>\n🚰 ${machine.name}\n📝 ${title}`, { parse_mode: "HTML" });
    return json({ ok: true });
  }

  return json({ error: "Недоступно" }, 400);
}

const MINIAPP_HTML = "<!DOCTYPE html>\n<html lang=\"ru\"><head><meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">\n<title>Водомат Сервис</title>\n<script src=\"https://telegram.org/js/telegram-web-app.js\"></script>\n<style>\n:root{--bg:#eaf6ff;--card:#fff;--tx:#0b2a44;--hint:#5b7a93;--a1:#22c1ee;--a2:#2563eb;--low:#ef4444;--ok:#10b981;--sh:0 6px 18px rgba(37,99,235,.12);--line:#dcecf8}\n:root[data-t=dark]{--bg:#06141f;--card:#0e2a40;--tx:#e6f3ff;--hint:#84a6c0;--sh:0 6px 18px rgba(0,0,0,.35);--line:#17405e}\n*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}\nbody{margin:0;background:var(--bg);color:var(--tx);font:16px/1.4 -apple-system,system-ui,\"Segoe UI\",sans-serif;padding-bottom:30px}\n.hero{position:relative;overflow:hidden;background:linear-gradient(160deg,var(--a1),var(--a2));color:#fff;padding:calc(18px + env(safe-area-inset-top)) 18px 56px}\n.hero h1{margin:0;font-size:22px;display:flex;align-items:center;gap:10px}\n.hero .chip{display:inline-block;margin-top:8px;background:rgba(255,255,255,.22);backdrop-filter:blur(6px);border-radius:20px;padding:3px 12px;font-size:13px}\n.bub{position:absolute;border-radius:50%;background:rgba(255,255,255,.18);animation:up 7s infinite ease-in}\n.bub:nth-child(1){width:14px;height:14px;left:68%;bottom:-20px}.bub:nth-child(2){width:9px;height:9px;left:80%;bottom:-20px;animation-delay:2s}\n.bub:nth-child(3){width:20px;height:20px;left:88%;bottom:-20px;animation-delay:4s}.bub:nth-child(4){width:8px;height:8px;left:55%;bottom:-20px;animation-delay:1s}\n@keyframes up{to{transform:translateY(-130px);opacity:0}}\n.wave{position:absolute;left:0;bottom:-1px;width:200%;height:34px;animation:wv 9s linear infinite}\n@keyframes wv{to{transform:translateX(-50%)}}\n.wave path{fill:var(--bg)}\nmain{padding:0 14px;margin-top:-26px;position:relative}\nh2{margin:20px 4px 8px;font-size:13px;color:var(--hint);text-transform:uppercase;letter-spacing:.08em}\n.card{background:var(--card);border-radius:18px;padding:13px 15px;margin-bottom:10px;box-shadow:var(--sh);border:1px solid var(--line)}\n.row{display:flex;justify-content:space-between;align-items:center;gap:10px}\n.sub{color:var(--hint);font-size:14px}\n.mc{display:flex;gap:13px;align-items:center;cursor:pointer;transition:transform .12s}.mc:active{transform:scale(.97)}\n.mc svg{flex:none}.mc .t{flex:1;min-width:0}.mc b{display:block}\n.drop{background:linear-gradient(160deg,var(--a1),var(--a2));color:#fff;min-width:28px;height:28px;border-radius:50% 50% 50% 8px;transform:rotate(-45deg);display:grid;place-items:center}\n.drop i{transform:rotate(45deg);font-style:normal;font-size:13px;font-weight:700}\n.stats{display:flex;gap:10px;margin-bottom:10px}\n.stat{flex:1;border-radius:18px;padding:14px;color:#fff;background:linear-gradient(160deg,var(--a1),var(--a2));box-shadow:var(--sh)}\n.stat b{font-size:28px;display:block;line-height:1.1}.stat span{font-size:13px;opacity:.9}\nbutton,select,input{font:inherit;width:100%;border:0;border-radius:14px;padding:13px 14px;margin-top:9px}\nbutton{color:#fff;font-weight:600;background:linear-gradient(160deg,var(--a1),var(--a2));box-shadow:0 5px 14px rgba(37,99,235,.28);transition:transform .1s}\nbutton:active{transform:scale(.97)}button.alt{background:var(--card);color:var(--tx);box-shadow:none;border:1px solid var(--line)}button[disabled]{opacity:.55}\nselect,input{background:var(--bg);color:var(--tx);border:1px solid var(--line)}\n.bar{height:8px;border-radius:6px;background:var(--line);overflow:hidden;margin-top:8px}\n.bar i{display:block;height:100%;border-radius:6px;background:linear-gradient(90deg,var(--a1),var(--a2))}.bar.low i{background:linear-gradient(90deg,#f87171,var(--low))}\n.low{color:var(--low)}.code{font-size:30px;font-weight:800;letter-spacing:.14em;text-align:center;margin:4px 0;color:var(--a2)}\n.empty{text-align:center;color:var(--hint);padding:18px}\n#toast{position:fixed;left:16px;right:16px;bottom:calc(18px + env(safe-area-inset-bottom));background:#0b2a44;color:#fff;padding:13px;border-radius:14px;display:none;text-align:center;z-index:9}\n</style></head><body>\n<div class=\"hero\"><i class=\"bub\"></i><i class=\"bub\"></i><i class=\"bub\"></i><i class=\"bub\"></i>\n<h1><svg width=\"28\" height=\"28\" viewBox=\"0 0 24 24\"><path fill=\"#fff\" d=\"M12 2C12 2 5 10.2 5 15a7 7 0 0014 0C19 10.2 12 2 12 2z\"/></svg>Водомат Сервис</h1><span class=\"chip\" id=\"chip\">…</span>\n<svg class=\"wave\" viewBox=\"0 0 1200 34\" preserveAspectRatio=\"none\"><path d=\"M0 18 Q150 0 300 18 T600 18 T900 18 T1200 18 V34 H0Z\"/></svg></div>\n<main id=\"app\"><div class=\"empty\">Загрузка…</div></main><div id=\"toast\"></div>\n<script>\nconst tg=Telegram.WebApp;tg.ready();tg.expand();\ndocument.documentElement.dataset.t=tg.colorScheme===\"dark\"?\"dark\":\"light\";\ntry{tg.setHeaderColor(\"#22c1ee\");tg.setBackgroundColor(tg.colorScheme===\"dark\"?\"#06141f\":\"#eaf6ff\")}catch(e){}\nconst $=s=>document.querySelector(s);\nconst esc=s=>String(s==null?\"\":s).replace(/[&<>\"]/g,c=>({\"&\":\"&amp;\",\"<\":\"&lt;\",\">\":\"&gt;\",'\"':\"&quot;\"}[c]));\nfunction toast(t){const e=$(\"#toast\");e.textContent=t;e.style.display=\"block\";setTimeout(()=>e.style.display=\"none\",2200)}\nasync function api(a,d={}){\n  const r=await fetch(\"/api/\"+a,{method:\"POST\",headers:{\"Content-Type\":\"application/json\"},body:JSON.stringify({...d,initData:tg.initData})});\n  const j=await r.json().catch(()=>({error:\"Ошибка\"}));\n  if(!r.ok){const e=new Error(j.error||\"Ошибка\");e.reason=j.reason;throw e}return j;\n}\nconst VM='<svg width=\"42\" height=\"52\" viewBox=\"0 0 42 52\"><rect x=\"2\" y=\"1\" width=\"38\" height=\"50\" rx=\"8\" fill=\"var(--a2)\"/><rect x=\"7\" y=\"6\" width=\"28\" height=\"26\" rx=\"5\" fill=\"#fff\"/><path d=\"M7 21Q14 16 21 21T35 21V27a5 5 0 01-5 5H12a5 5 0 01-5-5Z\" fill=\"var(--a1)\"/><rect x=\"7\" y=\"37\" width=\"14\" height=\"8\" rx=\"3\" fill=\"rgba(255,255,255,.35)\"/><circle cx=\"31\" cy=\"41\" r=\"4\" fill=\"#fff\"/></svg>';\nlet S=null,view=\"home\",cur=null;\nconst WHY={no_init_data:\"Telegram не передал данные запуска. Откройте приложение кнопкой «📱 Приложение» в чате (она пришлёт сообщение с кнопкой) или командой /app.\",bad_hash:\"Не прошла проверка подписи: токен бота в воркере не совпадает с токеном этого бота.\",expired:\"Сессия устарела. Закройте и откройте приложение заново.\",no_token:\"В воркере не задан TELEGRAM_BOT_TOKEN.\"};\nasync function load(){try{S=await api(\"me\");render()}catch(e){$(\"#app\").innerHTML='<div class=\"card empty\">'+esc(e.message===\"unauthorized\"?(WHY[e.reason]||\"Откройте приложение из бота в Telegram.\")+\" [\"+(e.reason||\"?\")+\"]\":e.message)+'</div>'}}\nfunction render(){\n  if(S.role===\"none\"){$(\"#chip\").textContent=\"Нет доступа\";$(\"#app\").innerHTML='<div class=\"card empty\">Доступ не выдан.<br>Вернитесь в чат и введите код доступа.</div>';return}\n  $(\"#chip\").textContent=S.role===\"owner\"?\"👑 Владелец\":\"🛠 Сотрудник\";\n  tg.BackButton[view===\"home\"?\"hide\":\"show\"]();\n  if(view===\"machine\")return renderMachine();\n  S.role===\"owner\"?renderOwner():renderEmp();\n}\ntg.BackButton.onClick(()=>{view=\"home\";render()});\nfunction machines(){return S.machines.map(m=>{const n=S.tasks.filter(t=>t.machine_id===m.id).length;\n  return `<div class=\"card mc\" data-m=\"${esc(m.id)}\">${VM}<div class=\"t\"><b>${esc(m.name)}</b><span class=\"sub\">📍 ${esc(m.address||\"адрес не указан\")}</span></div>${n?`<div class=\"drop\"><i>${n}</i></div>`:\"\"}</div>`}).join(\"\")||'<div class=\"card empty\">Водоматов нет</div>'}\nfunction bindMachines(){document.querySelectorAll(\"[data-m]\").forEach(e=>e.onclick=()=>{cur=e.dataset.m;view=\"machine\";render();scrollTo(0,0)})}\nfunction renderEmp(){$(\"#app\").innerHTML=`<h2>Мои водоматы</h2>${machines()}`;bindMachines()}\nasync function renderMachine(){\n  const m=S.machines.find(x=>x.id===cur),ts=S.tasks.filter(t=>t.machine_id===cur);\n  $(\"#app\").innerHTML=`<div class=\"card mc\" style=\"cursor:default\">${VM}<div class=\"t\"><b>${esc(m.name)}</b><span class=\"sub\">📍 ${esc(m.address||\"\")}</span></div></div>\n  ${S.role===\"employee\"?`<button id=\"svc\">🔧 Начать обслуживание</button><button id=\"iss\" class=\"alt\">⚠️ Сообщить о поломке</button>`:\"\"}\n  <h2>Задания</h2>${ts.map(t=>`<div class=\"card\"><div>${esc(t.title)}</div><button data-done=\"${t.id}\">✅ Выполнено</button></div>`).join(\"\")||'<div class=\"card empty\">Заданий нет 💧</div>'}\n  <h2>История обслуживаний</h2><div id=\"hist\" class=\"sub\">Загрузка…</div>`;\n  document.querySelectorAll(\"[data-done]\").forEach(b=>b.onclick=async()=>{b.disabled=true;try{await api(\"task_done\",{id:b.dataset.done});S.tasks=S.tasks.filter(t=>String(t.id)!==b.dataset.done);toast(\"Готово ✅\");render()}catch(e){toast(e.message);b.disabled=false}});\n  const go=a=>async()=>{try{await api(a,{machine_id:cur});toast(\"Продолжите в чате с ботом\");setTimeout(()=>tg.close(),700)}catch(e){toast(e.message)}};\n  if($(\"#svc\")){$(\"#svc\").onclick=go(\"service_start\");$(\"#iss\").onclick=go(\"issue_start\")}\n  try{const h=await api(\"history\",{machine_id:cur});$(\"#hist\").innerHTML=h.rows.map(r=>`<div class=\"card\"><b>${esc(r.date)}</b> · ${esc(r.who)}<div class=\"sub\">${r.filters.length?\"🔧 \"+esc(r.filters.join(\", \")):\"Фильтры не менялись\"}</div></div>`).join(\"\")||'<div class=\"card empty\">Пока пусто</div>'}catch(e){$(\"#hist\").textContent=e.message}\n}\nfunction renderOwner(){\n  const low=S.stock.filter(s=>s.qty<=1);\n  $(\"#app\").innerHTML=`<div class=\"stats\"><div class=\"stat\"><b>${S.employees.length}</b><span>сотрудников</span></div><div class=\"stat\"><b>${S.tasks.length}</b><span>активных заданий</span></div></div>\n  <button id=\"code\">🔑 Создать код для сотрудника</button><div id=\"codeOut\"></div>\n  <h2>Водоматы</h2>${machines()}\n  <h2>Сотрудники</h2>${S.employees.map(e=>`<div class=\"card row\"><span>👷 ${esc(e.name)}</span><span class=\"sub\">водоматов: ${e.n}</span></div>`).join(\"\")||'<div class=\"card empty\">Пока никого нет</div>'}\n  ${S.employees.length&&S.machines.length?`<h2>Выдать задание</h2><div class=\"card\"><select id=\"te\">${S.employees.map(e=>`<option value=\"${esc(e.id)}\">${esc(e.name)}</option>`).join(\"\")}</select>\n  <select id=\"tm\">${S.machines.map(m=>`<option value=\"${esc(m.id)}\">${esc(m.name)}</option>`).join(\"\")}</select><input id=\"tt\" placeholder=\"Что нужно сделать\"><button id=\"tb\">Отправить задание</button></div>`:\"\"}\n  <h2>Склад фильтров</h2>${low.length?`<div class=\"card low\">⚠️ Заканчиваются: ${low.map(s=>esc(s.name)+\" (\"+s.qty+\")\").join(\", \")}</div>`:\"\"}\n  ${S.stock.map(s=>`<div class=\"card\"><div class=\"row\"><span>${esc(s.name)}<div class=\"sub\">${esc(s.machine)}</div></span><b class=\"${s.qty<=1?\"low\":\"\"}\">${s.qty} шт.</b></div><div class=\"bar ${s.qty<=1?\"low\":\"\"}\"><i style=\"width:${Math.max(4,Math.min(100,s.qty/12*100))}%\"></i></div></div>`).join(\"\")||'<div class=\"card empty\">Склад не заполнен</div>'}`;\n  bindMachines();\n  $(\"#code\").onclick=async()=>{try{const r=await api(\"code\");$(\"#codeOut\").innerHTML=`<div class=\"card\"><div class=\"sub\" style=\"text-align:center\">Код для сотрудника</div><div class=\"code\">${r.code}</div></div>`}catch(e){toast(e.message)}};\n  if($(\"#tb\"))$(\"#tb\").onclick=async()=>{const title=$(\"#tt\").value.trim();if(!title)return toast(\"Напишите задание\");\n    try{await api(\"add_task\",{emp_id:$(\"#te\").value,machine_id:$(\"#tm\").value,title});toast(\"Задание отправлено 💧\");load()}catch(e){toast(e.message)}};\n}\nload();\n</script></body></html>\n";
