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

// ── Основной обработчик ──────────────────────────────────────
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

            const { name, nickname, avColor, password, avImg } = request.body;
            const fields = [];

            if (name)     fields.push('name',     name);
            if (avColor)  fields.push('avColor',  avColor);
            if (password) fields.push('password', await hashPassword(password));

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

        // ══════════════════════════════════════════════════════
        //  СОХРАНЕНИЕ ПРОФИЛЯ  — публичный (вызывается после OTP)
        // ══════════════════════════════════════════════════════
        if (action === 'saveProfile' && user_email && request.method === 'POST') {
            const { nickname, name } = request.body;
            await db('SADD', 'all_users', user_email);
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

            if (await db('SISMEMBER', 'all_users', target_email) !== 1)
                return response.status(404).json({ status: 'error', message: 'User not found' });

            const myId    = emailLower.replace(/[@.]/g, '').toLowerCase();
            const otherId = target_email.replace(/[@.]/g, '').toLowerCase();
            const roomId  = `private-${[myId, otherId].sort().join('-')}`;

            await db('SADD', `contacts:${emailLower}`,   target_email);
            await db('SADD', `user_rooms:${emailLower}`, roomId);
            await db('SADD', `contacts:${target_email}`, emailLower);
            await db('SADD', `user_rooms:${target_email}`, roomId);

            return response.status(200).json({ status: 'success', message: 'Contact added', roomId });
        }

        if (action === 'removeContact' && target_email) {
            const jwtEmail   = await tryAuth(request, env.jwt);
            const emailLower = (jwtEmail ?? user_email ?? '').trim().toLowerCase();

            const myId    = emailLower.replace(/[@.]/g, '').toLowerCase();
            const otherId = target_email.replace(/[@.]/g, '').toLowerCase();
            const roomId  = `private-${[myId, otherId].sort().join('-')}`;

            await db('SREM', `contacts:${emailLower}`,   target_email);
            await db('SREM', `user_rooms:${emailLower}`, roomId);
            return response.status(200).json({ status: 'success', message: 'Contact removed' });
        }

        // ══════════════════════════════════════════════════════
        //  ОТПРАВИТЬ СООБЩЕНИЕ
        // ══════════════════════════════════════════════════════
        if (request.method === 'POST') {
            const body       = request.body;
            const jwtEmail   = await tryAuth(request, env.jwt);
            const emailLower = jwtEmail ?? user_email ?? (typeof body === 'object' ? body?.email : null) ?? '';

            // body может прийти как строка (старый фронт) или объект (новый)
            const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
            await db('LPUSH', `room:${room}`, encodeURIComponent(bodyStr));

            if (emailLower) {
                await db('SADD', 'all_users', emailLower);
                if (!room.startsWith('private-')) {
                    await db('SADD', `user_rooms:${emailLower}`, room);
                }
            }
            return response.status(200).json({ status: 'ok' });
        }

        // ══════════════════════════════════════════════════════
        //  ЗАГРУЗИТЬ СООБЩЕНИЯ + КОМНАТЫ + КОНТАКТЫ
        // ══════════════════════════════════════════════════════
        const jwtEmail   = await tryAuth(request, env.jwt);
        const emailLower = (jwtEmail ?? user_email ?? '').trim().toLowerCase();

        const messages = await db('LRANGE', `room:${room}`, 0, 50);

        let rooms    = { result: [] };
        let contacts = { result: [] };

        if (emailLower) {
            await db('SADD', 'all_users', emailLower);

            const [rawRooms, rawContacts] = await Promise.all([
                db('SMEMBERS', `user_rooms:${emailLower}`),
                db('SMEMBERS', `contacts:${emailLower}`),
            ]);
            rooms    = { result: rawRooms    ?? [] };
            contacts = { result: rawContacts ?? [] };
        }

        return response.status(200).json({ messages: { result: messages ?? [] }, rooms, contacts });

    } catch (err) {
        if (err.status === 401) return response.status(401).json({ status: 'error', message: err.message });
        console.error('[GeLink API]', err);
        return response.status(500).json({ status: 'error', message: 'Internal server error' });
    }
}
