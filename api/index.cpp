#include <iostream>
#include <cstdlib>
#include <string>

using namespace std;

int main() {
    // ДАННЫЕ ИЗ UPSTASH (REST API)
    string url = "https://giving-bass-54270.upstash.io"; 
    string token = "AdP-AAIncDE2YmY4MWI5Y2VlZDI0NGI2ODI3ZTlhOTlkZWJhYWNhNHAxNTQyNzA";

    cout << "Content-Type: application/json\n\n";

    string input;
    getline(cin, input); // Получаем сообщение от пользователя

    if (!input.empty()) {
        // Отправляем в Redis
        string cmd = "curl -s -H \"Authorization: Bearer " + token + "\" " + url + "/lpush/chat/" + input;
        system(cmd.c_str());
        cout << "{\"status\":\"ok\"}";
    } else {
        // Забираем из Redis последние 20 сообщений
        string cmd = "curl -s -H \"Authorization: Bearer " + token + "\" " + url + "/lrange/chat/0/20";
        system(cmd.c_str());
    }
    return 0;
}
