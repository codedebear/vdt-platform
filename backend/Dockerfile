# ---- Build stage ----
FROM node:20-alpine AS build
WORKDIR /app

COPY package*.json ./
RUN npm install

COPY prisma ./prisma
RUN npx prisma generate

COPY . .
RUN npm run build

# ---- Production stage ----
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY package*.json ./

EXPOSE 4000

# Syncs the schema on container start (MVP: no migration history yet),
# then starts the API server.
CMD ["sh", "-c", "npx prisma db push --accept-data-loss && node dist/server.js"]
