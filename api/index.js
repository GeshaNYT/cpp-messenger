export default async function handler(request, response) {
    const url = "https://giving-bass-54270.upstash.io";
    const token = "AdP-AAIncDE2YmY4MWI5Y2VlZDI0NGI2ODI3ZTlhOTlkZWJhYWNhNHAxNTQyNzA";
    
    // Добавляем user_nickname в извлечение параметров
    const { room = 'general', user_email, user_nickname, action, target_email } = request.query;

    const headers = { Authorization: `Bearer ${token}` };

    // --- 1. ДОБАВЛЕНИЕ В КОНТАКТЫ (ГЛОБАЛЬНЫЙ ПОИСК) ---
    if (action === 'addContact' && user_email && target_email) {
        // Чистим ввод (убираем @ если есть)
        const cleanTarget = target_email.replace('@', '').toLowerCase();

        // Проверяем, есть ли цель в общем списке пользователей (почта или ник)
        const checkRes = await fetch(`${url}/sismember/all_users/${cleanTarget}`, { headers });
        const isExist = await checkRes.json();

        if (isExist.result === 1) {
            // Добавляем в список контактов отправителя
            await fetch(`${url}/sadd/contacts:${user_email.toLowerCase()}/${cleanTarget}`, { headers });
            
            // Сразу регистрируем связь в базе, чтобы чат появился у обоих
            // Создаем безопасный ID комнаты для двоих
            const mySafe = user_email.replace(/[@.]/g, '').toLowerCase();
            const targetSafe = cleanTarget.replace(/[@.]/g, '').toLowerCase();
            const roomId = `private-${[mySafe, targetSafe].sort().join('-')}`;

            // Привязываем комнату к обоим пользователям в Redis
            await fetch(`${url}/sadd/user_rooms:${user_email.toLowerCase()}/${roomId}`, { headers });
            await fetch(`${url}/sadd/user_rooms:${cleanTarget}/${roomId}`, { headers });

            return response.status(200).json({ status: 'success', roomId });
        } else {
            return response.status(404).json({ status: 'error', message: 'User not found' });
        }
    }

    // --- 2. ОТПРАВКА СООБЩЕНИЯ (POST) ---
    if (request.method === 'POST') {
        const body = request.body;
        
        // Сохраняем сообщение в список комнаты
        await fetch(`${url}/lpush/room:${room}/${encodeURIComponent(body)}`, { headers });

        // РЕГИСТРАЦИЯ ПОЛЬЗОВАТЕЛЯ В ГЛОБАЛЬНОЙ БАЗЕ
        if (user_email) {
            const emailLower = user_email.toLowerCase();
            // Сохраняем почту
            await fetch(`${url}/sadd/all_users/${emailLower}`, { headers });
            // Привязываем комнату к пользователю
            await fetch(`${url}/sadd/user_rooms:${emailLower}/${room}`, { headers });
        }

        if (user_nickname) {
            const nickLower = user_nickname.replace('@', '').toLowerCase();
            // Сохраняем никнейм в ту же базу для поиска
            await fetch(`${url}/sadd/all_users/${nickLower}`, { headers });
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
        
        // Получаем список комнат пользователя
        const rRes = await fetch(`${url}/smembers/user_rooms:${emailLower}`, { headers });
        rooms = await rRes.json();

        // Получаем список контактов пользователя
        const cRes = await fetch(`${url}/smembers/contacts:${emailLower}`, { headers });
        contacts = await cRes.json();
    }

    return response.status(200).json({ messages, rooms, contacts });
}
