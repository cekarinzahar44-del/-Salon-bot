// server.js — Beauty Salon Booking Bot
// Многопользовательский бот записи в салон красоты
// Технологии: Telegraf + PostgreSQL + node-cron

// ════════ АВТО-УСТАНОВКА ЗАВИСИМОСТЕЙ ════════
const { execSync } = require('child_process');
const requiredDeps = ['telegraf', 'pg', 'node-cron'];
const missing = [];
for (const dep of requiredDeps) {
  try { require.resolve(dep); } catch { missing.push(dep); }
}
if (missing.length > 0) {
  console.log(`📦 Не хватает: ${missing.join(', ')} — устанавливаю...`);
  try {
    execSync(`npm install --no-audit --no-fund --save ${missing.join(' ')}`, {
      stdio: 'inherit', cwd: __dirname
    });
    Object.keys(require.cache).forEach(k => delete require.cache[k]);
    console.log('✅ Установлено');
  } catch (e) {
    console.error('❌ Установка упала:', e.message);
    process.exit(1);
  }
}

// ════════ ИМПОРТЫ ════════
const { Telegraf, Markup } = require('telegraf');
const { Pool } = require('pg');
const cron = require('node-cron');

// ════════ КОНФИГ ════════
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => parseInt(s.trim())).filter(Boolean);
const SALON_NAME = process.env.SALON_NAME || 'Beauty Studio';
const TIMEZONE = process.env.TIMEZONE || 'Europe/Moscow';

if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN не задан. Задай переменную в BotHost.');
  process.exit(1);
}

// ════════ POSTGRES ════════
let pool = null;

async function initDB() {
  if (!process.env.DB_HOST || !process.env.DB_USER) {
    console.warn('⚠️ Реквизиты БД не заданы (DB_HOST, DB_USER, DB_PASSWORD, DB_NAME). Бот без БД не работает.');
    return false;
  }
  try {
    pool = new Pool({
      host: process.env.DB_HOST,
      port: process.env.DB_PORT || 5432,
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      ssl: false
    });
    const client = await pool.connect();
    console.log('✅ PostgreSQL подключён');
    client.release();
    await createTables();
    await seedInitialData();
    return true;
  } catch (e) {
    console.error('❌ Ошибка подключения к БД:', e.message);
    pool = null;
    return false;
  }
}

