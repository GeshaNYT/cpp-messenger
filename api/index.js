export default async function handler(request, response) {
    const url = "https://giving-bass-54270.upstash.io";
    const token = "AdP-AAIncDE2YmY4MWI5Y2VlZDI0NGI2ODI3ZTlhOTlkZWJhYWNhNHAxNTQyNzA";
    
    const { room = 'general', user } = request.query;

    if (request.method === 'POST') {
        const body = request.body;
        const msgObj = JSON.parse(body);

        // 1. Сохраняем сообщение в комнату
        await fetch(`${url}/lpush/room:${room}/${encodeURIComponent(body)}`, {
            headers: { Authorization: `Bearer ${token}` }
        });

        // 2. Если это создание группы или первое сообщение, 
        // добавляем комнату в личный список пользователя
        if (user) {
            await fetch(`${url}/sadd/user_rooms:${user}/${room}`, {
                headers: { Authorization: `Bearer ${token}` }
            });
        }
        
        return response.status(200).json({ status: 'ok' });
    }

    // Загружаем сообщения
    const res = await fetch(`${url}/lrange/room:${room}/0/30`, {
        headers: { Authorization: `Bearer ${token}` }
    });
    const messages = await res.json();
    
    // Загружаем список комнат ТОЛЬКО для этого пользователя
    let rooms = { result: ['general'] };
    if (user) {
        const roomsRes = await fetch(`${url}/smembers/user_rooms:${user}`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        rooms = await roomsRes.json();
        if (!rooms.result.includes('general')) rooms.result.push('general');
    }

    return response.status(200).json({ messages, rooms });
}
