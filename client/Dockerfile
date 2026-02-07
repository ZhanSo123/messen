FROM node:20-bookworm-slim AS build

WORKDIR /app

# Monorepo (npm workspaces): install deps from the root lockfile.
COPY package.json package-lock.json ./
COPY realtime-server/package.json realtime-server/package.json
COPY client/package.json client/package.json

RUN npm ci

COPY client ./client

# Optional: allows baking the server URL into the client build.
ARG NEXT_PUBLIC_REALTIME_URL
ENV NEXT_PUBLIC_REALTIME_URL=${NEXT_PUBLIC_REALTIME_URL}

RUN npm -w client run build


FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app /app

EXPOSE 3000

CMD ["sh", "-lc", "cd client && npm run start"]

