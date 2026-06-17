# ---- Build stage ----
# Debian-based (not alpine): Prisma's engine needs a libssl/OpenSSL build it can
# detect. Alpine/musl on ARM causes "Could not parse schema engine response".
FROM node:20-slim AS build
WORKDIR /app

# OpenSSL is required by Prisma's query/schema engines.
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install

COPY prisma ./prisma
RUN npx prisma generate

COPY . .
RUN npm run build

# ---- Production stage ----
FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY package*.json ./

EXPOSE 4000

# Syncs the schema on container start (MVP: no migration history yet),
# then starts the API server.
CMD ["sh", "-c", "npx prisma db push --accept-data-loss && node dist/server.js"]
