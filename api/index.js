export default async function handler(request, response) {
    const url = "https://giving-bass-54270.upstash.io";
    const token = "AdP-AAIncDE2YmY4MWI5Y2VlZDI0NGI2ODI3ZTlhOTlkZWJhYWNhNHAxNTQyNzA";
    
    // Берем email текущего пользователя и email цели (target)
    const { room = 'general', user_email, action, target_email } = request.query;

    // ДОБАВЛЕНИЕ В КОНТАКТЫ ПО EMAIL
    if (action === 'addContact' && user_email && target_email) {
        await fetch(`${url}/sadd/contacts:${user_email}/${target_email}`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        return response.status(200).json({ status: 'contact_added' });
    }

    if (request.method === 'POST') {
        const body = request.body;
        await fetch(`${url}/lpush/room:${room}/${encodeURIComponent(body)}`, {
            headers: { Authorization: `Bearer ${token}` }
        });

        // Привязываем комнату к email пользователя
        if (user_email) {
            await fetch(`${url}/sadd/user_rooms:${user_email}/${room}`, {
                headers: { Authorization: `Bearer ${token}` }
            });
        }
        return response.status(200).json({ status: 'ok' });
    }

    // ЗАГРУЗКА
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
