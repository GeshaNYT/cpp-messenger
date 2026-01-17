export default async function handler(request, response) {
    const url = "https://giving-bass-54270.upstash.io";
    const token = "AdP-AAIncDE2YmY4MWI5Y2VlZDI0NGI2ODI3ZTlhOTlkZWJhYWNhNHAxNTQyNzA";
    const headers = { Authorization: `Bearer ${token}` };

    const { room = 'general', user_email, user_nickname, action, target_email } = request.query;

    // РЕГИСТРАЦИЯ ПРИ КАЖДОМ ЗАПРОСЕ (Важно!)
    if (user_email) {
        const emailLower = user_email.toLowerCase();
        // Записываем почту
        await fetch(`${url}/sadd/all_users/${emailLower}`, { headers });
        
        // Записываем ник (если он есть), чтобы по нему тоже находило
        if (user_nickname) {
            const nickLower = user_nickname.replace('@', '').toLowerCase();
            await fetch(`${url}/sadd/all_users/${nickLower}`, { headers });
        }
    }

    // ЛОГИКА ДОБАВЛЕНИЯ
    if (action === 'addContact' && user_email && target_email) {
        const target = target_email.replace('@', '').toLowerCase();
        
        // Теперь этот запрос точно вернет 1, так как пользователь выше уже зарегистрировался
        const check = await fetch(`${url}/sismember/all_users/${target}`, { headers });
        const isExist = await check.json();

        if (isExist.result === 1) {
            const mySafe = user_email.replace(/[@.]/g, '').toLowerCase();
            const targetSafe = target.replace(/[@.]/g, '').toLowerCase();
            const roomId = `private-${[mySafe, targetSafe].sort().join('-')}`;

            await fetch(`${url}/sadd/user_rooms:${user_email.toLowerCase()}/${roomId}`, { headers });
            await fetch(`${url}/sadd/user_rooms:${target}/${roomId}`, { headers });
            
            return response.status(200).json({ status: 'success', roomId });
        }
        return response.status(404).json({ status: 'error', message: 'Not found' });
    }

    // --- 2. ОТПРАВКА СООБЩЕНИЙ (POST) ---
    if (request.method === 'POST') {
        const body = request.body;
        await fetch(`${url}/lpush/room:${room}/${encodeURIComponent(body)}`, { headers });

        if (user_email) {
            const emailLower = user_email.toLowerCase();
            // Регистрируем почту в общем списке поиска
            await fetch(`${url}/sadd/all_users/${emailLower}`, { headers });
            // Привязываем комнату к пользователю
            await fetch(`${url}/sadd/user_rooms:${emailLower}/${room}`, { headers });
            
            // Если передан никнейм, регистрируем его в ту же базу поиска
            if (user_nickname) {
                const nickLower = user_nickname.replace('@', '').toLowerCase();
                await fetch(`${url}/sadd/all_users/${nickLower}`, { headers });
            }
        }
        return response.status(200).json({ status: 'ok' });
    }

    // --- 3. ЗАГРУЗКА ДАННЫХ (GET) ---
    const res = await fetch(`${url}/lrange/room:${room}/0/50`, { headers });
    const messages = await res.json();
    
    let rooms = { result: [] };
    let contacts = { result: [] };

    if (user_email) {
        const emailLower = user_email.toLowerCase();
        const rRes = await fetch(`${url}/smembers/user_rooms:${emailLower}`, { headers });
        rooms = await rRes.json();
        const cRes = await fetch(`${url}/smembers/contacts:${emailLower}`, { headers });
        contacts = await cRes.json();
    }

    return response.status(200).json({ messages, rooms, contacts });
}
