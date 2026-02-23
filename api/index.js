export default async function handler(request, response) {
    const url = "https://giving-bass-54270.upstash.io";
    const token = "AdP-AAIncDE2YmY4MWI5Y2VlZDI0NGI2ODI3ZTlhOTlkZWJhYWNhNHAxNTQyNzA";
    
    const { room = 'general', user_email, action, target_email } = request.query;

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
            return response.status(200).json({ status: 'found', email: query, profile: profile.result || {} });
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
            return response.status(200).json({ status: 'found', email: foundEmail, profile: profile.result || {} });
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
