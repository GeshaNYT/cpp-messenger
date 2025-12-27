export default async function handler(request, response) {
    const url = "https://giving-bass-54270.upstash.io";
    const token = "AdP-AAIncDE2YmY4MWI5Y2VlZDI0NGI2ODI3ZTlhOTlkZWJhYWNhNHAxNTQyNzA";
    
    // Получаем название комнаты из параметров или тела запроса
    const { room = 'general' } = request.query;

    if (request.method === 'POST') {
        const body = request.body; 
        // Сохраняем в список конкретной комнаты
        await fetch(`${url}/lpush/room:${room}/${encodeURIComponent(body)}`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        // Добавляем имя комнаты в общий список всех чатов, чтобы их можно было найти
        await fetch(`${url}/sadd/all_rooms/${room}`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        return response.status(200).json({ status: 'ok' });
    }

    // Загружаем сообщения для конкретной комнаты
    const res = await fetch(`${url}/lrange/room:${room}/0/30`, {
        headers: { Authorization: `Bearer ${token}` }
    });
    const messages = await res.json();
    
    // Загружаем список всех существующих комнат
    const roomsRes = await fetch(`${url}/smembers/all_rooms`, {
        headers: { Authorization: `Bearer ${token}` }
    });
    const rooms = await roomsRes.json();

    return response.status(200).json({ messages, rooms });
}
