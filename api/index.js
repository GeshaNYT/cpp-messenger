// ============================================================
//  GeLink API — index.js
//  Улучшения: JWT авторизация, Redis-хелпер, нет injection
// ============================================================

import { SignJWT, jwtVerify } from 'jose';

// ── Константы ────────────────────────────────────────────────
const JWT_ALG = 'HS256';
const JWT_TTL = '7d';

// ── Хелперы ──────────────────────────────────────────────────

/** SHA-256 хеш пароля */
async function hashPassword(password) {
    const data = new TextEncoder().encode(password);
    const buf  = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(buf))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

/**
 * Единый клиент Upstash REST API.
 * Использует тело запроса — никакой конкатенации в URL.
 *
 * @example
 * await redis(env, 'HSET', 'profile:user@example.com', 'name', 'Иван')
 * await redis(env, 'SISMEMBER', 'all_users', 'user@example.com')
 */
async function redis(env, ...args) {
    const res = await fetch(env.url, {
        method: 'POST',
        headers: {
            Authorization:  `Bearer ${env.token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(args),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Redis error ${res.status}: ${text}`);
    }
    const json = await res.json();
    return json.result;
}

/** Получить секрет JWT как Uint8Array (нужно для jose) */
function jwtSecret(secret) {
    return new TextEncoder().encode(secret);
}

/** Выдать JWT токен */
async function signToken(payload, secret) {
    return new SignJWT(payload)
        .setProtectedHeader({ alg: JWT_ALG })
        .setExpirationTime(JWT_TTL)
        .setIssuedAt()
        .sign(jwtSecret(secret));
}

/**
 * Проверить JWT из заголовка Authorization.
 * Бросает ошибку, если токен невалиден или отсутствует.
 * Возвращает payload: { email, ... }
 */
async function requireAuth(request, secret) {
    const header = request.headers.get?.('authorization')
        ?? request.headers['authorization']
        ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw Object.assign(new Error('Unauthorized'), { status: 401 });

    try {
        const { payload } = await jwtVerify(token, jwtSecret(secret));
        return payload;
    } catch {
        throw Object.assign(new Error('Invalid or expired token'), { status: 401 });
    }
}

/** Прочитать тело запроса (Vercel передаёт уже распарсенный объект) */
function getBody(request) {
    return request.body ?? {};
}

/** Унифицированный парсер hgetall → объект */
function parseHash(rawArray) {
    const out = {};
    if (!Array.isArray(rawArray)) return out;
    for (let i = 0; i < rawArray.length; i += 2) {
        out[rawArray[i]] = rawArray[i + 1];
    }
    return out;
}

// ── Основной обработчик ──────────────────────────────────────

export default async function handler(request, response) {
    const env = {
        url:    process.env.UPSTASH_URL,
        token:  process.env.UPSTASH_TOKEN,
        jwt:    process.env.JWT_SECRET,
    };

    if (!env.url || !env.token || !env.jwt) {
        return response.status(500).json({
            status: 'error',
            message: 'Server misconfigured: missing env vars (UPSTASH_URL / UPSTASH_TOKEN / JWT_SECRET)',
        });
    }

    // Удобный хелпер с уже привязанным env
    const db = (...args) => redis(env, ...args);

    const query = request.query ?? {};
    const { room = 'general', user_email, action, target_email } = query;

    // Оборачиваем всё в try/catch — один обработчик ошибок
    try {

        // ══════════════════════════════════════════════════════
        //  РЕГИСТРАЦИЯ  /api/index?action=register  POST
        // ══════════════════════════════════════════════════════
        if (action === 'register' && request.method === 'POST') {
            const { email, password, name, nickname, avColor } = getBody(request);

            if (!email || !password || !name || !nickname) {
                return response.status(400).json({ status: 'error', message: 'Заполните все поля' });
            }

            const emailLower = email.trim().toLowerCase();
            const nickLower  = nickname.trim().toLowerCase();

            // Email занят?
            const emailExists = await db('SISMEMBER', 'all_users', emailLower);
            if (emailExists === 1) {
                return response.status(400).json({ status: 'error', message: 'Этот email уже зарегистрирован' });
            }

            // Никнейм занят?
            const nickOwner = await db('GET', `nick:${nickLower}`);
            if (nickOwner) {
                return response.status(400).json({ status: 'error', message: 'Этот никнейм уже занят' });
            }

            const passHash = await hashPassword(password);

            // Атомарно сохраняем пользователя
            await db('SADD', 'all_users', emailLower);
            await db('HSET',
                `profile:${emailLower}`,
                'name',     name,
                'nickname', nickLower,
                'avColor',  avColor || 'var(--ge-accent-gradient)',
                'password', passHash,
            );
            await db('SET', `nick:${nickLower}`, emailLower);

            return response.status(200).json({ status: 'ok' });
        }

        // ══════════════════════════════════════════════════════
        //  ВХОД  /api/index?action=login  POST
        // ══════════════════════════════════════════════════════
        if (action === 'login' && request.method === 'POST') {
            const { email, password } = getBody(request);

            if (!email || !password) {
                return response.status(400).json({ status: 'error', message: 'Введите email и пароль' });
            }

            const emailLower = email.trim().toLowerCase();

            const exists = await db('SISMEMBER', 'all_users', emailLower);
            if (exists !== 1) {
                return response.status(401).json({ status: 'error', message: 'Неверный email или пароль' });
            }

            const rawProfile = await db('HGETALL', `profile:${emailLower}`);
            const profile    = parseHash(rawProfile);

            if (!profile.password) {
                return response.status(401).json({ status: 'error', message: 'Неверный email или пароль' });
            }

            const passHash   = await hashPassword(password);
            const storedPass = profile.password;

            // Поддержка legacy base64 паролей (старые аккаунты)
            const isLegacy = storedPass.length !== 64 || !/^[0-9a-f]+$/.test(storedPass);
            let passwordOk  = false;

            if (isLegacy) {
                let legacyHash;
                try {
                    legacyHash = Buffer.from(password).toString('base64');
                } catch {
                    legacyHash = btoa(unescape(encodeURIComponent(password)));
                }
                const decoded = storedPass.startsWith('%') ? decodeURIComponent(storedPass) : storedPass;
                passwordOk = decoded === legacyHash;

                // Мигрируем на SHA-256
                if (passwordOk) {
                    await db('HSET', `profile:${emailLower}`, 'password', passHash);
                }
            } else {
                passwordOk = storedPass === passHash;
            }

            if (!passwordOk) {
                return response.status(401).json({ status: 'error', message: 'Неверный email или пароль' });
            }

            // Выдаём JWT
            const jwtToken = await signToken({ email: emailLower }, env.jwt);

            return response.status(200).json({
                status: 'ok',
                token: jwtToken,
                user: {
                    email:    emailLower,
                    name:     profile.name     ?? emailLower,
                    nickname: profile.nickname ?? '',
                    avColor:  profile.avColor  ?? 'var(--ge-accent-gradient)',
                    avImg:    profile.avImg     ?? null,
                },
            });
        }

        // ══════════════════════════════════════════════════════
        //  ОБНОВЛЕНИЕ ПРОФИЛЯ  ?action=updateProfile  POST  🔒
        // ══════════════════════════════════════════════════════
        if (action === 'updateProfile' && request.method === 'POST') {
            // Проверяем токен — получаем email из него, не из query!
            const auth       = await requireAuth(request, env.jwt);
            const emailLower = auth.email; // доверяем только токену

            const { name, nickname, avColor, password, avImg } = getBody(request);
            const fields = [];

            if (name)     fields.push('name',     name);
            if (avColor)  fields.push('avColor',  avColor);
            if (password) fields.push('password', await hashPassword(password));

            if (nickname) {
                const nickLower = nickname.toLowerCase();

                // Удаляем старый ник
                const oldNick = await db('HGET', `profile:${emailLower}`, 'nickname');
                if (oldNick) await db('DEL', `nick:${oldNick}`);

                fields.push('nickname', nickLower);
                await db('SET', `nick:${nickLower}`, emailLower);
            }

            if (avImg !== undefined) {
                if (avImg) {
                    fields.push('avImg', avImg);
                } else {
                    await db('HDEL', `profile:${emailLower}`, 'avImg');
                }
            }

            if (fields.length > 0) {
                await db('HSET', `profile:${emailLower}`, ...fields);
            }

            return response.status(200).json({ status: 'ok' });
        }

        // ══════════════════════════════════════════════════════
        //  WebRTC СИГНАЛИЗАЦИЯ  ?action=signal  POST  🔒
        // ══════════════════════════════════════════════════════
        if (action === 'signal' && request.method === 'POST') {
            await requireAuth(request, env.jwt);

            const body = getBody(request);
            const { to } = body;
            if (!to) return response.status(400).json({ status: 'error', message: 'Missing "to"' });

            const key   = `signal:${to}`;
            const entry = JSON.stringify(body);

            await db('LPUSH', key, entry);
            await db('EXPIRE', key, 60);

            return response.status(200).json({ status: 'ok' });
        }

        if (action === 'getSignals' && request.method === 'GET') {
            const auth = await requireAuth(request, env.jwt);
            const key  = `signal:${auth.email}`;

            const raw     = await db('LRANGE', key, 0, -1);
            await db('DEL', key);

            const signals = (raw ?? []).map(s => {
                try { return JSON.parse(s); } catch { return null; }
            }).filter(Boolean);

            return response.status(200).json({ status: 'ok', signals });
        }

        // ══════════════════════════════════════════════════════
        //  ПОИСК ПОЛЬЗОВАТЕЛЯ  ?action=findUser&query=...  GET  🔒
        // ══════════════════════════════════════════════════════
        if (action === 'findUser') {
            await requireAuth(request, env.jwt);

            const q = (query.query ?? '').trim().toLowerCase();
            if (!q) return response.status(400).json({ status: 'error', message: 'Empty query' });

            // Пробуем по email
            const byEmail = await db('SISMEMBER', 'all_users', q);
            const foundEmail = byEmail === 1
                ? q
                : await db('GET', `nick:${q}`); // Пробуем по нику

            if (!foundEmail) {
                return response.status(404).json({ status: 'error', message: 'User not found' });
            }

            const rawProfile = await db('HGETALL', `profile:${foundEmail}`);
            const profile    = parseHash(rawProfile);
            delete profile.password; // никогда не отдаём хеш клиенту

            return response.status(200).json({ status: 'found', email: foundEmail, profile });
        }

        // ══════════════════════════════════════════════════════
        //  КОНТАКТЫ  🔒
        // ══════════════════════════════════════════════════════
        if (action === 'addContact' && target_email) {
            const auth       = await requireAuth(request, env.jwt);
            const emailLower = auth.email;

            const exists = await db('SISMEMBER', 'all_users', target_email);
            if (exists !== 1) {
                return response.status(404).json({ status: 'error', message: 'User not found' });
            }

            const myId    = emailLower.replace(/[@.]/g, '').toLowerCase();
            const otherId = target_email.replace(/[@.]/g, '').toLowerCase();
            const roomId  = `private-${[myId, otherId].sort().join('-')}`;

            await db('SADD', `contacts:${emailLower}`,   target_email);
            await db('SADD', `user_rooms:${emailLower}`, roomId);
            await db('SADD', `contacts:${target_email}`, emailLower);
            await db('SADD', `user_rooms:${target_email}`, roomId);

            return response.status(200).json({ status: 'success', roomId });
        }

        if (action === 'removeContact' && target_email) {
            const auth       = await requireAuth(request, env.jwt);
            const emailLower = auth.email;

            const myId    = emailLower.replace(/[@.]/g, '').toLowerCase();
            const otherId = target_email.replace(/[@.]/g, '').toLowerCase();
            const roomId  = `private-${[myId, otherId].sort().join('-')}`;

            await db('SREM', `contacts:${emailLower}`,   target_email);
            await db('SREM', `user_rooms:${emailLower}`, roomId);

            return response.status(200).json({ status: 'success' });
        }

        // ══════════════════════════════════════════════════════
        //  ОТПРАВИТЬ СООБЩЕНИЕ  POST /api/index?room=...  🔒
        // ══════════════════════════════════════════════════════
        if (request.method === 'POST') {
            const auth       = await requireAuth(request, env.jwt);
            const emailLower = auth.email; // берём из токена, не из query

            const body = getBody(request);

            // Убеждаемся, что в сообщении стоит правильный email
            body.email = emailLower;

            await db('LPUSH', `room:${room}`, JSON.stringify(body));
            await db('LTRIM', `room:${room}`, 0, 99); // не храним больше 100 сообщений

            await db('SADD', 'all_users', emailLower);
            if (!room.startsWith('private-')) {
                await db('SADD', `user_rooms:${emailLower}`, room);
            }

            return response.status(200).json({ status: 'ok' });
        }

        // ══════════════════════════════════════════════════════
        //  ЗАГРУЗИТЬ СООБЩЕНИЯ  GET /api/index?room=...  🔒
        // ══════════════════════════════════════════════════════
        const auth       = await requireAuth(request, env.jwt);
        const emailLower = auth.email;

        const [rawMessages, rawRooms, rawContacts] = await Promise.all([
            db('LRANGE', `room:${room}`, 0, 50),
            db('SMEMBERS', `user_rooms:${emailLower}`),
            db('SMEMBERS', `contacts:${emailLower}`),
        ]);

        // Регистрируем пользователя как активного
        await db('SADD', 'all_users', emailLower);

        return response.status(200).json({
            messages: { result: rawMessages ?? [] },
            rooms:    { result: rawRooms    ?? [] },
            contacts: { result: rawContacts ?? [] },
        });

    } catch (err) {
        // Перехватываем ошибки авторизации
        if (err.status === 401) {
            return response.status(401).json({ status: 'error', message: err.message });
        }
        console.error('[GeLink API]', err);
        return response.status(500).json({ status: 'error', message: 'Internal server error' });
    }
}