async function createTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT UNIQUE NOT NULL,
      name TEXT,
      phone TEXT,
      username TEXT,
      role TEXT DEFAULT 'client',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS masters (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      specialty TEXT,
      bio TEXT,
      photo_url TEXT,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS services (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT,
      duration_min INTEGER NOT NULL,
      price DECIMAL(10,2) NOT NULL,
      description TEXT,
      is_active BOOLEAN DEFAULT true
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS master_services (
      master_id INTEGER REFERENCES masters(id) ON DELETE CASCADE,
      service_id INTEGER REFERENCES services(id) ON DELETE CASCADE,
      PRIMARY KEY (master_id, service_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schedules (
      id SERIAL PRIMARY KEY,
      master_id INTEGER REFERENCES masters(id) ON DELETE CASCADE,
      day_of_week INTEGER NOT NULL,
      open_time TIME NOT NULL,
      close_time TIME NOT NULL,
      UNIQUE(master_id, day_of_week)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS blocked_slots (
      id SERIAL PRIMARY KEY,
      master_id INTEGER REFERENCES masters(id) ON DELETE CASCADE,
      start_time TIMESTAMP NOT NULL,
      end_time TIMESTAMP NOT NULL,
      reason TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS appointments (
      id SERIAL PRIMARY KEY,
      user_id BIGINT REFERENCES users(telegram_id),
      master_id INTEGER REFERENCES masters(id),
      service_id INTEGER REFERENCES services(id),
      start_time TIMESTAMP NOT NULL,
      end_time TIMESTAMP NOT NULL,
      status TEXT DEFAULT 'confirmed',
      client_name TEXT,
      client_phone TEXT,
      comment TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notifications_sent (
      id SERIAL PRIMARY KEY,
      appointment_id INTEGER REFERENCES appointments(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(appointment_id, type)
    )
  `);
  console.log('✅ Таблицы созданы');
}

async function seedInitialData() {
  const { rows: masters } = await pool.query('SELECT COUNT(*) FROM masters');
  if (parseInt(masters[0].count) === 0) {
    console.log('📝 Заполняю демо-данные...');
    // Мастера
    const m1 = await pool.query(`INSERT INTO masters (name, specialty, bio) VALUES ($1, $2, $3) RETURNING id`,
      ['Анна', 'Мастер маникюра', 'Опыт 8 лет. Специализация: nail-art, гель-лак, наращивание']);
    const m2 = await pool.query(`INSERT INTO masters (name, specialty, bio) VALUES ($1, $2, $3) RETURNING id`,
      ['Мария', 'Парикмахер-стилист', 'Опыт 12 лет. Колорист, специалист по сложным окрашиваниям']);
    const m3 = await pool.query(`INSERT INTO masters (name, specialty, bio) VALUES ($1, $2, $3) RETURNING id`,
      ['Елена', 'Косметолог', 'Опыт 6 лет. Чистки, пилинги, уходовые процедуры']);
    const m4 = await pool.query(`INSERT INTO masters (name, specialty, bio) VALUES ($1, $2, $3) RETURNING id`,
      ['Ольга', 'Бровист и lash-мастер', 'Опыт 5 лет. Окрашивание, ламинирование, наращивание ресниц']);
    const masterIds = [m1.rows[0].id, m2.rows[0].id, m3.rows[0].id, m4.rows[0].id];

    // Услуги
    const services = [
      ['Маникюр классический', 'nails', 60, 1500, 'Обрезной маникюр без покрытия'],
      ['Маникюр + гель-лак', 'nails', 90, 2500, 'Маникюр с покрытием гель-лак'],
      ['Наращивание ногтей', 'nails', 150, 3500, 'Гелевое наращивание + дизайн'],
      ['Педикюр', 'nails', 90, 2200, 'Аппаратный педикюр'],
      ['Женская стрижка', 'hair', 60, 2000, 'Мытьё, стрижка, укладка'],
      ['Окрашивание в один тон', 'hair', 120, 4500, 'Краска включена'],
      ['Сложное окрашивание', 'hair', 240, 9000, 'Балаяж, шатуш, мелирование'],
      ['Чистка лица', 'face', 90, 3000, 'Механическая чистка + маска'],
      ['Пилинг', 'face', 60, 2500, 'Химический пилинг'],
      ['Окрашивание бровей', 'brows', 30, 800, 'Краска или хна'],
      ['Ламинирование ресниц', 'brows', 60, 2000, 'Длительный эффект до 8 недель'],
      ['Наращивание ресниц 2D', 'brows', 120, 2500, 'Классическое наращивание']
    ];
    const serviceIds = [];
    for (const s of services) {
      const r = await pool.query(`INSERT INTO services (name, category, duration_min, price, description) VALUES ($1,$2,$3,$4,$5) RETURNING id`, s);
      serviceIds.push(r.rows[0].id);
    }

    // Связь мастер-услуги: Анна - ногти(0-3), Мария - волосы(4-6), Елена - лицо(7-8), Ольга - брови(9-11)
    const links = [
      [m1.rows[0].id, [0,1,2,3]],
      [m2.rows[0].id, [4,5,6]],
      [m3.rows[0].id, [7,8]],
      [m4.rows[0].id, [9,10,11]]
    ];
    for (const [mid, sIdxs] of links) {
      for (const idx of sIdxs) {
        await pool.query(`INSERT INTO master_services (master_id, service_id) VALUES ($1,$2)`, [mid, serviceIds[idx]]);
      }
    }

    // График работы: все мастера Пн-Сб 10:00-20:00, Вс выходной
    for (const mid of masterIds) {
      for (let d = 1; d <= 6; d++) {
        await pool.query(`INSERT INTO schedules (master_id, day_of_week, open_time, close_time) VALUES ($1,$2,$3,$4)`,
          [mid, d, '10:00', '20:00']);
      }
    }

    // Назначаем админов
    for (const adminId of ADMIN_IDS) {
      await pool.query(`INSERT INTO users (telegram_id, name, role) VALUES ($1, 'Admin', 'admin') ON CONFLICT (telegram_id) DO UPDATE SET role = 'admin'`, [adminId]);
    }

    console.log('✅ Демо-данные созданы (4 мастера, 12 услуг)');
  }
}

// ════════ ХЕЛПЕРЫ ════════
function formatMoscow(date) {
  return new Date(date).toLocaleString('ru-RU', { timeZone: TIMEZONE });
}
function fmtDate(date) {
  const d = new Date(date);
  return d.toLocaleDateString('ru-RU', { timeZone: TIMEZONE, day: '2-digit', month: 'long', weekday: 'long' });
}
function fmtTime(date) {
  return new Date(date).toLocaleTimeString('ru-RU', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit' });
}
function fmtPrice(n) {
  return new Intl.NumberFormat('ru-RU').format(parseFloat(n)) + ' ₽';
}

async function ensureUser(ctx) {
  const id = ctx.from.id;
  const name = ctx.from.first_name || 'Гость';
  const username = ctx.from.username || null;
  await pool.query(
    `INSERT INTO users (telegram_id, name, username) VALUES ($1, $2, $3)
     ON CONFLICT (telegram_id) DO UPDATE SET name = COALESCE(users.name, EXCLUDED.name)`,
    [id, name, username]
  );
  const { rows } = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [id]);
  return rows[0];
}

function isAdmin(telegramId) {
  return ADMIN_IDS.includes(telegramId);
}

// ════════ FSM (состояния пользователя в памяти) ════════
const userState = new Map();
function setState(userId, state) { userState.set(userId, state); }
function getState(userId) { return userState.get(userId) || {}; }
function clearState(userId) { userState.delete(userId); }

// ════════ BOT ════════
const bot = new Telegraf(BOT_TOKEN);

// Главное меню клиента
function mainMenu(isAdminUser) {
  const buttons = [
    [Markup.button.callback('📅 Записаться', 'BOOK_START')],
    [Markup.button.callback('📋 Мои записи', 'MY_APPTS'), Markup.button.callback('💆 Мастера', 'SHOW_MASTERS')],
    [Markup.button.callback('💅 Услуги', 'SHOW_SERVICES'), Markup.button.callback('ℹ️ О салоне', 'SHOW_INFO')]
  ];
  if (isAdminUser) buttons.push([Markup.button.callback('⚙️ Админка', 'ADMIN_MENU')]);
  return Markup.inlineKeyboard(buttons);
}

bot.start(async (ctx) => {
  if (!pool) return ctx.reply('⚠️ Бот пока не готов. Попробуйте через минуту.');
  await ensureUser(ctx);
  const text =
    `✨ *Добро пожаловать в ${SALON_NAME}!*\n\n` +
    `Я помогу записаться к нашим мастерам. Выбери что нужно:`;
  return ctx.replyWithMarkdown(text, mainMenu(isAdmin(ctx.from.id)));
});

bot.command('menu', async (ctx) => {
  if (!pool) return;
  await ensureUser(ctx);
  return ctx.reply('Главное меню:', mainMenu(isAdmin(ctx.from.id)));
});

// ════════ ИНФО О САЛОНЕ ════════
bot.action('SHOW_INFO', async (ctx) => {
  await ctx.answerCbQuery();
  const text =
    `🏛 *${SALON_NAME}*\n\n` +
    `📍 *Адрес:* Москва, ул. Примерная, 1\n` +
    `⏰ *График:* Пн–Сб 10:00–20:00, Вс выходной\n` +
    `📞 *Телефон:* +7 (495) 123-45-67\n` +
    `💌 *Email:* hello@${SALON_NAME.toLowerCase().replace(/\s+/g,'')}.ru\n\n` +
    `Мы используем только профессиональную косметику и работаем с лучшими мастерами города.`;
  return ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([
    [Markup.button.callback('← Назад', 'MAIN_MENU')]
  ])});
});

// ════════ СПИСОК МАСТЕРОВ ════════
bot.action('SHOW_MASTERS', async (ctx) => {
  await ctx.answerCbQuery();
  const { rows } = await pool.query('SELECT * FROM masters WHERE is_active = true ORDER BY id');
  let text = `💆 *Наши мастера* (${rows.length}):\n\n`;
  for (const m of rows) {
    text += `*${m.name}* — _${m.specialty}_\n${m.bio}\n\n`;
  }
  return ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([
    [Markup.button.callback('📅 Записаться', 'BOOK_START')],
    [Markup.button.callback('← Назад', 'MAIN_MENU')]
  ])});
});

// ════════ СПИСОК УСЛУГ ════════
bot.action('SHOW_SERVICES', async (ctx) => {
  await ctx.answerCbQuery();
  const { rows } = await pool.query(`
    SELECT s.*, COUNT(ms.master_id) as masters_count
    FROM services s
    LEFT JOIN master_services ms ON ms.service_id = s.id
    WHERE s.is_active = true
    GROUP BY s.id
    ORDER BY s.category, s.price
  `);
  const byCat = {};
  for (const s of rows) {
    if (!byCat[s.category]) byCat[s.category] = [];
    byCat[s.category].push(s);
  }
  const catNames = { nails: '💅 Ногти', hair: '💇 Волосы', face: '✨ Лицо', brows: '👁 Брови и ресницы' };
  let text = `💋 *Прайс-лист*\n\n`;
  for (const cat in byCat) {
    text += `${catNames[cat] || cat}\n`;
    for (const s of byCat[cat]) {
      text += `• ${s.name} — ${fmtPrice(s.price)} _(${s.duration_min} мин)_\n`;
    }
    text += '\n';
  }
  return ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([
    [Markup.button.callback('📅 Записаться', 'BOOK_START')],
    [Markup.button.callback('← Назад', 'MAIN_MENU')]
  ])});
});

bot.action('MAIN_MENU', async (ctx) => {
  await ctx.answerCbQuery();
  clearState(ctx.from.id);
  return ctx.editMessageText(`✨ *${SALON_NAME}*\n\nВыбери что нужно:`, {
    parse_mode: 'Markdown', ...mainMenu(isAdmin(ctx.from.id))
  });
});

// ════════ ЗАПИСЬ: ШАГ 1 — Выбор категории ════════
bot.action('BOOK_START', async (ctx) => {
  await ctx.answerCbQuery();
  clearState(ctx.from.id);
  const text = `📅 *Запись*\n\nШаг 1 из 5 — выбери категорию услуг:`;
  return ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([
    [Markup.button.callback('💅 Ногти', 'CAT_nails'), Markup.button.callback('💇 Волосы', 'CAT_hair')],
    [Markup.button.callback('✨ Лицо', 'CAT_face'), Markup.button.callback('👁 Брови/ресницы', 'CAT_brows')],
    [Markup.button.callback('← В меню', 'MAIN_MENU')]
  ])});
});

// ШАГ 2 — Выбор услуги
bot.action(/^CAT_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const cat = ctx.match[1];
  const { rows } = await pool.query(`SELECT * FROM services WHERE category = $1 AND is_active = true ORDER BY price`, [cat]);
  if (!rows.length) {
    return ctx.editMessageText('В этой категории нет услуг.', Markup.inlineKeyboard([
      [Markup.button.callback('← Назад', 'BOOK_START')]
    ]));
  }
  const buttons = rows.map(s => [Markup.button.callback(`${s.name} — ${fmtPrice(s.price)}`, `SVC_${s.id}`)]);
  buttons.push([Markup.button.callback('← Назад', 'BOOK_START')]);
  return ctx.editMessageText(`📅 *Запись*\n\nШаг 2 из 5 — выбери услугу:`, {
    parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons)
  });
});

// ШАГ 3 — Выбор мастера
bot.action(/^SVC_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const serviceId = parseInt(ctx.match[1]);
  const { rows: sRows } = await pool.query('SELECT * FROM services WHERE id = $1', [serviceId]);
  if (!sRows.length) return ctx.editMessageText('Услуга не найдена');
  const service = sRows[0];
  const { rows: mRows } = await pool.query(`
    SELECT m.* FROM masters m
    JOIN master_services ms ON ms.master_id = m.id
    WHERE ms.service_id = $1 AND m.is_active = true
    ORDER BY m.id
  `, [serviceId]);
  if (!mRows.length) {
    return ctx.editMessageText('Нет мастеров для этой услуги', Markup.inlineKeyboard([
      [Markup.button.callback('← Назад', `CAT_${service.category}`)]
    ]));
  }
  setState(ctx.from.id, { serviceId, service });
  const buttons = mRows.map(m => [Markup.button.callback(`${m.name} (${m.specialty})`, `MST_${m.id}`)]);
  if (mRows.length > 1) buttons.unshift([Markup.button.callback('🎲 Любой мастер', `MST_any`)]);
  buttons.push([Markup.button.callback('← Назад', `CAT_${service.category}`)]);
  return ctx.editMessageText(
    `📅 *Запись*\n\nУслуга: ${service.name}\nЦена: ${fmtPrice(service.price)}\nДлительность: ${service.duration_min} мин\n\nШаг 3 из 5 — выбери мастера:`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
  );
});

// ШАГ 4 — Выбор даты
bot.action(/^MST_(\w+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const state = getState(ctx.from.id);
  if (!state.serviceId) return ctx.editMessageText('Сессия истекла, начни заново /start');
  const masterId = ctx.match[1] === 'any' ? null : parseInt(ctx.match[1]);
  state.masterId = masterId;
  setState(ctx.from.id, state);
  return showDatePicker(ctx, state);
});

async function showDatePicker(ctx, state) {
  const today = new Date();
  const tzOffset = getTzOffset();
  // Берём 14 дней вперёд
  const dates = [];
  for (let i = 0; i < 14; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    dates.push(d);
  }
  // Группируем по 3 в ряд
  const buttons = [];
  for (let i = 0; i < dates.length; i += 3) {
    const row = dates.slice(i, i + 3).map(d => {
      const day = d.getDate();
      const month = d.toLocaleString('ru-RU', { month: 'short' });
      const wd = d.toLocaleString('ru-RU', { weekday: 'short' });
      const iso = d.toISOString().split('T')[0];
      return Markup.button.callback(`${wd} ${day}`, `DATE_${iso}`);
    });
    buttons.push(row);
  }
  buttons.push([Markup.button.callback('← Назад', `SVC_${state.serviceId}`)]);
  let masterText = '';
  if (state.masterId) {
    const { rows } = await pool.query('SELECT name FROM masters WHERE id = $1', [state.masterId]);
    masterText = rows[0] ? `Мастер: ${rows[0].name}\n` : '';
  } else {
    masterText = 'Мастер: любой\n';
  }
  return ctx.editMessageText(
    `📅 *Запись*\n\nУслуга: ${state.service.name}\n${masterText}\nШаг 4 из 5 — выбери день:`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
  );
}

function getTzOffset() {
  // Москва = UTC+3
  return 3;
}

// ШАГ 5 — Выбор времени
bot.action(/^DATE_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const state = getState(ctx.from.id);
  if (!state.serviceId) return ctx.editMessageText('Сессия истекла, /start');
  const dateStr = ctx.match[1];
  state.date = dateStr;
  setState(ctx.from.id, state);

  const slots = await calculateAvailableSlots(state.masterId, state.serviceId, dateStr);
  if (!slots.length) {
    return ctx.editMessageText(
      `На ${dateStr} нет свободных слотов. Выбери другой день.`,
      Markup.inlineKeyboard([[Markup.button.callback('← Назад к датам', 'BACK_TO_DATE')]])
    );
  }

  // Сгруппируем по утро/день/вечер для удобства
  const buttons = [];
  let row = [];
  for (const slot of slots) {
    row.push(Markup.button.callback(slot.time, `SLOT_${slot.masterId}_${slot.time}`));
    if (row.length === 4) { buttons.push(row); row = []; }
  }
  if (row.length) buttons.push(row);
  buttons.push([Markup.button.callback('← Назад', 'BACK_TO_DATE')]);

  const dateObj = new Date(dateStr + 'T12:00:00');
  return ctx.editMessageText(
    `📅 *Запись*\n\nДата: ${fmtDate(dateObj)}\n\nШаг 5 из 5 — выбери время (доступно ${slots.length} слотов):`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
  );
});

bot.action('BACK_TO_DATE', async (ctx) => {
  await ctx.answerCbQuery();
  const state = getState(ctx.from.id);
  if (!state.serviceId) return ctx.editMessageText('Сессия истекла, /start');
  return showDatePicker(ctx, state);
});

// Расчёт свободных слотов
async function calculateAvailableSlots(masterId, serviceId, dateStr) {
  const { rows: sRows } = await pool.query('SELECT duration_min FROM services WHERE id = $1', [serviceId]);
  if (!sRows.length) return [];
  const duration = sRows[0].duration_min;
  const dayOfWeek = new Date(dateStr + 'T12:00:00').getDay(); // 0=вс, 6=сб

  // Получаем мастеров для услуги
  let masterIds = [];
  if (masterId) {
    masterIds = [masterId];
  } else {
    const { rows } = await pool.query(`
      SELECT m.id FROM masters m JOIN master_services ms ON ms.master_id = m.id
      WHERE ms.service_id = $1 AND m.is_active = true
    `, [serviceId]);
    masterIds = rows.map(r => r.id);
  }

  const slots = [];
  for (const mid of masterIds) {
    // График мастера на этот день
    const { rows: schedRows } = await pool.query(
      'SELECT open_time, close_time FROM schedules WHERE master_id = $1 AND day_of_week = $2',
      [mid, dayOfWeek]
    );
    if (!schedRows.length) continue; // выходной
    const sched = schedRows[0];

    // Существующие записи мастера на день
    const dayStart = `${dateStr} 00:00:00`;
    const dayEnd = `${dateStr} 23:59:59`;
    const { rows: apps } = await pool.query(
      `SELECT start_time, end_time FROM appointments
       WHERE master_id = $1 AND status = 'confirmed'
       AND start_time >= $2 AND start_time < $3
       ORDER BY start_time`,
      [mid, dayStart, dayEnd]
    );
    const { rows: blocks } = await pool.query(
      `SELECT start_time, end_time FROM blocked_slots
       WHERE master_id = $1
       AND start_time < $3 AND end_time > $2`,
      [mid, dayStart, dayEnd]
    );
    const busy = [...apps, ...blocks].map(b => ({
      start: new Date(b.start_time),
      end: new Date(b.end_time)
    }));

    // Генерируем слоты по 30 мин
    const [openH, openM] = sched.open_time.split(':').map(Number);
    const [closeH, closeM] = sched.close_time.split(':').map(Number);
    const dayDate = new Date(dateStr + 'T00:00:00');
    const openDate = new Date(dayDate);
    openDate.setHours(openH, openM, 0, 0);
    const closeDate = new Date(dayDate);
    closeDate.setHours(closeH, closeM, 0, 0);

    const now = new Date();
    const STEP = 30; // мин
    let slot = new Date(openDate);
    while (slot < closeDate) {
      const slotEnd = new Date(slot.getTime() + duration * 60000);
      if (slotEnd > closeDate) break;
      // Пропускаем если уже прошло
      if (slot.getTime() < now.getTime() + 60 * 60000) {
        slot = new Date(slot.getTime() + STEP * 60000);
        continue;
      }
      // Проверяем не пересекается с занятыми
      const conflict = busy.some(b => slot < b.end && slotEnd > b.start);
      if (!conflict) {
        const hh = String(slot.getHours()).padStart(2, '0');
        const mm = String(slot.getMinutes()).padStart(2, '0');
        slots.push({ masterId: mid, time: `${hh}:${mm}`, dateTime: new Date(slot) });
      }
      slot = new Date(slot.getTime() + STEP * 60000);
    }
  }
  // Если "любой" — отсортируем по времени, оставим уникальные времена
  const seen = new Set();
  const unique = [];
  for (const s of slots.sort((a, b) => a.dateTime - b.dateTime)) {
    if (!seen.has(s.time)) {
      seen.add(s.time);
      unique.push(s);
    }
  }
  return unique;
}

// Подтверждение записи
bot.action(/^SLOT_(\d+)_(\d{2}:\d{2})$/, async (ctx) => {
  await ctx.answerCbQuery();
  const state = getState(ctx.from.id);
  if (!state.serviceId) return ctx.editMessageText('Сессия истекла, /start');
  const masterId = parseInt(ctx.match[1]);
  const time = ctx.match[2];
  state.masterId = masterId;
  state.time = time;
  setState(ctx.from.id, state);

  const { rows: mRows } = await pool.query('SELECT * FROM masters WHERE id = $1', [masterId]);
  const master = mRows[0];

  const text =
    `📋 *Подтверждение записи*\n\n` +
    `📅 *Дата:* ${fmtDate(new Date(state.date + 'T12:00:00'))}\n` +
    `⏰ *Время:* ${time}\n` +
    `💆 *Мастер:* ${master.name}\n` +
    `✂️ *Услуга:* ${state.service.name}\n` +
    `💰 *Цена:* ${fmtPrice(state.service.price)}\n` +
    `⏱ *Длительность:* ${state.service.duration_min} мин\n\n` +
    `Подтверди запись или введи имя и телефон если нужно изменить:`;
  return ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([
    [Markup.button.callback('✅ Подтвердить', 'CONFIRM_BOOK')],
    [Markup.button.callback('📝 Указать имя/телефон', 'EDIT_CONTACT')],
    [Markup.button.callback('❌ Отменить', 'MAIN_MENU')]
  ])});
});

bot.action('EDIT_CONTACT', async (ctx) => {
  await ctx.answerCbQuery();
  const state = getState(ctx.from.id);
  state.awaitingContact = true;
  setState(ctx.from.id, state);
  return ctx.editMessageText(
    'Напиши имя и телефон одним сообщением.\nНапример: `Анна, +79991234567`',
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([
      [Markup.button.callback('← Назад', 'BACK_TO_CONFIRM')]
    ])}
  );
});

bot.action('BACK_TO_CONFIRM', async (ctx) => {
  await ctx.answerCbQuery();
  const state = getState(ctx.from.id);
  state.awaitingContact = false;
  setState(ctx.from.id, state);
  return ctx.editMessageText('Запись готова к подтверждению.', Markup.inlineKeyboard([
    [Markup.button.callback('✅ Подтвердить', 'CONFIRM_BOOK')],
    [Markup.button.callback('❌ Отменить', 'MAIN_MENU')]
  ]));
});

bot.action('CONFIRM_BOOK', async (ctx) => {
  await ctx.answerCbQuery();
  const state = getState(ctx.from.id);
  if (!state.serviceId || !state.masterId || !state.time || !state.date) {
    return ctx.editMessageText('Сессия истекла, начни заново /start');
  }

  const startTime = new Date(`${state.date}T${state.time}:00`);
  const endTime = new Date(startTime.getTime() + state.service.duration_min * 60000);

  // Финальная проверка конфликта (на случай гонки)
  const { rows: conflict } = await pool.query(`
    SELECT id FROM appointments
    WHERE master_id = $1 AND status = 'confirmed'
    AND start_time < $3 AND end_time > $2
  `, [state.masterId, startTime, endTime]);
  if (conflict.length) {
    return ctx.editMessageText(
      '😔 К сожалению, это время только что заняли. Попробуй выбрать другой слот.',
      Markup.inlineKeyboard([[Markup.button.callback('📅 Выбрать заново', 'BOOK_START')]])
    );
  }

  const user = await ensureUser(ctx);
  const clientName = state.contactName || user.name;
  const clientPhone = state.contactPhone || user.phone || '';

  const { rows: insRes } = await pool.query(`
    INSERT INTO appointments (user_id, master_id, service_id, start_time, end_time, client_name, client_phone)
    VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id
  `, [ctx.from.id, state.masterId, state.serviceId, startTime, endTime, clientName, clientPhone]);
  const apptId = insRes[0].id;

  clearState(ctx.from.id);

  const { rows: mRows } = await pool.query('SELECT name FROM masters WHERE id = $1', [state.masterId]);

  const successText =
    `✅ *Запись подтверждена!*\n\n` +
    `📅 ${fmtDate(startTime)}\n` +
    `⏰ ${fmtTime(startTime)} — ${fmtTime(endTime)}\n` +
    `💆 Мастер: ${mRows[0].name}\n` +
    `✂️ Услуга: ${state.service.name}\n` +
    `💰 ${fmtPrice(state.service.price)}\n\n` +
    `Напомню за день и за 2 часа.\n` +
    `Номер записи: #${apptId}`;

  await ctx.editMessageText(successText, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([
    [Markup.button.callback('📋 Мои записи', 'MY_APPTS'), Markup.button.callback('← В меню', 'MAIN_MENU')]
  ])});

  // Уведомить админов
  for (const adminId of ADMIN_IDS) {
    try {
      await bot.telegram.sendMessage(adminId,
        `🔔 *Новая запись* #${apptId}\n\n` +
        `Клиент: ${clientName}\n` +
        `Услуга: ${state.service.name}\n` +
        `Мастер: ${mRows[0].name}\n` +
        `Когда: ${fmtDate(startTime)} в ${fmtTime(startTime)}\n` +
        `Сумма: ${fmtPrice(state.service.price)}`,
        { parse_mode: 'Markdown' }
      );
    } catch (e) {}
  }
});

// Обработка текста (для ввода имени/телефона)
bot.on('text', async (ctx) => {
  const state = getState(ctx.from.id);
  if (state.awaitingContact) {
    const text = ctx.message.text;
    const phoneMatch = text.match(/[\+\d][\d\s\-\(\)]{7,}/);
    if (phoneMatch) {
      state.contactPhone = phoneMatch[0].replace(/[\s\-\(\)]/g, '');
      state.contactName = text.replace(phoneMatch[0], '').replace(/[,;]/g, '').trim() || 'Гость';
      await pool.query('UPDATE users SET name = $1, phone = $2 WHERE telegram_id = $3',
        [state.contactName, state.contactPhone, ctx.from.id]);
    } else {
      state.contactName = text.trim();
      await pool.query('UPDATE users SET name = $1 WHERE telegram_id = $2', [state.contactName, ctx.from.id]);
    }
    state.awaitingContact = false;
    setState(ctx.from.id, state);
    return ctx.reply(`Записал: ${state.contactName}${state.contactPhone ? ' ('+state.contactPhone+')' : ''}`,
      Markup.inlineKeyboard([
        [Markup.button.callback('✅ Подтвердить запись', 'CONFIRM_BOOK')],
        [Markup.button.callback('❌ Отменить', 'MAIN_MENU')]
      ]));
  }
});

// ════════ МОИ ЗАПИСИ ════════
bot.action('MY_APPTS', async (ctx) => {
  await ctx.answerCbQuery();
  const { rows } = await pool.query(`
    SELECT a.*, m.name as master_name, s.name as service_name, s.price
    FROM appointments a
    JOIN masters m ON m.id = a.master_id
    JOIN services s ON s.id = a.service_id
    WHERE a.user_id = $1 AND a.start_time >= NOW() AND a.status = 'confirmed'
    ORDER BY a.start_time
    LIMIT 10
  `, [ctx.from.id]);
  if (!rows.length) {
    return ctx.editMessageText('У тебя пока нет записей.', Markup.inlineKeyboard([
      [Markup.button.callback('📅 Записаться', 'BOOK_START')],
      [Markup.button.callback('← В меню', 'MAIN_MENU')]
    ]));
  }
  let text = `📋 *Твои записи (${rows.length}):*\n\n`;
  const buttons = [];
  for (const a of rows) {
    text += `#${a.id} — ${fmtDate(a.start_time)} в ${fmtTime(a.start_time)}\n` +
            `${a.service_name} у ${a.master_name} — ${fmtPrice(a.price)}\n\n`;
    buttons.push([Markup.button.callback(`❌ Отменить #${a.id}`, `CANCEL_${a.id}`)]);
  }
  buttons.push([Markup.button.callback('← В меню', 'MAIN_MENU')]);
  return ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
});

bot.action(/^CANCEL_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const aptId = parseInt(ctx.match[1]);
  const { rows } = await pool.query(
    `SELECT * FROM appointments WHERE id = $1 AND user_id = $2`,
    [aptId, ctx.from.id]
  );
  if (!rows.length) return ctx.editMessageText('Запись не найдена');
  await pool.query(`UPDATE appointments SET status = 'cancelled' WHERE id = $1`, [aptId]);
  await ctx.editMessageText(`✅ Запись #${aptId} отменена.`, Markup.inlineKeyboard([
    [Markup.button.callback('📋 Мои записи', 'MY_APPTS')],
    [Markup.button.callback('← В меню', 'MAIN_MENU')]
  ]));
  // Уведомить админа
  for (const adminId of ADMIN_IDS) {
    try {
      await bot.telegram.sendMessage(adminId, `❌ Клиент отменил запись #${aptId}`);
    } catch (e) {}
  }
});

// ════════ АДМИН-ПАНЕЛЬ ════════
bot.action('ADMIN_MENU', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx.from.id)) return;
  return ctx.editMessageText(`⚙️ *Админ-панель*\n\nЧто будем делать?`, {
    parse_mode: 'Markdown', ...Markup.inlineKeyboard([
      [Markup.button.callback('📅 Записи сегодня', 'ADM_TODAY')],
      [Markup.button.callback('📊 Расписание мастеров', 'ADM_SCHEDULE')],
      [Markup.button.callback('💰 Статистика', 'ADM_STATS')],
      [Markup.button.callback('📥 Экспорт CSV', 'ADM_EXPORT')],
      [Markup.button.callback('🚫 Заблокировать слот', 'ADM_BLOCK')],
      [Markup.button.callback('← В меню', 'MAIN_MENU')]
    ])
  });
});

bot.action('ADM_TODAY', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx.from.id)) return;
  const today = new Date().toISOString().split('T')[0];
  const { rows } = await pool.query(`
    SELECT a.*, m.name as master_name, s.name as service_name, s.price
    FROM appointments a
    JOIN masters m ON m.id = a.master_id
    JOIN services s ON s.id = a.service_id
    WHERE DATE(a.start_time) = $1 AND a.status = 'confirmed'
    ORDER BY a.start_time
  `, [today]);
  if (!rows.length) {
    return ctx.editMessageText('Сегодня записей нет.', Markup.inlineKeyboard([
      [Markup.button.callback('← Админка', 'ADMIN_MENU')]
    ]));
  }
  let text = `📅 *Записи на сегодня (${rows.length}):*\n\n`;
  let total = 0;
  for (const a of rows) {
    text += `${fmtTime(a.start_time)} — ${a.client_name || 'Гость'}\n` +
            `${a.service_name} (${a.master_name}) ${fmtPrice(a.price)}\n` +
            (a.client_phone ? `📞 ${a.client_phone}\n` : '') + '\n';
    total += parseFloat(a.price);
  }
  text += `\n💰 *Итого:* ${fmtPrice(total)}`;
  return ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([
    [Markup.button.callback('← Админка', 'ADMIN_MENU')]
  ])});
});

