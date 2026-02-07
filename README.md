# messen

## New Messenger (MVP)

Тикет #1: `msg:new -> msg:ack` с идемпотентностью `(userId,tempId)`, optimistic UI и retry/reconnect.

## Run

1) Postgres

```bash
docker compose up -d
```

2) Realtime server

```bash
cd realtime-server
npm i
cp .env.example .env
npx prisma generate
npx prisma migrate dev
# optional: creates chat_general + 2 seed users (u_1/u_2, password123)
npm run seed:dev
npm run dev
```

3) Client

```bash
cd client
npm i
cp .env.example .env.local
npm run dev
```

4) Auth

- Open `http://localhost:3000/register` and create 2 users.
- They get JWT stored in `localStorage` under `nm:token`, and profile under `nm:me`.

## Smoke Tests (Manual)

- Send -> offline immediately -> online: сообщение не дублируется, `msg:ack` приводит `pending -> sent`.
- Two tabs (один и тот же user/token): одно сообщение -> максимум один `msgId` в БД, клиент дедупит `msg:broadcast` по `msgId`.
- Two tabs with different users in same chat: оба видят один и тот же `msgId` в `msg:broadcast`, без дублей при reconnect.
- Повтор `msg:new` с тем же `tempId`: сервер возвращает тот же `msgId` (без создания дубля).
- Reconnect storm test: быстро offline/online 3 раза подряд, pending не множатся, после восстановления сети остаётся один `msgId`.
- msg:sync: offline 1 мин -> другой user отправляет 3 сообщения -> online -> `msg:sync` подтягивает пропущенное без дублей.
- msg:sync cursor: cursor хранит `(afterServerTs, afterMsgId)` чтобы корректно догружать сообщения даже если несколько сообщений имеют одинаковый `serverTs`.
- reactions: два юзера в одном чате добавляют реакцию к одному `msgId` -> оба видят emoji под сообщением, без дублей.
- reactions toggle: тап по emoji капсуле добавляет/убирает реакцию текущего user (серверно).
- reactions reconnect: быстро offline/online -> повторные broadcast/ack не создают дублей реакций в UI.
- react:sync: offline -> другой user ставит реакцию -> online -> `react:sync` подтягивает реакцию без дублей.
- silent mode: включить Silent -> реакции по умолчанию свернуты (кнопка `Reactions` раскрывает), UI остаётся отзывчивым.
- silent mode UX: в silentMode скрыты капсулы/quick-emoji, видна только кнопка `Show reactions` (без счётчиков; появляется `·` если реакции есть).
- focus mode: на `/` две секции: `Recent chats` (последние 10 открытых) и `Focus chats`; можно pin/unpin из `ChatView` или с главной.
- cross-tab: включить Silent в одной вкладке -> в другой вкладке UI обновляется сразу (через `storage`).
- posts: offline 1 мин -> другой user создает пост -> online -> `post:sync` подтягивает пост без дублей.
- post reactions: offline -> другой user ставит реакцию на пост -> online -> `react:sync` (targetType=post) подтягивает реакцию без дублей.
- msg:error (feed): для постов/реакций на постах сервер шлёт `msg:error { scope:\"feed\", tempId?, reason }` (не `chatId=\"feed\"`).
- private posts: user A создаёт PRIVATE пост -> user B не видит его ни через `post:broadcast`, ни через `post:sync`.
- private posts (author): user A создаёт PRIVATE пост -> user A видит его, пометка `Private` в UI, реакции работают только для автора.
- private post reactions (privacy): user B пытается поставить реакцию на PRIVATE пост user A -> получает `msg:error { scope:\"feed\", reason:\"forbidden\" }`, и не получает ни `react:broadcast`, ни `react:sync` по этой реакции.
