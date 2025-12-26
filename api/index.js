// Мы используем JavaScript, чтобы точно заработало на Vercel, 
// но логика остается той же — общение с твоим Redis
export default async function handler(request, response) {
    const url = "https://giving-bass-54270.upstash.io";
    const token = "AdP-AAIncDE2YmY4MWI5Y2VlZDI0NGI2ODI3ZTlhOTlkZWJhYWNhNHAxNTQyNzA";
    
    // Если пришло сообщение (POST)
    if (request.method === 'POST') {
        const body = request.body;
        await fetch(`${url}/lpush/chat/${body}`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        return response.status(200).json({ status: 'ok' });
    }

    // Если просто загрузка чата (GET)
    const res = await fetch(`${url}/lrange/chat/0/20`, {
        headers: { Authorization: `Bearer ${token}` }
    });
    const data = await res.json();
    return response.status(200).json(data);
}
