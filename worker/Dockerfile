# QAX-4B — containerized VDT QA execution worker.
#
# The Playwright base image bundles the browsers matching the pinned `playwright`
# npm version (1.61.0), so no browser download is needed at build time. Running in
# this container isolates the worker from the host: with no volumes mounted (see
# docker-compose.yml) it cannot read or modify any file on the host machine — it
# only sees its own image filesystem and makes outbound network calls.
FROM mcr.microsoft.com/playwright:v1.61.0-noble

# Browsers already live in the image; skip the npm postinstall download.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app

# Install runtime deps first for better layer caching (package-lock is committed).
# tsx runs the TypeScript directly, so devDependencies (tsc/types) aren't needed.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Application source (no build step — tsx executes src/index.ts).
COPY tsconfig.json ./
COPY src ./src

# Drop root: the Playwright base image ships a non-privileged 'pwuser'.
RUN chown -R pwuser:pwuser /app
USER pwuser

CMD ["npm", "start"]
