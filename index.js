/**
 * Telegram-бот для СОТРУДНИКОВ и ВЛАДЕЛЬЦЕВ (3-й Worker)
 * Работает с той же базой Cloudflare D1 (DB), что и основной бот.
 * 
 * ФУНКЦИОНАЛ И УЧЁТ ФИЛЬТРОВ И ОПЕРАЦИЙ:
 * - Учёт годового комплекта фильтров (12x 5мкр, 6x 1мкр, 1x Уголь 5.2кг, 2x Мембраны, 2x Постуголь, 2x Минерализатор, 1x УФ лампа);
 * - Авто-списание со склада при замене фильтра + предупреждения о закупке;
 * - Ввод показаний (вода, свет) + ОБЯЗАТЕЛЬНОЕ фото счётчиков;
 * - Общий фотоотчёт выполненной работы;
 * - Выдача, выполнение и отзыв заданий;
 * - Привязка и увольнение сотрудников;
 * - Уведомления владельца с фотографиями.
 */

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("ok — этот адрес принимает только Telegram webhook", { status: 200 });
    }
    const secretHeader = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (secretHeader !== env.TELEGRAM_WEBHOOK_SECRET) {
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

  if (text.startsWith("/start")) {
    await clearSession(env, chatId);
    
    const emp = await getEmployee(env, chatId);
    const isOwner = await isOwnerInMainDb(env, chatId);

    if (emp) {
      await sendEmployeeMainMenu(env, chatId, emp);
      return;
    }

    if (isOwner) {
      await sendOwnerMainMenu(env, chatId);
      return;
    }

    await sendMessage(env, chatId, 
      "👋 <b>Приветствуем в боте управления и обслуживания водоматов!</b>\n\n" +
      "Выберите вашу роль:", 
      {
        parse_mode: "HTML",
        inline_keyboard: [
          [{ text: "👑 Я Владелец", callback_data: "role:owner" }],
          [{ text: "🔗 Я Сотрудник (Ввести код)", callback_data: "role:employee" }]
        ]
      }
    );
    return;
  }

  if (session) {
    if (session.step === "enter_code") {
      await processEmployeeCode(env, chatId, text, message.from.first_name || "Сотрудник");
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

      const emp = await getEmployee(env, empChatId);
      await clearSession(env, chatId);

      await sendMessage(env, chatId, `✅ Задание для ${emp ? emp.name : "сотрудника"} создано!`, {
        inline_keyboard: [[{ text: "🔙 Назад в меню", callback_data: "owner:menu" }]]
      });

      try {
        await sendMessage(env, empChatId, 
          `📋 <b>Вам выдано новое задание!</b>\n\n` +
          `🚰 Водомат: <b>${machineName}</b>\n` +
          `📝 Задание: ${text}`,
          { parse_mode: "HTML" }
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

  await sendMessage(env, chatId, "Нажмите /start или выберите действие в меню.");
}

// ============================================================
// Обработка Callback-кнопок
// ============================================================

async function handleCallback(callback, env) {
  await ensureEmployeeTables(env);
  const chatId = String(callback.message.chat.id);
  const messageId = callback.message.message_id;
  const data = callback.data || "";

  const edit = (text, keyboard) => editMessageText(env, chatId, messageId, text, { parse_mode: "HTML", inline_keyboard: keyboard });

  if (data === "role:owner") {
    await answerCallback(env, callback.id);
    const isOwner = await isOwnerInMainDb(env, chatId);
    if (!isOwner) {
      await edit("⚠️ Вы не найдены как владелец в основном боте @GnedovVodomat_bot. Добавьте сначала хотя бы 1 водомат там.", []);
      return;
    }
    await sendOwnerMainMenu(env, chatId, messageId);
    return;
  }

  if (data === "role:employee") {
    await answerCallback(env, callback.id);
    await setSession(env, chatId, { step: "enter_code" });
    await edit("🔑 <b>Введите 6-значный код подключения</b>, полученный от вашего руководителя:", []);
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
      await edit("У вас пока нет заведённых водоматов.", [[{ text: "🔙 Назад", callback_data: "owner:menu" }]]);
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
// Вспомогательные функции взаимодействия
// ============================================================

async function processEmployeeCode(env, chatId, code, defaultName) {
  const row = await env.DB.prepare("SELECT owner_chat_id FROM employee_codes WHERE code = ?").bind(code).first();
  if (!row) {
    await sendMessage(env, chatId, "❌ Неверный код подключения. Перепроверьте код и введите снова:");
    return;
  }

  await env.DB.prepare(
    `INSERT INTO employees (employee_chat_id, owner_chat_id, name, assigned_machines)
     VALUES (?, ?, ?, '[]')
     ON CONFLICT(employee_chat_id) DO UPDATE SET owner_chat_id = excluded.owner_chat_id`
  ).bind(chatId, row.owner_chat_id, defaultName).run();

  await env.DB.prepare("DELETE FROM employee_codes WHERE code = ?").bind(code).run();
  await clearSession(env, chatId);

  await sendMessage(env, chatId, "✅ <b>Вы успешно подключены к владельцу!</b>\n\nОжидайте, пока владелец назначит вам доступ к водоматам.");

  await sendNotificationToOwner(
    env, row.owner_chat_id,
    `👷 <b>Новый сотрудник подключился!</b>\n\nИмя: ${defaultName}\nНазначьте ему водоматы в меню «👷 Сотрудники».`
  );
}

async function finalizeIssueReport(env, chatId, session) {
  const emp = await getEmployee(env, chatId);
  const mainUser = await getMainDbUser(env, emp.owner_chat_id);
  const machine = (mainUser.machines || []).find(m => m.id === session.machine_id);

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
  await clearSession(env, chatId);
  await sendMessage(env, chatId, "✅ Сообщение о проблеме отправлено владельцу.");
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
    await sendMessage(env, chatId, text, { parse_mode: "HTML", inline_keyboard: keyboard });
  }
}

async function sendEmployeeMainMenu(env, chatId, emp, editMessageId) {
  const mainUser = await getMainDbUser(env, emp.owner_chat_id);
  const assignedIds = new Set(JSON.parse(emp.assigned_machines || "[]"));
  const machines = (mainUser.machines || []).filter(m => assignedIds.has(m.id));

  if (!machines.length) {
    const txt = "🚰 <b>Вам пока не назначено ни одного водомата.</b>\nОбратитесь к руководителю.";
    if (editMessageId) await editMessageText(env, chatId, editMessageId, txt, { parse_mode: "HTML" });
    else await sendMessage(env, chatId, txt, { parse_mode: "HTML" });
    return;
  }

  const rows = machines.map(m => [{ text: `🚰 ${m.name}`, callback_data: `emp:m:${m.id}` }]);
  const txt = "🚰 <b>Ваши назначенные водоматы:</b>";

  if (editMessageId) await editMessageText(env, chatId, editMessageId, txt, { parse_mode: "HTML", inline_keyboard: rows });
  else await sendMessage(env, chatId, txt, { parse_mode: "HTML", inline_keyboard: rows });
}

async function sendServiceDraftMenu(env, chatId, session, editMessageId) {
  const emp = await getEmployee(env, chatId);
  const mainUser = await getMainDbUser(env, emp.owner_chat_id);
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
// Взаимодействие с основной D1 базой и уведомления
// ============================================================

async function getMainDbUser(env, chatId) {
  const row = await env.DB.prepare("SELECT data FROM users WHERE chat_id = ?").bind(String(chatId)).first();
  return row ? JSON.parse(row.data) : { machines: [] };
}

async function updateMainDbUser(env, chatId, userObj) {
  await env.DB.prepare(
    "UPDATE users SET data = ?, updated_at = CURRENT_TIMESTAMP WHERE chat_id = ?"
  ).bind(JSON.stringify(userObj), String(chatId)).run();
}

async function isOwnerInMainDb(env, chatId) {
  const row = await env.DB.prepare("SELECT 1 FROM users WHERE chat_id = ?").bind(String(chatId)).first();
  return !!row;
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
