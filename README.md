# Dengiz jangi — onlayn multiplayer

Katak daftardagi klassik "Dengiz jangi" o‘yini, brauzerda. Ro‘yxatdan o‘tish kerak emas — saytga kirasiz va o‘ynaysiz.

## Imkoniyatlar

- **Do‘st bilan** — xona ochiladi, havola Telegram orqali yuboriladi yoki 5 belgili kod aytiladi. Havolani ochgan do‘stga "Nodir sizni jangga chaqirdi!" degan sahifa chiqadi.
- **Tasodifiy raqib** — saytdagi boshqa o‘yinchi bilan avtomatik juftlash. 12 soniyada hech kim topilmasa, kompyuter bilan o‘ynash taklif qilinadi.
- **Kompyuter bilan** — "Oson" (ko‘pincha tasodifiy otadi, o‘rtacha ~66 o‘qda yutadi) va "Qiyin" (tekkan kemani tugatadi, qolganini ehtimollik bo‘yicha hisoblaydi, ~56 o‘q) darajalari.
- **Reyting va statistika** — odamlar bilan har bir o‘yin Elo reytingini o‘zgartiradi (boshlang‘ich 1000). Reyting jadvali (top-20), shaxsiy statistika: g‘alaba/mag‘lubiyat, kompyuterga qarshi natijalar, aniqlik, eng tez g‘alaba, eng uzun seriya. Ro‘yxatdan o‘tish shart emas — brauzer o‘zining maxfiy kalitini saqlaydi.
- **Uch til** — o‘zbekcha, ruscha, inglizcha (bosh sahifada tanlanadi, brauzer tili rus bo‘lsa avtomatik ruscha). Ustun harflari ham tilga mos: A B D E… / А Б В Г… / A B C D…
- Klassik qoidalar: 10 ta kema (4, 3, 3, 2, 2, 2, 1, 1, 1, 1), kemalar bir-biriga tegmaydi, tekkan o‘yinchi yana otadi, cho‘kkan kema atrofi avtomatik ochiladi.
- Har yurish uchun 30 soniya; 3 marta ketma-ket yurmagan o‘yinchi yutqazadi. Joylashtirish uchun 2 daqiqa, keyin kemalar avtomatik qo‘yiladi.
- Aloqa uzilsa yoki sahifa yangilansa, o‘yin davom etadi (60 soniya kutiladi). Raqib qaytmasa, g‘alaba sizniki.
- Revansh (hisob saqlanadi, keyingi raundni yutqazgan boshlaydi), chat va tezkor reaksiyalar, ovoz effektlari, telefonda tebranish.
- Telefonga moslashgan, qorong‘i rejim, klaviatura bilan boshqarish (strelkalar, Enter, kema burish uchun R).

Barcha o‘yin mantig‘i serverda tekshiriladi: raqib kemalari o‘yin oxirigacha brauzerga yuborilmaydi, navbatsiz yoki noto‘g‘ri otishlar rad etiladi.

## Ishga tushirish

Node.js 18 yoki undan yangisi kerak.

```bash
npm install
npm start
```

Brauzerda oching: http://localhost:3000 — ikkita oynada ochib, o‘zingiz bilan ham o‘ynab ko‘rishingiz mumkin.

Avtomatik sinov (ikki o‘yinchi, revansh, qayta ulanish, kompyuter bilan to‘liq o‘yinlar, reyting hisobi, tarjimalar to‘liqligi):

```bash
npm test
```

## Internetga chiqarish

O‘yin WebSocket ishlatadi, shuning uchun oddiy statik hosting (GitHub Pages, Netlify) yetmaydi — Node.js ishlaydigan server kerak.

**Render.com (eng oson):** repozitoriyni GitHub'ga yuklang → Render'da "New +" → "Blueprint" → repozitoriyni tanlang (`render.yaml` hamma sozlamani o‘zi qo‘yadi). Port avtomatik `PORT` o‘zgaruvchisidan olinadi. Railway, Fly.io ham xuddi shunday ishlaydi.

> **Reyting qayerda saqlanadi:** `DATA_DIR/stats.json` faylida (standart: loyiha ichidagi `data/`). Render'ning bepul tarifida doimiy disk yo‘q — server qayta ishga tushsa, reyting nolga tushadi. Reyting saqlanib qolishi uchun doimiy disk ulang (Render "starter" + disk, Railway volume, Fly.io volume) va `DATA_DIR`ni o‘sha diskka yo‘naltiring. O‘z VPS serveringizda hech narsa qilish shart emas.

**O‘z VPS serveringizda:**

```bash
npm install --omit=dev
npm install -g pm2
PORT=3000 pm2 start server.js --name dengiz-jangi
```

Nginx orqali domen ulasangiz, WebSocket uchun bu sarlavhalar shart:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
}
```

**Docker:** `docker build -t dengiz-jangi . && docker run -p 3000:3000 -v dengiz-data:/app/data dengiz-jangi` (`-v` reytingni konteyner qayta yaratilganda ham saqlab qoladi)

> O‘yin holati server xotirasida saqlanadi. Server qayta ishga tushsa, davom etayotgan o‘yinlar tugaydi (reyting esa faylda qoladi). Bitta server bir necha ming o‘yinchini bemalol ko‘taradi; bundan ko‘pi uchun Socket.io Redis adapteri kerak bo‘ladi.

## Sozlamalar

`server.js` faylining boshida:

| O‘zgaruvchi | Qiymati | Ma’nosi |
|---|---|---|
| `TURN_SECONDS` | 30 | Bir yurish uchun vaqt |
| `PLACE_SECONDS` | 120 | Kemalarni joylashtirish vaqti |
| `RECONNECT_SECONDS` | 60 | Uzilgan raqibni kutish vaqti |
| `MAX_TIMEOUTS` | 3 | Ketma-ket necha marta yurmasa — mag‘lubiyat |

Muhit o‘zgaruvchilari: `PORT` (standart 3000), `DATA_DIR` (reyting fayli papkasi, standart `./data`).

Reyting `stats.js` faylida: `START_ELO` = 1000, `K_FACTOR` = 32. Reytingga faqat jang boshlangandan keyin tugagan odamlar o‘rtasidagi o‘yinlar ta’sir qiladi; o‘yindan chiqib ketish yoki 3 marta yurmaslik mag‘lubiyat hisoblanadi. Bitta brauzerning ikki varag‘i bir-biriga qarshi o‘ynasa, reyting o‘zgarmaydi.

## Fayllar

```
server.js          Express + Socket.io: xonalar, juftlash, navbat, taymerlar
stats.js           Reyting (Elo) va statistika, faylga saqlash
bot.js             Kompyuter raqib (oson / qiyin)
render.yaml        Render.com uchun tayyor sozlama
public/game.js     Umumiy qoidalar — serverda ham, brauzerda ham ishlaydi
public/i18n.js     Tarjimalar: o‘zbek, rus, ingliz
public/client.js   Interfeys, joylashtirish, ovozlar, reyting jadvali
public/style.css   "Katak daftar" dizayni (yorug' va qorong'i rejim)
public/index.html  Sahifa
public/fonts/      Caveat va Rubik shriftlari, lotin va kirill (SIL Open Font License)
test/simulate.js   Avtomatik sinov
```
