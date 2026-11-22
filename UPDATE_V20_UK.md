# Оновлення v20 — 29 жовтня 2026

Виправлено вертикальне відображення назв файлів по одній літері. Картка файла віддає окремий рядок кнопкам; назва, виконавець та опис отримують доступну ширину й нормально переносяться. Виправлення діє у вікні завдання та списках матеріалів. Оновлено версію CSS для обходу старого кешу.

Перевірено у браузері у вікні завдання: текст займає 310 px з картки шириною 432 px, кнопки під текстом, горизонтального переповнення немає.

## Установлення поверх v19

```bash
mkdir -p ~/releases/v20
cd ~/releases/v20
curl -fL --retry 3 https://fomalhaut-studio.fomalhautdub.chatgpt.site/Fomalhaut-Studio-v20.zip -o release.zip
unzip -q release.zip
cd Fomalhaut-Studio
cp ~/releases/v19/Fomalhaut-Studio/.env .env
sudo bash ops/update.sh
curl -fsS https://fomalhaut-team-app.duckdns.org/api/health
```

Має бути release: 2026.10.29.20. Якщо .env не знайдено, зупиніться й скопіюйте його з чинного релізу. Після встановлення закрийте й відкрийте мініапку; у браузері натисніть Ctrl+Shift+R. Дані залишаються у постійних томах. Не виконуйте docker compose down -v.
