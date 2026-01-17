export default async function handler(request, response) {
    const url = "https://giving-bass-54270.upstash.io";
    const token = "AdP-AAIncDE2YmY4MWI5Y2VlZDI0NGI2ODI3ZTlhOTlkZWJhYWNhNHAxNTQyNzA";
    
    const { room = 'general', user_email, action, target_email } = request.query;

    // ДОБАВЛЕНИЕ В КОНТАКТЫ С ПРОВЕРКОЙ
    if (action === 'addContact' && user_email && target_email) {
        // 1. Проверяем, есть ли такой пользователь в системе
        const checkRes = await fetch(`${url}/sismember/all_users/${target_email}`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        const isExist = await checkRes.json();

        if (isExist.result === 1) {
            // 2. Если существует — добавляем в список контактов
            await fetch(`${url}/sadd/contacts:${user_email}/${target_email}`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            return response.status(200).json({ status: 'success', message: 'Contact added' });
        } else {
            // 3. Если не существует — возвращаем ошибку
            return response.status(404).json({ status: 'error', message: 'User not found' });
        }
    }

    if (request.method === 'POST') {
        const body = request.body;
        
        // --- ЛОГИКА РЕГИСТРАЦИИ (Добавьте это в ваш код регистрации на сервере!) ---
        // При создании аккаунта нужно делать: sadd/all_users/email
        // Чтобы проверка выше могла найти этот email.
        
        await fetch(`${url}/lpush/room:${room}/${encodeURIComponent(body)}`, {
            headers: { Authorization: `Bearer ${token}` }
        });

        if (user_email) {
            // Также добавляем пользователя в общий список при активности (для надежности)
            await fetch(`${url}/sadd/all_users/${user_email}`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            
            await fetch(`${url}/sadd/user_rooms:${user_email}/${room}`, {
                headers: { Authorization: `Bearer ${token}` }
            });
        }
        return response.status(200).json({ status: 'ok' });
    }

    // ЗАГРУЗКА СООБЩЕНИЙ И КОНТАКТОВ
    const res = await fetch(`${url}/lrange/room:${room}/0/50`, {
        headers: { Authorization: `Bearer ${token}` }
    });
    const messages = await res.json();
    
    let rooms = { result: [] };
    let contacts = { result: [] };

    if (user_email) {
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