bot.action('ADM_STATS', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx.from.id)) return;
  const stats = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'confirmed' AND DATE(start_time) = CURRENT_DATE) as today,
      COUNT(*) FILTER (WHERE status = 'confirmed' AND start_time >= CURRENT_DATE - INTERVAL '7 days') as week,
      COUNT(*) FILTER (WHERE status = 'confirmed' AND start_time >= CURRENT_DATE - INTERVAL '30 days') as month,
      COALESCE(SUM(s.price) FILTER (WHERE a.status = 'confirmed' AND DATE(a.start_time) = CURRENT_DATE), 0) as rev_today,
      COALESCE(SUM(s.price) FILTER (WHERE a.status = 'confirmed' AND a.start_time >= CURRENT_DATE - INTERVAL '7 days'), 0) as rev_week,
      COALESCE(SUM(s.price) FILTER (WHERE a.status = 'confirmed' AND a.start_time >= CURRENT_DATE - INTERVAL '30 days'), 0) as rev_month,
      (SELECT COUNT(DISTINCT user_id) FROM appointments WHERE status = 'confirmed') as unique_clients
    FROM appointments a
    JOIN services s ON s.id = a.service_id
  `);
  const r = stats.rows[0];
  const text =
    `📊 *Статистика салона*\n\n` +
    `*Сегодня:*\n` +
    `  Записей: ${r.today}\n` +
    `  Выручка: ${fmtPrice(r.rev_today)}\n\n` +
    `*За неделю:*\n` +
    `  Записей: ${r.week}\n` +
    `  Выручка: ${fmtPrice(r.rev_week)}\n\n` +
    `*За месяц:*\n` +
    `  Записей: ${r.month}\n` +
    `  Выручка: ${fmtPrice(r.rev_month)}\n\n` +
    `*Всего клиентов:* ${r.unique_clients}`;

  // Топ мастеров по записям за месяц
  const { rows: topMasters } = await pool.query(`
    SELECT m.name, COUNT(a.id) as cnt, COALESCE(SUM(s.price), 0) as revenue
    FROM appointments a
    JOIN masters m ON m.id = a.master_id
    JOIN services s ON s.id = a.service_id
    WHERE a.status = 'confirmed' AND a.start_time >= CURRENT_DATE - INTERVAL '30 days'
    GROUP BY m.id, m.name
    ORDER BY revenue DESC
    LIMIT 5
  `);
  let topText = '\n\n*Топ мастеров (мес):*';
  topMasters.forEach((m, i) => {
    topText += `\n${i+1}. ${m.name} — ${m.cnt} зап., ${fmtPrice(m.revenue)}`;
  });

  return ctx.editMessageText(text + topText, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([
    [Markup.button.callback('← Админка', 'ADMIN_MENU')]
  ])});
});

bot.action('ADM_SCHEDULE', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx.from.id)) return;
  const { rows: masters } = await pool.query('SELECT * FROM masters WHERE is_active = true');
  const today = new Date();
  let text = `📊 *Расписание на ближайшие 7 дней*\n\n`;
  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    const ds = d.toISOString().split('T')[0];
    const { rows } = await pool.query(`
      SELECT a.start_time, a.client_name, m.name as mname, s.name as sname
      FROM appointments a
      JOIN masters m ON m.id = a.master_id
      JOIN services s ON s.id = a.service_id
      WHERE DATE(a.start_time) = $1 AND a.status = 'confirmed'
      ORDER BY a.start_time
    `, [ds]);
    text += `*${fmtDate(d)}* — ${rows.length} записей\n`;
    for (const a of rows.slice(0, 5)) {
      text += `  ${fmtTime(a.start_time)} ${a.mname} → ${a.client_name || '—'} (${a.sname})\n`;
    }
    if (rows.length > 5) text += `  _...ещё ${rows.length - 5}_\n`;
    text += '\n';
  }
  return ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([
    [Markup.button.callback('← Админка', 'ADMIN_MENU')]
  ])});
});

bot.action('ADM_EXPORT', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx.from.id)) return;
  const { rows } = await pool.query(`
    SELECT a.id, a.start_time, m.name as master, s.name as service, s.price,
           a.client_name, a.client_phone, a.status
    FROM appointments a
    JOIN masters m ON m.id = a.master_id
    JOIN services s ON s.id = a.service_id
    WHERE a.start_time >= CURRENT_DATE - INTERVAL '30 days'
    ORDER BY a.start_time DESC
  `);
  let csv = 'ID,Дата,Время,Мастер,Услуга,Цена,Клиент,Телефон,Статус\n';
  for (const r of rows) {
    csv += `${r.id},"${fmtDate(r.start_time)}","${fmtTime(r.start_time)}","${r.master}","${r.service}",${r.price},"${r.client_name||''}","${r.client_phone||''}","${r.status}"\n`;
  }
  const buf = Buffer.from('\ufeff' + csv, 'utf8');
  await ctx.replyWithDocument({ source: buf, filename: `appointments-${new Date().toISOString().split('T')[0]}.csv` });
  return ctx.reply('Готово! Файл с записями за последние 30 дней.');
});

bot.action('ADM_BLOCK', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx.from.id)) return;
  return ctx.editMessageText(
    '🚫 *Блокировка слота*\n\n' +
    'Отправь сообщением в формате:\n' +
    '`<master_id> <YYYY-MM-DD HH:MM> <YYYY-MM-DD HH:MM> <причина>`\n\n' +
    'Пример: `1 2026-06-01 14:00 2026-06-01 16:00 Обед`\n\n' +
    'ID мастеров посмотри в /masters_ids',
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([
      [Markup.button.callback('← Админка', 'ADMIN_MENU')]
    ])}
  );
});

bot.command('masters_ids', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const { rows } = await pool.query('SELECT id, name FROM masters ORDER BY id');
  let t = '*ID мастеров:*\n';
  for (const m of rows) t += `${m.id} — ${m.name}\n`;
  return ctx.replyWithMarkdown(t);
});

// ════════ НАПОМИНАНИЯ ЧЕРЕЗ CRON ════════
function startReminderScheduler() {
  // Проверяем каждые 5 минут
  cron.schedule('*/5 * * * *', async () => {
    if (!pool) return;
    try {
      // 24h reminders
      const { rows: r24 } = await pool.query(`
        SELECT a.id, a.user_id, a.start_time, m.name as mname, s.name as sname
        FROM appointments a
        JOIN masters m ON m.id = a.master_id
        JOIN services s ON s.id = a.service_id
        WHERE a.status = 'confirmed'
        AND a.start_time BETWEEN NOW() + INTERVAL '23 hours 30 minutes' AND NOW() + INTERVAL '24 hours 30 minutes'
        AND NOT EXISTS (SELECT 1 FROM notifications_sent ns WHERE ns.appointment_id = a.id AND ns.type = '24h')
      `);
      for (const a of r24) {
        try {
          await bot.telegram.sendMessage(a.user_id,
            `🔔 *Напоминание*\n\nЗавтра в ${fmtTime(a.start_time)} у тебя запись:\n` +
            `${a.sname} у мастера ${a.mname}\n\nЖдём! 💆`,
            { parse_mode: 'Markdown' });
          await pool.query(`INSERT INTO notifications_sent (appointment_id, type) VALUES ($1, '24h')`, [a.id]);
        } catch (e) { console.error('Notify 24h:', e.message); }
      }
      // 2h reminders
      const { rows: r2 } = await pool.query(`
        SELECT a.id, a.user_id, a.start_time, m.name as mname, s.name as sname
        FROM appointments a
        JOIN masters m ON m.id = a.master_id
        JOIN services s ON s.id = a.service_id
        WHERE a.status = 'confirmed'
        AND a.start_time BETWEEN NOW() + INTERVAL '1 hour 50 minutes' AND NOW() + INTERVAL '2 hours 10 minutes'
        AND NOT EXISTS (SELECT 1 FROM notifications_sent ns WHERE ns.appointment_id = a.id AND ns.type = '2h')
      `);
      for (const a of r2) {
        try {
          await bot.telegram.sendMessage(a.user_id,
            `⏰ *Напоминание*\n\nЧерез 2 часа в ${fmtTime(a.start_time)}:\n` +
            `${a.sname} у мастера ${a.mname}\n\nНе опаздывай! ✨`,
            { parse_mode: 'Markdown' });
          await pool.query(`INSERT INTO notifications_sent (appointment_id, type) VALUES ($1, '2h')`, [a.id]);
        } catch (e) { console.error('Notify 2h:', e.message); }
      }
    } catch (e) { console.error('Cron error:', e.message); }
  }, { timezone: TIMEZONE });
  console.log('⏰ Планировщик напоминаний запущен');
}

// ════════ ЗАПУСК ════════
(async () => {
  const dbOk = await initDB();
  if (!dbOk) {
    console.error('❌ БД недоступна. Бот не запустится.');
    process.exit(1);
  }
  startReminderScheduler();
  bot.catch(err => console.error('Bot error:', err));
  bot.launch()
    .then(() => {
      console.log(`🤖 ${SALON_NAME} bot launched`);
      console.log(`👑 Admins: ${ADMIN_IDS.join(', ') || 'не заданы (укажи ADMIN_IDS)'}`);
    })
    .catch(err => console.error('❌ Bot launch failed:', err.message));
})();

process.on('SIGINT', () => { bot.stop('SIGINT'); process.exit(); });
process.on('SIGTERM', () => { bot.stop('SIGTERM'); process.exit(); });
