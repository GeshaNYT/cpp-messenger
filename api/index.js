export default async function handler(request, response) {
    const url = "https://giving-bass-54270.upstash.io";
    const token = "AdP-AAIncDE2YmY4MWI5Y2VlZDI0NGI2ODI3ZTlhOTlkZWJhYWNhNHAxNTQyNzA";
    
    const { room = 'general', user_email, action, target_email } = request.query;

    // ==================== РЕГИСТРАЦИЯ ====================
    if (action === 'register' && request.method === 'POST') {
        const { email, password, name, nickname, avColor } = request.body;
        if (!email || !password || !name || !nickname) {
            return response.status(400).json({ status: 'error', message: 'Заполните все поля' });
        }
        const emailLower = email.trim().toLowerCase();
        const nickLower = nickname.trim().toLowerCase();

        // Проверяем — email уже занят?
        const existsRes = await fetch(`${url}/sismember/all_users/${emailLower}`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        const existsData = await existsRes.json();
        if (existsData.result === 1) {
            return response.status(400).json({ status: 'error', message: 'Этот email уже зарегистрирован' });
        }

        // Проверяем — ник уже занят?
        const nickCheckRes = await fetch(`${url}/get/nick:${nickLower}`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        const nickCheckData = await nickCheckRes.json();
        if (nickCheckData.result) {
            return response.status(400).json({ status: 'error', message: 'Этот никнейм уже занят' });
        }

        // Сохраняем пользователя
        await fetch(`${url}/sadd/all_users/${emailLower}`, { headers: { Authorization: `Bearer ${token}` } });
        await fetch(`${url}/hset/profile:${emailLower}/name/${encodeURIComponent(name)}`, { headers: { Authorization: `Bearer ${token}` } });
        await fetch(`${url}/hset/profile:${emailLower}/nickname/${encodeURIComponent(nickLower)}`, { headers: { Authorization: `Bearer ${token}` } });
        await fetch(`${url}/hset/profile:${emailLower}/avColor/${encodeURIComponent(avColor || 'var(--ge-accent-gradient)')}`, { headers: { Authorization: `Bearer ${token}` } });
        // Хешируем пароль простым способом (base64 — не продакшн, но работает без crypto в edge)
        const passEncoded = Buffer.from(password).toString('base64');
        await fetch(`${url}/hset/profile:${emailLower}/password/${encodeURIComponent(passEncoded)}`, { headers: { Authorization: `Bearer ${token}` } });
        await fetch(`${url}/set/nick:${nickLower}/${emailLower}`, { headers: { Authorization: `Bearer ${token}` } });

        return response.status(200).json({ status: 'ok' });
    }

    // ==================== ВХОД ====================
    if (action === 'login' && request.method === 'POST') {
        const { email, password } = request.body;
        if (!email || !password) {
            return response.status(400).json({ status: 'error', message: 'Введите email и пароль' });
        }
        const emailLower = email.trim().toLowerCase();

        // Проверяем существование пользователя
        const existsRes = await fetch(`${url}/sismember/all_users/${emailLower}`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        const existsData = await existsRes.json();
        if (existsData.result !== 1) {
            return response.status(401).json({ status: 'error', message: 'Неверный email или пароль' });
        }

        // Получаем профиль
        const profileRes = await fetch(`${url}/hgetall/profile:${emailLower}`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        const profileData = await profileRes.json();
        const rawProfile = profileData.result || [];
        const profile = {};
        if (Array.isArray(rawProfile)) {
            for (let i = 0; i < rawProfile.length; i += 2) {
                profile[rawProfile[i]] = rawProfile[i + 1];
            }
        }

        // Проверяем пароль
        const passEncoded = Buffer.from(password).toString('base64');
        const storedPass = profile.password ? decodeURIComponent(profile.password) : null;
        if (!storedPass || storedPass !== passEncoded) {
            return response.status(401).json({ status: 'error', message: 'Неверный email или пароль' });
        }

        return response.status(200).json({
            status: 'ok',
            user: {
                email: emailLower,
                name: profile.name ? decodeURIComponent(profile.name) : emailLower,
                nickname: profile.nickname ? decodeURIComponent(profile.nickname) : '',
                avColor: profile.avColor ? decodeURIComponent(profile.avColor) : 'var(--ge-accent-gradient)'
            }
        });
    }

    // ==================== ОБНОВЛЕНИЕ ПРОФИЛЯ ====================
    if (action === 'updateProfile' && user_email && request.method === 'POST') {
        const { name, nickname, avColor, password } = request.body;
        const emailLower = user_email.trim().toLowerCase();

        if (name) {
            await fetch(`${url}/hset/profile:${emailLower}/name/${encodeURIComponent(name)}`, { headers: { Authorization: `Bearer ${token}` } });
        }
        if (nickname) {
            const nickLower = nickname.toLowerCase();
            // Удаляем старый ник
            const oldProfileRes = await fetch(`${url}/hget/profile:${emailLower}/nickname`, { headers: { Authorization: `Bearer ${token}` } });
            const oldProfileData = await oldProfileRes.json();
            if (oldProfileData.result) {
                const oldNick = decodeURIComponent(oldProfileData.result);
                await fetch(`${url}/del/nick:${oldNick}`, { headers: { Authorization: `Bearer ${token}` } });
            }
            await fetch(`${url}/hset/profile:${emailLower}/nickname/${encodeURIComponent(nickLower)}`, { headers: { Authorization: `Bearer ${token}` } });
            await fetch(`${url}/set/nick:${nickLower}/${emailLower}`, { headers: { Authorization: `Bearer ${token}` } });
        }
        if (avColor) {
            await fetch(`${url}/hset/profile:${emailLower}/avColor/${encodeURIComponent(avColor)}`, { headers: { Authorization: `Bearer ${token}` } });
        }
        if (password) {
            const passEncoded = Buffer.from(password).toString('base64');
            await fetch(`${url}/hset/profile:${emailLower}/password/${encodeURIComponent(passEncoded)}`, { headers: { Authorization: `Bearer ${token}` } });
        }

        return response.status(200).json({ status: 'ok' });
    }

    // ==================== СИГНАЛИЗАЦИЯ ДЛЯ WebRTC ====================

    // Отправить сигнал (offer / answer / ice / call-request / call-end)
    if (action === 'signal' && request.method === 'POST') {
        const body = request.body; // { type, from, to, payload }
        const { to } = body;
        if (!to) return response.status(400).json({ status: 'error' });

        const key = `signal:${to}`;
        const entry = encodeURIComponent(JSON.stringify(body));

        // Кладём сигнал в список (TTL 60 сек чтобы не копились)
        await fetch(`${url}/lpush/${key}/${entry}`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        await fetch(`${url}/expire/${key}/60`, {
            headers: { Authorization: `Bearer ${token}` }
        });

        return response.status(200).json({ status: 'ok' });
    }

    // Получить входящие сигналы (polling)
    if (action === 'getSignals' && user_email) {
        const key = `signal:${user_email}`;
        const res = await fetch(`${url}/lrange/${key}/0/-1`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        const data = await res.json();

        // Очищаем после прочтения
        await fetch(`${url}/del/${key}`, {
            headers: { Authorization: `Bearer ${token}` }
        });

        const signals = (data.result || []).map(s => {
            try { return JSON.parse(decodeURIComponent(s)); } catch { return null; }
        }).filter(Boolean);

        return response.status(200).json({ status: 'ok', signals });
    }

    // ==================== ПОИСК ПОЛЬЗОВАТЕЛЯ ====================
    if (action === 'findUser' && request.query.query) {
        const query = request.query.query.trim().toLowerCase();

        const byEmailRes = await fetch(`${url}/sismember/all_users/${query}`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        const byEmail = await byEmailRes.json();

        if (byEmail.result === 1) {
            const profileRes = await fetch(`${url}/hgetall/profile:${query}`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            const profile = await profileRes.json();
            // hgetall returns flat array ["key","val","key","val"] - convert to object
            const rawProfile = profile.result || [];
            const profileObj = {};
            if (Array.isArray(rawProfile)) {
                for (let i = 0; i < rawProfile.length; i += 2) {
                    profileObj[rawProfile[i]] = rawProfile[i+1];
                }
            } else if (typeof rawProfile === 'object') {
                Object.assign(profileObj, rawProfile);
            }
            return response.status(200).json({ status: 'found', email: query, profile: profileObj });
        }

        const byNickRes = await fetch(`${url}/get/nick:${query}`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        const byNick = await byNickRes.json();

        if (byNick.result) {
            const foundEmail = byNick.result;
            const profileRes = await fetch(`${url}/hgetall/profile:${foundEmail}`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            const profile = await profileRes.json();
            // hgetall returns flat array ["key","val","key","val"] - convert to object
            const rawProfile2 = profile.result || [];
            const profileObj2 = {};
            if (Array.isArray(rawProfile2)) {
                for (let i = 0; i < rawProfile2.length; i += 2) {
                    profileObj2[rawProfile2[i]] = rawProfile2[i+1];
                }
            } else if (typeof rawProfile2 === 'object') {
                Object.assign(profileObj2, rawProfile2);
            }
            return response.status(200).json({ status: 'found', email: foundEmail, profile: profileObj2 });
        }

        return response.status(404).json({ status: 'error', message: 'User not found' });
    }

    // ==================== СОХРАНЕНИЕ ПРОФИЛЯ ====================
    if (action === 'saveProfile' && user_email && request.method === 'POST') {
        const body = request.body;
        const { nickname, name } = body;

        await fetch(`${url}/sadd/all_users/${user_email}`, {
            headers: { Authorization: `Bearer ${token}` }
        });

        if (name) {
            await fetch(`${url}/hset/profile:${user_email}/name/${encodeURIComponent(name)}`, {
                headers: { Authorization: `Bearer ${token}` }
            });
        }
        if (nickname) {
            const nickLower = nickname.toLowerCase();
            await fetch(`${url}/hset/profile:${user_email}/nickname/${encodeURIComponent(nickLower)}`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            await fetch(`${url}/set/nick:${nickLower}/${user_email}`, {
                headers: { Authorization: `Bearer ${token}` }
            });
        }

        return response.status(200).json({ status: 'ok' });
    }

    // ==================== КОНТАКТЫ ====================
    if (action === 'addContact' && user_email && target_email) {
        const checkRes = await fetch(`${url}/sismember/all_users/${target_email}`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        const isExist = await checkRes.json();

        if (isExist.result === 1) {
            const myMailSafe = user_email.replace(/[@.]/g, '').toLowerCase();
            const otherMailSafe = target_email.replace(/[@.]/g, '').toLowerCase();
            const roomId = `private-${[myMailSafe, otherMailSafe].sort().join('-')}`;

            await fetch(`${url}/sadd/contacts:${user_email}/${target_email}`, { headers: { Authorization: `Bearer ${token}` } });
            await fetch(`${url}/sadd/user_rooms:${user_email}/${roomId}`, { headers: { Authorization: `Bearer ${token}` } });
            await fetch(`${url}/sadd/contacts:${target_email}/${user_email}`, { headers: { Authorization: `Bearer ${token}` } });
            await fetch(`${url}/sadd/user_rooms:${target_email}/${roomId}`, { headers: { Authorization: `Bearer ${token}` } });

            return response.status(200).json({ status: 'success', message: 'Contact added', roomId });
        } else {
            return response.status(404).json({ status: 'error', message: 'User not found' });
        }
    }

    if (action === 'removeContact' && user_email && target_email) {
        const myMailSafe = user_email.replace(/[@.]/g, '').toLowerCase();
        const otherMailSafe = target_email.replace(/[@.]/g, '').toLowerCase();
        const roomId = `private-${[myMailSafe, otherMailSafe].sort().join('-')}`;

        await fetch(`${url}/srem/contacts:${user_email}/${target_email}`, { headers: { Authorization: `Bearer ${token}` } });
        await fetch(`${url}/srem/user_rooms:${user_email}/${roomId}`, { headers: { Authorization: `Bearer ${token}` } });

        return response.status(200).json({ status: 'success', message: 'Contact removed' });
    }

    // ==================== СООБЩЕНИЯ ====================
    if (request.method === 'POST') {
        const body = request.body;
        await fetch(`${url}/lpush/room:${room}/${encodeURIComponent(body)}`, {
            headers: { Authorization: `Bearer ${token}` }
        });

        if (user_email) {
            await fetch(`${url}/sadd/all_users/${user_email}`, { headers: { Authorization: `Bearer ${token}` } });
            if (!room.startsWith('private-')) {
                await fetch(`${url}/sadd/user_rooms:${user_email}/${room}`, { headers: { Authorization: `Bearer ${token}` } });
            }
        }
        return response.status(200).json({ status: 'ok' });
    }

    // ==================== ЗАГРУЗКА ДАННЫХ ====================
    const res = await fetch(`${url}/lrange/room:${room}/0/50`, {
        headers: { Authorization: `Bearer ${token}` }
    });
    const messages = await res.json();
    
    let rooms = { result: [] };
    let contacts = { result: [] };

    if (user_email) {
        await fetch(`${url}/sadd/all_users/${user_email}`, { headers: { Authorization: `Bearer ${token}` } });

        const rRes = await fetch(`${url}/smembers/user_rooms:${user_email}`, { headers: { Authorization: `Bearer ${token}` } });
        rooms = await rRes.json();

        const cRes = await fetch(`${url}/smembers/contacts:${user_email}`, { headers: { Authorization: `Bearer ${token}` } });
        contacts = await cRes.json();
    }

    return response.status(200).json({ messages, rooms, contacts });
}
