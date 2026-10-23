# The API server. Migrations run on start, so a new deploy upgrades every academy.
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
ENV NODE_ENV=production
EXPOSE 3000
CMD ["npx", "tsx", "src/server.ts"]
