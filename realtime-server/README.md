# realtime-server

Socket.IO realtime сервер для MVP: `msg:new -> msg:ack` с идемпотентностью `(userId, tempId)` и in-memory rate limit.

## Env

Скопируй переменные из `.env.example` в `.env` (или экспортируй в окружение).

## Commands

```bash
npm i
npx prisma generate
npx prisma migrate dev
npm run dev
```

