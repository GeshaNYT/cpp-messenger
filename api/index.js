export default async function handler(request, response) {
    const url = "https://giving-bass-54270.upstash.io";
    const token = "AdP-AAIncDE2YmY4MWI5Y2VlZDI0NGI2ODI3ZTlhOTlkZWJhYWNhNHAxNTQyNzA";
    
    // Извлекаем параметры, включая никнейм
    const { room = 'general', user_email, user_nickname, action, target_email } = request.query;
    const headers = { Authorization: `Bearer ${token}` };

    // --- ДОБАВЛЕНИЕ В КОНТАКТЫ (Глобальный поиск) ---
    if (action === 'addContact' && user_email && target_email) {
        const cleanTarget = target_email.replace('@', '').toLowerCase();
        const myEmail = user_email.toLowerCase();

        // Проверяем, существует ли цель (почта или ник) в Redis
        const checkRes = await fetch(`${url}/sismember/all_users/${cleanTarget}`, { headers });
        const isExist = await checkRes.json();

        if (isExist.result === 1) {
            // Создаем уникальный ID комнаты (всегда одинаковый для этой пары людей)
            const mySafe = myEmail.replace(/[@.]/g, '');
            const targetSafe = cleanTarget.replace(/[@.]/g, '');
            const roomId = `private-${[mySafe, targetSafe].sort().join('-')}`;

            // Привязываем комнату к обоим пользователям в Redis
            await fetch(`${url}/sadd/user_rooms:${myEmail}/${roomId}`, { headers });
            await fetch(`${url}/sadd/user_rooms:${cleanTarget}/${roomId}`, { headers });
            
            // Сохраняем в список контактов
            await fetch(`${url}/sadd/contacts:${myEmail}/${cleanTarget}`, { headers });

            return response.status(200).json({ status: 'success', roomId });
        } else {
            return response.status(404).json({ status: 'error', message: 'User not found' });
        }
    }

    // --- ОТПРАВКА СООБЩЕНИЙ (POST) ---
    if (request.method === 'POST') {
        const body = request.body;
        await fetch(`${url}/lpush/room:${room}/${encodeURIComponent(body)}`, { headers });

        if (user_email) {
            const emailLower = user_email.toLowerCase();
            // Регистрируем почту в глобальном поиске
            await fetch(`${url}/sadd/all_users/${emailLower}`, { headers });
            // Привязываем текущую комнату к пользователю
            await fetch(`${url}/sadd/user_rooms:${emailLower}/${room}`, { headers });
            
            // Если передан никнейм, регистрируем и его для поиска
            if (user_nickname) {
                const nickLower = user_nickname.replace('@', '').toLowerCase();
                await fetch(`${url}/sadd/all_users/${nickLower}`, { headers });
            }
        }
        return response.status(200).json({ status: 'ok' });
    }

    // --- ЗАГРУЗКА ДАННЫХ (GET) ---
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
