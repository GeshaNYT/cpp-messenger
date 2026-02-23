export default async function handler(request, response) {
    const url = "https://giving-bass-54270.upstash.io";
    const token = "AdP-AAIncDE2YmY4MWI5Y2VlZDI0NGI2ODI3ZTlhOTlkZWJhYWNhNHAxNTQyNzA";
    
    const { room = 'general', user_email, action, target_email } = request.query;

    // ДОБАВЛЕНИЕ В КОНТАКТЫ — ДВУСТОРОННЕЕ
    if (action === 'addContact' && user_email && target_email) {
        // 1. Проверяем, есть ли такой пользователь в системе
        const checkRes = await fetch(`${url}/sismember/all_users/${target_email}`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        const isExist = await checkRes.json();

        if (isExist.result === 1) {
            // 2. Формируем ID приватной комнаты (одинаковый для обоих)
            const myMailSafe = user_email.replace(/[@.]/g, '').toLowerCase();
            const otherMailSafe = target_email.replace(/[@.]/g, '').toLowerCase();
            const roomId = `private-${[myMailSafe, otherMailSafe].sort().join('-')}`;

            // 3. Добавляем контакт и комнату ИНИЦИАТОРУ
            await fetch(`${url}/sadd/contacts:${user_email}/${target_email}`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            await fetch(`${url}/sadd/user_rooms:${user_email}/${roomId}`, {
                headers: { Authorization: `Bearer ${token}` }
            });

            // 4. Добавляем контакт и комнату ВТОРОМУ ПОЛЬЗОВАТЕЛЮ (двустороннее!)
            await fetch(`${url}/sadd/contacts:${target_email}/${user_email}`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            await fetch(`${url}/sadd/user_rooms:${target_email}/${roomId}`, {
                headers: { Authorization: `Bearer ${token}` }
            });

            return response.status(200).json({ status: 'success', message: 'Contact added', roomId });
        } else {
            return response.status(404).json({ status: 'error', message: 'User not found' });
        }
    }

    // УДАЛЕНИЕ КОНТАКТА — ОДНОСТОРОННЕЕ (убираем только у себя)
    if (action === 'removeContact' && user_email && target_email) {
        const myMailSafe = user_email.replace(/[@.]/g, '').toLowerCase();
        const otherMailSafe = target_email.replace(/[@.]/g, '').toLowerCase();
        const roomId = `private-${[myMailSafe, otherMailSafe].sort().join('-')}`;

        await fetch(`${url}/srem/contacts:${user_email}/${target_email}`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        await fetch(`${url}/srem/user_rooms:${user_email}/${roomId}`, {
            headers: { Authorization: `Bearer ${token}` }
        });

        return response.status(200).json({ status: 'success', message: 'Contact removed' });
    }

    if (request.method === 'POST') {
        const body = request.body;
        
        await fetch(`${url}/lpush/room:${room}/${encodeURIComponent(body)}`, {
            headers: { Authorization: `Bearer ${token}` }
        });

        if (user_email) {
            // Регистрируем пользователя в общем списке
            await fetch(`${url}/sadd/all_users/${user_email}`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            
            // Добавляем комнату только если это НЕ приватная (приватные добавляются через addContact)
            if (!room.startsWith('private-')) {
                await fetch(`${url}/sadd/user_rooms:${user_email}/${room}`, {
                    headers: { Authorization: `Bearer ${token}` }
                });
            }
        }
        return response.status(200).json({ status: 'ok' });
    }

    // ЗАГРУЗКА СООБЩЕНИЙ, КОМНАТ И КОНТАКТОВ
    const res = await fetch(`${url}/lrange/room:${room}/0/50`, {
        headers: { Authorization: `Bearer ${token}` }
    });
    const messages = await res.json();
    
    let rooms = { result: [] };
    let contacts = { result: [] };

    if (user_email) {
        // Регистрируем пользователя в all_users при каждом запросе (для надёжности)
        await fetch(`${url}/sadd/all_users/${user_email}`, {
            headers: { Authorization: `Bearer ${token}` }
        });

        const rRes = await fetch(`${url}/smembers/user_rooms:${user_email}`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        rooms = await rRes.json();

        const cRes = await fetch(`${url}/smembers/contacts:${user_email}`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        contacts = await cRes.json();
    }

    return response.status(200).json({ messages, rooms, contacts });
}
