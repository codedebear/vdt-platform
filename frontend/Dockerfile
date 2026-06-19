# --- Build stage: compile the Vite/React app to static assets ---------------
FROM node:20-slim AS build
WORKDIR /app

# Install dependencies first for better layer caching.
COPY package.json package-lock.json* ./
RUN npm install

COPY . .

# Same-origin API by default (nginx proxies /api). Override at build time if the
# API is hosted on a different origin: --build-arg VITE_API_BASE_URL=https://...
ARG VITE_API_BASE_URL=""
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
RUN npm run build

# --- Serve stage: nginx serving the built assets + proxying /api ------------
FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx/default.conf.template /etc/nginx/templates/default.conf.template

# Where nginx forwards /api and /health. Override via compose if PORT changes.
ENV BACKEND_ORIGIN=http://backend:4000

EXPOSE 80
