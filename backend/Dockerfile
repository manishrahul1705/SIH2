FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app/backend

COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY backend/src ./src
RUN mkdir -p /app/uploads && chown -R node:node /app

USER node
EXPOSE 4000
CMD ["node", "src/server.js"]
