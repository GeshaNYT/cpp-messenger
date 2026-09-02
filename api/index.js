// ============================================================
//  GeLink API — index.js
//  Улучшения: Redis-хелпер (нет injection), JWT выдаётся при логине
//  Фронт не требует JWT — обратная совместимость сохранена
// ============================================================

import { SignJWT, jwtVerify } from 'jose';

const JWT_ALG = 'HS256';
const JWT_TTL = '7d';

// ── SHA-256 хеш пароля ───────────────────────────────────────
async function hashPassword(password) {
    const data = new TextEncoder().encode(password);
    const buf  = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(buf))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

// ── Единый Redis-клиент (тело запроса, не URL) ───────────────
async function redis(env, ...args) {
    const res = await fetch(env.url, {
        method: 'POST',
        headers: {
            Authorization:  `Bearer ${env.token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(args),
    });
    if (!res.ok) throw new Error(`Redis error ${res.status}: ${await res.text()}`);
    return (await res.json()).result;
}

// ── JWT ──────────────────────────────────────────────────────
function jwtSecret(s) { return new TextEncoder().encode(s); }

async function signToken(payload, secret) {
    return new SignJWT(payload)
        .setProtectedHeader({ alg: JWT_ALG })
        .setExpirationTime(JWT_TTL)
        .setIssuedAt()
        .sign(jwtSecret(secret));
}

// Мягкая проверка — если токен есть и валиден, возвращает email.
// Если токена нет — возвращает null (не ломает старый фронт).
// Если токен есть но невалиден — бросает 401.
async function tryAuth(request, secret) {
    const header = request.headers.get?.('authorization')
        ?? request.headers['authorization']
        ?? '';
    if (!header.startsWith('Bearer ')) return null; // токена нет — ок
    const token = header.slice(7);
    try {
        const { payload } = await jwtVerify(token, jwtSecret(secret));
        return payload.email;
    } catch {
        throw Object.assign(new Error('Invalid or expired token'), { status: 401 });
    }
}

// ── Хелпер: hgetall → объект ─────────────────────────────────
function parseHash(raw) {
    const out = {};
    if (!Array.isArray(raw)) return out;
    for (let i = 0; i < raw.length; i += 2) out[raw[i]] = raw[i + 1];
    return out;
}

// ── Генерация ID группы: 8 символов, A-Z0-9 ──────────────────
const GROUP_ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
// Зарезервированный ID общего канала General — никогда не выдаётся новым группам
const GENERAL_GROUP_ID = '00000000';
function genGroupId() {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    let id = '';
    for (let i = 0; i < 8; i++) id += GROUP_ID_CHARS[bytes[i] % GROUP_ID_CHARS.length];
    return id;
}

// Генерирует ID и проверяет через EXISTS, что такой группы ещё нет
// (а также что это не зарезервированный ID General)
async function generateUniqueGroupId(db) {
    for (let attempt = 0; attempt < 25; attempt++) {
        const id = genGroupId();
        if (id === GENERAL_GROUP_ID) continue;
        const exists = await db('EXISTS', `group:${id}`);
        if (!exists) return id;
    }
    throw new Error('Не удалось сгенерировать уникальный ID группы');
}

// Публикует системное сообщение в чат группы (о вступлении/выходе участника)
async function pushSystemMessage(db, roomId, text, email) {
    const msg = {
        type: 'system',
        text,
        ts: Date.now(),
        username: 'System',
        email: email || '',
    };
    await db('LPUSH', `room:${roomId}`, encodeURIComponent(JSON.stringify(msg)));
}
export default async function handler(request, response) {
    const env = {
        url:   process.env.UPSTASH_URL,
        token: process.env.UPSTASH_TOKEN,
        jwt:   process.env.JWT_SECRET,
    };

    if (!env.url || !env.token || !env.jwt) {
        return response.status(500).json({ status: 'error', message: 'Server misconfigured' });
    }

    const db = (...args) => redis(env, ...args);
    const { room = 'general', user_email, action, target_email } = request.query ?? {};

    try {

        // ══════════════════════════════════════════════════════
        //  РЕГИСТРАЦИЯ  — публичный эндпоинт
        // ══════════════════════════════════════════════════════
        if (action === 'register' && request.method === 'POST') {
            const { email, password, name, nickname, avColor } = request.body;
            if (!email || !password || !name || !nickname)
                return response.status(400).json({ status: 'error', message: 'Заполните все поля' });

            const emailLower = email.trim().toLowerCase();
            const nickLower  = nickname.trim().toLowerCase();

            if (await db('SISMEMBER', 'all_users', emailLower) === 1)
                return response.status(400).json({ status: 'error', message: 'Этот email уже зарегистрирован' });

            if (await db('GET', `nick:${nickLower}`))
                return response.status(400).json({ status: 'error', message: 'Этот никнейм уже занят' });

            await db('SADD', 'all_users', emailLower);
            await db('HSET', `profile:${emailLower}`,
                'name',     name,
                'nickname', nickLower,
                'avColor',  avColor || 'var(--ge-accent-gradient)',
                'password', await hashPassword(password),
            );
            await db('SET', `nick:${nickLower}`, emailLower);

            return response.status(200).json({ status: 'ok' });
        }

        // ══════════════════════════════════════════════════════
        //  ВХОД  — публичный эндпоинт, выдаёт JWT
        // ══════════════════════════════════════════════════════
        if (action === 'login' && request.method === 'POST') {
            const { email, password } = request.body;
            if (!email || !password)
                return response.status(400).json({ status: 'error', message: 'Введите email и пароль' });

            const emailLower = email.trim().toLowerCase();

            if (await db('SISMEMBER', 'all_users', emailLower) !== 1)
                return response.status(401).json({ status: 'error', message: 'Неверный email или пароль' });

            const profile    = parseHash(await db('HGETALL', `profile:${emailLower}`));
            const storedPass = profile.password;
            if (!storedPass)
                return response.status(401).json({ status: 'error', message: 'Неверный email или пароль' });

            const passHash = await hashPassword(password);
            const isLegacy = storedPass.length !== 64 || !/^[0-9a-f]+$/.test(storedPass);
            let ok = false;

            if (isLegacy) {
                let legacy;
                try { legacy = Buffer.from(password).toString('base64'); }
                catch { legacy = btoa(unescape(encodeURIComponent(password))); }
                const decoded = storedPass.startsWith('%') ? decodeURIComponent(storedPass) : storedPass;
                ok = decoded === legacy;
                if (ok) await db('HSET', `profile:${emailLower}`, 'password', passHash);
            } else {
                ok = storedPass === passHash;
            }

            if (!ok)
                return response.status(401).json({ status: 'error', message: 'Неверный email или пароль' });

            const jwtToken = await signToken({ email: emailLower }, env.jwt);

            return response.status(200).json({
                status: 'ok',
                token: jwtToken,   // фронт может сохранить, может игнорировать
                user: {
                    email:    emailLower,
                    name:     profile.name     ?? emailLower,
                    nickname: profile.nickname ?? '',
                    avColor:  profile.avColor  ?? 'var(--ge-accent-gradient)',
                    avImg:    profile.avImg     ?? null,
                    bio:      profile.bio       ?? '',
                },
            });
        }

        // ══════════════════════════════════════════════════════
        //  ОБНОВЛЕНИЕ ПРОФИЛЯ
        //  Берём email: сначала из JWT (если есть), иначе из query
        // ══════════════════════════════════════════════════════
        if (action === 'updateProfile' && request.method === 'POST') {
            const jwtEmail   = await tryAuth(request, env.jwt);
            const emailLower = (jwtEmail ?? user_email ?? '').trim().toLowerCase();
            if (!emailLower) return response.status(400).json({ status: 'error', message: 'Не указан email' });

            const { name, nickname, avColor, password, avImg, bio } = request.body;
            const fields = [];

            if (name)     fields.push('name',     name);
            if (avColor)  fields.push('avColor',  avColor);
            if (password) fields.push('password', await hashPassword(password));
            if (bio !== undefined) fields.push('bio', (bio || '').toString().slice(0, 150));

            if (nickname) {
                const nickLower = nickname.toLowerCase();
                const oldNick   = await db('HGET', `profile:${emailLower}`, 'nickname');
                if (oldNick) await db('DEL', `nick:${oldNick}`);
                fields.push('nickname', nickLower);
                await db('SET', `nick:${nickLower}`, emailLower);
            }

            if (avImg !== undefined) {
                if (avImg) fields.push('avImg', avImg);
                else await db('HDEL', `profile:${emailLower}`, 'avImg');
            }

            if (fields.length > 0) await db('HSET', `profile:${emailLower}`, ...fields);
            return response.status(200).json({ status: 'ok' });
        }

        // Полное удаление аккаунта — реально стирает данные пользователя (не косметика)
        if (action === 'deleteAccount') {
            const jwtEmail   = await tryAuth(request, env.jwt);
            const emailLower = (jwtEmail ?? user_email ?? '').trim().toLowerCase();
            if (!emailLower) return response.status(400).json({ status: 'error', message: 'Не указан email' });

            // ВАЖНО: всё, что ниже до финального блока — это best-effort уборка (чужие
            // контакты, уведомления групп и т.п.). Раньше, если тут что-то падало
            // с ошибкой, весь обработчик прерывался ДО того, как реально стереть профиль
            // и email из all_users — аккаунт оставался "наполовину удалённым", и повторная
            // регистрация с той же почтой вечно говорила "уже зарегистрирован". Теперь
            // каждый необязательный шаг обёрнут отдельно и не может заблокировать финал.

            // Отвязываемся от контактов — убираем себя из ЧУЖИХ списков контактов тоже,
            // и, что важно, убираем сам приватный чат из их списка комнат — иначе удалённый
            // аккаунт продолжал "висеть" у контакта в списке чатов вечно.
            try {
                const myContacts = (await db('SMEMBERS', `contacts:${emailLower}`)) ?? [];
                const myMailSafe = emailLower.replace(/[@.]/g, '');
                await Promise.all(myContacts.map(async c => {
                    try {
                        await db('SREM', `contacts:${c}`, emailLower);
                        const otherSafe = c.replace(/[@.]/g, '');
                        const roomId = `private-${[myMailSafe, otherSafe].sort().join('-')}`;
                        await db('SREM', `user_rooms:${c}`, roomId);
                        await db('HDEL', `contact_requests:${c}`, emailLower);
                    } catch {}
                }));
            } catch {}

            // Выходим из всех групп, в которых состоим, и уведомляем остальных участников
            try {
                const myName = (await db('HGET', `profile:${emailLower}`, 'name')) || emailLower;
                const myRooms = (await db('SMEMBERS', `user_rooms:${emailLower}`)) ?? [];
                await Promise.all(
                    myRooms
                        .filter(r => r !== 'general' && !r.startsWith('private-'))
                        .map(async r => {
                            try {
                                await db('SREM', `group_members:${r}`, emailLower);
                                const stillExists = await db('EXISTS', `group:${r}`);
                                if (stillExists) await pushSystemMessage(db, r, `${myName} покинул(а) группу (аккаунт удалён)`, emailLower);
                            } catch {}
                        })
                );
            } catch {}

            // Освобождаем никнейм
            try {
                const nickname = await db('HGET', `profile:${emailLower}`, 'nickname');
                if (nickname) await db('DEL', `nick:${nickname}`);
            } catch {}

            try {
                await db('DEL', `contact_requests:${emailLower}`);
            } catch {}

            // ── КРИТИЧНАЯ ЧАСТЬ — должна выполниться, что бы ни случилось выше ──
            await db('DEL', `contacts:${emailLower}`);
            await db('DEL', `user_rooms:${emailLower}`);
            await db('DEL', `profile:${emailLower}`);
            await db('SREM', 'all_users', emailLower);

            return response.status(200).json({ status: 'ok' });
        }

        // ══════════════════════════════════════════════════════
        //  СОХРАНЕНИЕ ПРОФИЛЯ  — публичный (вызывается после OTP)
        // ══════════════════════════════════════════════════════
        if (action === 'saveProfile' && user_email && request.method === 'POST') {
            const { nickname, name } = request.body;
            await db('SADD', 'all_users', user_email);
            await db('SADD', `user_rooms:${user_email}`, 'general'); // добавляем в general
            if (name)     await db('HSET', `profile:${user_email}`, 'name', name);
            if (nickname) {
                const nickLower = nickname.toLowerCase();
                await db('HSET', `profile:${user_email}`, 'nickname', nickLower);
                await db('SET',  `nick:${nickLower}`, user_email);
            }
            return response.status(200).json({ status: 'ok' });
        }

        // ══════════════════════════════════════════════════════
        //  WebRTC СИГНАЛИЗАЦИЯ
        // ══════════════════════════════════════════════════════
        if (action === 'signal' && request.method === 'POST') {
            const body = request.body;
            const { to } = body;
            if (!to) return response.status(400).json({ status: 'error' });
            await db('LPUSH', `signal:${to}`, JSON.stringify(body));
            await db('EXPIRE', `signal:${to}`, 60);
            return response.status(200).json({ status: 'ok' });
        }

        if (action === 'getSignals') {
            // email: из JWT если есть, иначе из query (старый фронт)
            const jwtEmail = await tryAuth(request, env.jwt);
            const email    = jwtEmail ?? user_email;
            if (!email) return response.status(400).json({ status: 'error', message: 'Не указан email' });

            const key     = `signal:${email}`;
            const raw     = await db('LRANGE', key, 0, -1);
            await db('DEL', key);
            const signals = (raw ?? []).map(s => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
            return response.status(200).json({ status: 'ok', signals });
        }

        // ══════════════════════════════════════════════════════
        //  ПОИСК ПОЛЬЗОВАТЕЛЯ  — публичный
        // ══════════════════════════════════════════════════════
        if (action === 'findUser' && request.query.query) {
            const q = request.query.query.trim().toLowerCase();

            const byEmail = await db('SISMEMBER', 'all_users', q);
            const foundEmail = byEmail === 1 ? q : await db('GET', `nick:${q}`);

            if (!foundEmail)
                return response.status(404).json({ status: 'error', message: 'User not found' });

            const profile = parseHash(await db('HGETALL', `profile:${foundEmail}`));
            delete profile.password;
            return response.status(200).json({ status: 'found', email: foundEmail, profile });
        }

        // ══════════════════════════════════════════════════════
        //  КОНТАКТЫ
        // ══════════════════════════════════════════════════════
        if (action === 'addContact' && target_email) {
            const jwtEmail   = await tryAuth(request, env.jwt);
            const emailLower = (jwtEmail ?? user_email ?? '').trim().toLowerCase();
            if (!emailLower) return response.status(400).json({ status: 'error', message: 'Не указан email' });

            if (await db('SISMEMBER', 'all_users', target_email) !== 1)
                return response.status(404).json({ status: 'error', message: 'User not found' });

            const myId    = emailLower.replace(/[@.]/g, '').toLowerCase();
            const otherId = target_email.replace(/[@.]/g, '').toLowerCase();
            const roomId  = `private-${[myId, otherId].sort().join('-')}`;

            // Уже в контактах друг у друга — ничего заново отправлять не нужно
            const alreadyContacts = await db('SISMEMBER', `contacts:${emailLower}`, target_email);
            if (alreadyContacts) {
                await db('SADD', `user_rooms:${emailLower}`, roomId);
                return response.status(200).json({ status: 'success', message: 'Contact added', roomId });
            }

            // Если собеседник уже прислал ЗАЯВКУ нам — считаем это взаимным согласием
            // и сразу соединяем (как и во ВК: если оба отправили заявку друг другу)
            const theyAlreadyRequestedMe = await db('HGET', `contact_requests:${emailLower}`, target_email);
            if (theyAlreadyRequestedMe) {
                await db('HDEL', `contact_requests:${emailLower}`, target_email);
                await db('SADD', `contacts:${emailLower}`,   target_email);
                await db('SADD', `user_rooms:${emailLower}`, roomId);
                await db('SADD', `contacts:${target_email}`, emailLower);
                await db('SADD', `user_rooms:${target_email}`, roomId);
                return response.status(200).json({ status: 'success', message: 'Contact added', roomId });
            }

            // Иначе — отправляем заявку получателю, дожидаемся его подтверждения
            await db('HSET', `contact_requests:${target_email}`, emailLower, Date.now());
            return response.status(200).json({ status: 'pending', message: 'Заявка отправлена' });
        }

        // Список входящих заявок в контакты (для уведомления, "как во ВК")
        if (action === 'getContactRequests') {
            const jwtEmail   = await tryAuth(request, env.jwt);
            const emailLower = (jwtEmail ?? user_email ?? '').trim().toLowerCase();
            if (!emailLower) return response.status(400).json({ status: 'error', message: 'Не указан email' });

            const raw = await db('HGETALL', `contact_requests:${emailLower}`);
            const map = parseHash(raw);
            const requests = await Promise.all(Object.entries(map).map(async ([fromEmail, ts]) => {
                const name = await db('HGET', `profile:${fromEmail}`, 'name');
                return { email: fromEmail, name: name || fromEmail, ts: Number(ts) };
            }));
            requests.sort((a, b) => b.ts - a.ts);
            return response.status(200).json({ status: 'ok', requests });
        }

        // Принять заявку в контакты — только теперь оба становятся видны друг другу
        if (action === 'acceptContactRequest' && target_email) {
            const jwtEmail   = await tryAuth(request, env.jwt);
            const emailLower = (jwtEmail ?? user_email ?? '').trim().toLowerCase();
            if (!emailLower) return response.status(400).json({ status: 'error', message: 'Не указан email' });

            const hasRequest = await db('HGET', `contact_requests:${emailLower}`, target_email);
            if (!hasRequest) return response.status(404).json({ status: 'error', message: 'Заявка не найдена' });

            await db('HDEL', `contact_requests:${emailLower}`, target_email);

            const myId    = emailLower.replace(/[@.]/g, '').toLowerCase();
            const otherId = target_email.replace(/[@.]/g, '').toLowerCase();
            const roomId  = `private-${[myId, otherId].sort().join('-')}`;

            await db('SADD', `contacts:${emailLower}`,   target_email);
            await db('SADD', `user_rooms:${emailLower}`, roomId);
            await db('SADD', `contacts:${target_email}`, emailLower);
            await db('SADD', `user_rooms:${target_email}`, roomId);

            const name = await db('HGET', `profile:${target_email}`, 'name');
            await pushSystemMessage(db, roomId, 'Заявка в контакты принята — теперь вы можете переписываться', emailLower);
            return response.status(200).json({ status: 'ok', roomId, name: name || target_email });
        }

        // Отклонить заявку в контакты — просто удаляем её, диалог не создаётся
        if (action === 'declineContactRequest' && target_email) {
            const jwtEmail   = await tryAuth(request, env.jwt);
            const emailLower = (jwtEmail ?? user_email ?? '').trim().toLowerCase();
            if (!emailLower) return response.status(400).json({ status: 'error', message: 'Не указан email' });

            await db('HDEL', `contact_requests:${emailLower}`, target_email);
            return response.status(200).json({ status: 'ok' });
        }

        if (action === 'removeContact' && target_email) {
            const jwtEmail   = await tryAuth(request, env.jwt);
            const emailLower = (jwtEmail ?? user_email ?? '').trim().toLowerCase();

            const myId    = emailLower.replace(/[@.]/g, '').toLowerCase();
            const otherId = target_email.replace(/[@.]/g, '').toLowerCase();
            const roomId  = `private-${[myId, otherId].sort().join('-')}`;

            // Раньше удаляли контакт только у себя — собеседник продолжал считать нас
            // контактом (у него оставались и contacts, и user_rooms), и мог писать напрямую,
            // хотя должен был снова увидеть "отправить приглашение". Удаляем с обеих сторон.
            await db('SREM', `contacts:${emailLower}`,   target_email);
            await db('SREM', `user_rooms:${emailLower}`, roomId);
            await db('SREM', `contacts:${target_email}`, emailLower);
            await db('SREM', `user_rooms:${target_email}`, roomId);
            return response.status(200).json({ status: 'success', message: 'Contact removed' });
        }

        // ══════════════════════════════════════════════════════
        //  ГРУППЫ
        // ══════════════════════════════════════════════════════

        // Создать группу
        if (action === 'createGroup') {
            const jwtEmail   = await tryAuth(request, env.jwt);
            const emailLower = (jwtEmail ?? user_email ?? '').trim().toLowerCase();
            if (!emailLower) return response.status(400).json({ status: 'error', message: 'Не указан email' });

            const rawName = (request.query.name ?? '').toString().trim();
            if (!rawName) return response.status(400).json({ status: 'error', message: 'Укажите название группы' });
            const name = rawName.slice(0, 60);

            const groupId = await generateUniqueGroupId(db);

            await db('HSET', `group:${groupId}`,
                'name',      name,
                'owner',     emailLower,
                'createdAt', Date.now(),
            );
            await db('SADD', `group_members:${groupId}`, emailLower);
            await db('SADD', `user_rooms:${emailLower}`, groupId);
            await db('SADD', 'all_users', emailLower);

            return response.status(200).json({ status: 'ok', groupId, name });
        }

        // Изменить название и/или аватар группы (только владелец) — видно всем участникам
        if (action === 'updateGroupProfile' && request.method === 'POST') {
            const jwtEmail   = await tryAuth(request, env.jwt);
            const emailLower = (jwtEmail ?? user_email ?? '').trim().toLowerCase();
            if (!emailLower) return response.status(400).json({ status: 'error', message: 'Не указан email' });

            const body = request.body ?? {};
            const groupIdRaw = (body.groupId ?? '').toString().trim();
            if (!groupIdRaw) return response.status(400).json({ status: 'error', message: 'Не указан ID группы' });
            const groupId = groupIdRaw.toUpperCase();

            if (groupId === GENERAL_GROUP_ID) {
                return response.status(403).json({ status: 'error', message: 'Изменить General нельзя' });
            }

            const owner = await db('HGET', `group:${groupId}`, 'owner');
            if (!owner) return response.status(404).json({ status: 'error', message: 'Группа не найдена' });
            if (owner !== emailLower) return response.status(403).json({ status: 'error', message: 'Изменить группу может только владелец' });

            const fields = [];
            if (typeof body.name === 'string' && body.name.trim()) {
                fields.push('name', body.name.trim().slice(0, 60));
            }
            if (body.avImg !== undefined) {
                if (body.avImg) fields.push('avImg', body.avImg);
                else await db('HDEL', `group:${groupId}`, 'avImg');
            }
            if (fields.length > 0) await db('HSET', `group:${groupId}`, ...fields);

            const info = parseHash(await db('HGETALL', `group:${groupId}`));
            return response.status(200).json({
                status: 'ok',
                groupId,
                name: info.name,
                avImg: info.avImg || null,
            });
        }

        // Вступить в группу по ID
        if (action === 'joinGroup' && request.query.groupId) {
            const jwtEmail   = await tryAuth(request, env.jwt);
            const emailLower = (jwtEmail ?? user_email ?? '').trim().toLowerCase();
            if (!emailLower) return response.status(400).json({ status: 'error', message: 'Не указан email' });

            const groupId = request.query.groupId.toString().trim().toUpperCase();

            // Зарезервированный ID 00000000 — это общий канал General, а не отдельная группа.
            // Никакой новой группы не создаём: просто добавляем комнату 'general' пользователю,
            // если он ещё не состоит в ней (повторное вступление не выполняем).
            if (groupId === GENERAL_GROUP_ID) {
                const alreadyMember = !!(await db('SISMEMBER', 'user_rooms:' + emailLower, 'general'));
                if (!alreadyMember) {
                    await db('SADD', `user_rooms:${emailLower}`, 'general');
                    await db('SADD', 'all_users', emailLower);
                }
                return response.status(200).json({
                    status: 'ok',
                    groupId: 'general',
                    name: 'general',
                    alreadyMember,
                });
            }

            const exists  = await db('EXISTS', `group:${groupId}`);
            if (!exists) return response.status(404).json({ status: 'error', message: 'Группа с таким ID не найдена' });

            const info = parseHash(await db('HGETALL', `group:${groupId}`));

            const wasAlreadyMember = !!(await db('SISMEMBER', `group_members:${groupId}`, emailLower));
            await db('SADD', `group_members:${groupId}`, emailLower);
            await db('SADD', `user_rooms:${emailLower}`, groupId);
            await db('SADD', 'all_users', emailLower);

            if (!wasAlreadyMember) {
                const myName = (await db('HGET', `profile:${emailLower}`, 'name')) || emailLower;
                await pushSystemMessage(db, groupId, `${myName} вступил(а) в группу`, emailLower);
            }

            const memberCount = await db('SCARD', `group_members:${groupId}`);
            return response.status(200).json({ status: 'ok', groupId, name: info.name, avImg: info.avImg || null, memberCount });
        }

        // Информация о группе (название, кол-во участников; owner виден только владельцу)
        if (action === 'getGroupInfo' && request.query.groupId) {
            const jwtEmail   = await tryAuth(request, env.jwt);
            const emailLower = (jwtEmail ?? user_email ?? '').trim().toLowerCase();

            const groupIdRaw = request.query.groupId.toString().trim();
            const groupId = groupIdRaw.toUpperCase();

            // Общий канал General не хранится в group:* — считаем участников иначе
            // (в него автоматически входят все зарегистрированные пользователи)
            if (groupIdRaw.toLowerCase() === 'general' || groupId === GENERAL_GROUP_ID) {
                const memberCount = await db('SCARD', 'all_users');
                return response.status(200).json({
                    status: 'ok',
                    groupId: 'general',
                    name: 'general',
                    memberCount,
                    isOwner: false,
                    isGeneral: true,
                });
            }

            const exists  = await db('EXISTS', `group:${groupId}`);
            if (!exists) return response.status(404).json({ status: 'error', message: 'Группа не найдена' });

            const info        = parseHash(await db('HGETALL', `group:${groupId}`));
            const memberCount = await db('SCARD', `group_members:${groupId}`);
            const isOwner     = !!emailLower && emailLower === info.owner;

            return response.status(200).json({
                status: 'ok',
                groupId,
                name: info.name,
                memberCount,
                isOwner,
                avImg: info.avImg || null,
            });
        }

        // Покинуть группу (для участников, не владельца)
        // Очистить чат: mode=me — только у себя (остальные видят историю как раньше),
        // mode=all — стереть переписку полностью для обеих сторон (только приватные чаты)
        if (action === 'clearChat' && room) {
            const jwtEmail   = await tryAuth(request, env.jwt);
            const emailLower = (jwtEmail ?? user_email ?? '').trim().toLowerCase();
            if (!emailLower) return response.status(400).json({ status: 'error', message: 'Не указан email' });

            const mode = (request.query.mode || 'me').toString();

            if (mode === 'all') {
                if (!room.startsWith('private-')) {
                    return response.status(403).json({ status: 'error', message: 'Полная очистка доступна только для личных чатов' });
                }
                await db('DEL', `room:${room}`);
                await db('DEL', `room_cleared:${room}`);
                return response.status(200).json({ status: 'ok', mode: 'all' });
            }

            // mode 'me' — помечаем время, раньше которого сообщения скрываются только у нас
            await db('HSET', `room_cleared:${room}`, emailLower, Date.now());
            return response.status(200).json({ status: 'ok', mode: 'me' });
        }

        if (action === 'leaveGroup' && request.query.groupId) {
            const jwtEmail   = await tryAuth(request, env.jwt);
            const emailLower = (jwtEmail ?? user_email ?? '').trim().toLowerCase();
            if (!emailLower) return response.status(400).json({ status: 'error', message: 'Не указан email' });

            const groupId = request.query.groupId.toString().trim().toUpperCase();

            const wasMember = !!(await db('SISMEMBER', `group_members:${groupId}`, emailLower));
            await db('SREM', `group_members:${groupId}`, emailLower);
            await db('SREM', `user_rooms:${emailLower}`, groupId);

            // Сообщение о выходе публикуем, только если группа ещё существует
            // (её не удалили только что владелец) и человек реально в ней состоял
            if (wasMember) {
                const stillExists = await db('EXISTS', `group:${groupId}`);
                if (stillExists) {
                    const myName = (await db('HGET', `profile:${emailLower}`, 'name')) || emailLower;
                    await pushSystemMessage(db, groupId, `${myName} покинул(а) группу`, emailLower);
                }
            }

            return response.status(200).json({ status: 'ok' });
        }

        // Удалить группу навсегда — только владелец: чистим сообщения, участников, освобождаем ID
        if (action === 'deleteGroup' && request.query.groupId) {
            const jwtEmail   = await tryAuth(request, env.jwt);
            const emailLower = (jwtEmail ?? user_email ?? '').trim().toLowerCase();
            if (!emailLower) return response.status(400).json({ status: 'error', message: 'Не указан email' });

            const groupId = request.query.groupId.toString().trim().toUpperCase();

            // ID 00000000 зарезервирован за General — его нельзя удалить ни при каких условиях
            if (groupId === GENERAL_GROUP_ID) {
                return response.status(403).json({ status: 'error', message: 'ID 00000000 зарезервирован и не может быть удалён' });
            }

            const owner    = await db('HGET', `group:${groupId}`, 'owner');
            if (!owner) return response.status(404).json({ status: 'error', message: 'Группа не найдена' });
            if (owner !== emailLower) return response.status(403).json({ status: 'error', message: 'Удалить группу может только владелец' });

            const members = (await db('SMEMBERS', `group_members:${groupId}`)) ?? [];
            await Promise.all(members.map(m => db('SREM', `user_rooms:${m}`, groupId)));

            await db('DEL', `group_members:${groupId}`);
            await db('DEL', `group:${groupId}`);
            await db('DEL', `room:${groupId}`); // удаляем все сообщения группы

            return response.status(200).json({ status: 'ok' });
        }

        // Сменить ID группы (только владелец): старый ID полностью освобождается,
        // новый выдаётся так же, как при создании. Сообщения и участники переносятся.
        if (action === 'changeGroupId' && request.query.groupId) {
            const jwtEmail   = await tryAuth(request, env.jwt);
            const emailLower = (jwtEmail ?? user_email ?? '').trim().toLowerCase();
            if (!emailLower) return response.status(400).json({ status: 'error', message: 'Не указан email' });

            const oldId = request.query.groupId.toString().trim().toUpperCase();

            // ID 00000000 зарезервирован за General — его нельзя менять
            if (oldId === GENERAL_GROUP_ID) {
                return response.status(403).json({ status: 'error', message: 'ID 00000000 зарезервирован и не может быть изменён' });
            }

            const owner = await db('HGET', `group:${oldId}`, 'owner');
            if (!owner) return response.status(404).json({ status: 'error', message: 'Группа не найдена' });
            if (owner !== emailLower) return response.status(403).json({ status: 'error', message: 'Сменить ID может только владелец' });

            const name  = await db('HGET', `group:${oldId}`, 'name');
            const avImg = await db('HGET', `group:${oldId}`, 'avImg');
            const newId = await generateUniqueGroupId(db);

            // Переносим метаданные и участников группы под новым ключом
            await db('RENAME', `group:${oldId}`, `group:${newId}`);
            await db('RENAME', `group_members:${oldId}`, `group_members:${newId}`);
            // Сообщения переносим, только если они вообще есть (RENAME падает на несуществующем ключе)
            const hasMessages = await db('EXISTS', `room:${oldId}`);
            if (hasMessages) await db('RENAME', `room:${oldId}`, `room:${newId}`);

            // У всех участников заменяем старый ID на новый в их списке комнат
            const members = (await db('SMEMBERS', `group_members:${newId}`)) ?? [];
            await Promise.all(members.map(async m => {
                await db('SREM', `user_rooms:${m}`, oldId);
                await db('SADD', `user_rooms:${m}`, newId);
            }));

            const memberCount = await db('SCARD', `group_members:${newId}`);
            return response.status(200).json({ status: 'ok', oldId, newId, name, avImg: avImg || null, memberCount });
        }

        // ══════════════════════════════════════════════════════
        //  ОТПРАВИТЬ СООБЩЕНИЕ
        // ══════════════════════════════════════════════════════
        if (request.method === 'POST') {
            const body       = request.body;
            const jwtEmail   = await tryAuth(request, env.jwt);
            const emailLower = jwtEmail ?? user_email ?? (typeof body === 'object' ? body?.email : null) ?? '';

            // Если это приватный чат — отправитель должен уже состоять в этой комнате
            // (т.е. быть реальным контактом собеседника). private-комната добавляется в
            // user_rooms только через addContact/acceptContactRequest, так что этой проверки
            // достаточно, чтобы нельзя было слать сообщения (текст, фото, файлы, голосовые,
            // видеосообщения — всё идёт через этот же путь) человеку, который не в контактах,
            // в обход интерфейса (например, напрямую через API).
            if (room.startsWith('private-') && emailLower) {
                const isMember = await db('SISMEMBER', `user_rooms:${emailLower}`, room);
                if (!isMember) {
                    return response.status(403).json({ status: 'error', message: 'Нельзя писать пользователю, который не в контактах' });
                }
            }

            // Если это настоящая группа (не general, не приватный чат) — проверяем, что она
            // ещё существует. Иначе сообщение "воскрешало" удалённую группу: сервер молча
            // принимал его и заново добавлял комнату в user_rooms отправителя.
            const isRealGroupRoom = room !== 'general' && !room.startsWith('private-');
            if (isRealGroupRoom) {
                const groupExists = await db('EXISTS', `group:${room}`);
                if (!groupExists) {
                    return response.status(410).json({ status: 'error', message: 'Группа была удалена', groupDeleted: true });
                }
            }

            // body может прийти как строка (старый фронт) или объект (новый)
            const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
            await db('LPUSH', `room:${room}`, encodeURIComponent(bodyStr));

            // Добавляем в all_users/user_rooms ТОЛЬКО если профиль реально существует.
            // Раньше это делалось безусловно для любого email, который пришёл в запросе —
            // из-за этого удалённый аккаунт "воскресал": фоновый опрос/отправка сообщения,
            // ушедшие в сеть ДО удаления, но обработанные сервером ПОСЛЕ, возвращали email
            // обратно в all_users, и повторная регистрация с той же почтой блокировалась
            // ("email уже зарегистрирован"), хотя профиль уже был стёрт.
            if (emailLower) {
                const profileExists = await db('EXISTS', `profile:${emailLower}`);
                if (profileExists) {
                    await db('SADD', 'all_users', emailLower);
                    if (!room.startsWith('private-')) {
                        await db('SADD', `user_rooms:${emailLower}`, room);
                    }
                }
            }
            return response.status(200).json({ status: 'ok' });
        }

        // ══════════════════════════════════════════════════════
        //  ЗАГРУЗИТЬ СООБЩЕНИЯ + КОМНАТЫ + КОНТАКТЫ
        // ══════════════════════════════════════════════════════
        const jwtEmail   = await tryAuth(request, env.jwt);
        const emailLower = (jwtEmail ?? user_email ?? '').trim().toLowerCase();

        let messages = await db('LRANGE', `room:${room}`, 0, 50);

        let rooms    = { result: [] };
        let contacts = { result: [] };
        let reads    = {};

        if (emailLower) {
            // Та же защита от "воскрешения" удалённого аккаунта, что и в обработчике
            // отправки сообщений выше: не трогаем all_users/user_rooms, если профиля
            // уже не существует (аккаунт был удалён).
            const profileExists = await db('EXISTS', `profile:${emailLower}`);
            if (profileExists) {
            await db('SADD', 'all_users', emailLower);
            await db('SADD', `user_rooms:${emailLower}`, 'general'); // всегда в general

            // Раз мы загружаем сообщения этой комнаты — значит, пользователь её сейчас
            // просматривает. Отмечаем время прочтения и возвращаем отметки всех участников,
            // чтобы отправитель видел двойную галочку, когда получатель прочитал сообщение.
            await db('HSET', `room_reads:${room}`, emailLower, Date.now());

            const [rawRooms, rawContacts, rawReads, clearedBefore] = await Promise.all([
                db('SMEMBERS', `user_rooms:${emailLower}`),
                db('SMEMBERS', `contacts:${emailLower}`),
                db('HGETALL', `room_reads:${room}`),
                db('HGET', `room_cleared:${room}`, emailLower),
            ]);
            rooms    = { result: rawRooms    ?? [] };
            contacts = { result: rawContacts ?? [] };
            reads    = parseHash(rawReads);

            // "Очистить у себя" — скрываем всё, что было отправлено до этой отметки,
            // только для нас; у остальных участников история остаётся как была.
            if (clearedBefore) {
                const cutoff = Number(clearedBefore);
                messages = (messages ?? []).filter(raw => {
                    try {
                        const m = JSON.parse(decodeURIComponent(raw));
                        return !m.ts || m.ts > cutoff;
                    } catch { return true; }
                });
            }
            }
        }

        return response.status(200).json({ messages: { result: messages ?? [] }, rooms, contacts, reads });

    } catch (err) {
        if (err.status === 401) return response.status(401).json({ status: 'error', message: err.message });
        console.error('[GeLink API]', err);
        return response.status(500).json({ status: 'error', message: 'Internal server error' });
    }
}
