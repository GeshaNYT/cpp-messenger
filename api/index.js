export default async function handler(request, response) {
    const url = "https://giving-bass-54270.upstash.io";
    const token = "AdP-AAIncDE2YmY4MWI5Y2VlZDI0NGI2ODI3ZTlhOTlkZWJhYWNhNHAxNTQyNzA";
    
    const { room = 'general', user, action, target } = request.query;

    // ЛОГИКА ДОБАВЛЕНИЯ КОНТАКТА
    if (action === 'addContact' && user && target) {
        await fetch(`${url}/sadd/contacts:${user}/${target}`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        return response.status(200).json({ status: 'contact_added' });
    }

    if (request.method === 'POST') {
        const body = request.body;
        // Сохраняем сообщение
        await fetch(`${url}/lpush/room:${room}/${encodeURIComponent(body)}`, {
            headers: { Authorization: `Bearer ${token}` }
        });

        // Автоматически добавляем комнату в список чатов пользователя
        if (user) {
            await fetch(`${url}/sadd/user_rooms:${user}/${room}`, {
                headers: { Authorization: `Bearer ${token}` }
            });
        }
        return response.status(200).json({ status: 'ok' });
    }

    // ЗАГРУЗКА ДАННЫХ
    const res = await fetch(`${url}/lrange/room:${room}/0/50`, {
        headers: { Authorization: `Bearer ${token}` }
    });
    const messages = await res.json();
    
    // Список комнат пользователя
    const roomsRes = await fetch(`${url}/smembers/user_rooms:${user}`, {
        headers: { Authorization: `Bearer ${token}` }
    });
    const rooms = await roomsRes.json();

    // Список контактов пользователя
    const contactsRes = await fetch(`${url}/smembers/contacts:${user}`, {
        headers: { Authorization: `Bearer ${token}` }
    });
    const contacts = await contactsRes.json();

    return response.status(200).json({ messages, rooms, contacts });
}
