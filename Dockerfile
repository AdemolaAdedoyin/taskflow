# --- deps & build ---
FROM node:22-alpine AS builder
WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma
RUN npm ci

COPY tsconfig.json openapi.yaml ./
COPY src ./src
RUN npm run prisma:generate && npm run build

# --- runtime ---
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
COPY prisma ./prisma
# Generate Prisma while the CLI is present, then prune development packages so
# runtime startup never depends on npx downloading tooling from the network.
RUN npm ci \
  && npm run prisma:generate \
  && npm prune --omit=dev \
  && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY openapi.yaml ./openapi.yaml

USER node
EXPOSE 4000
CMD ["node", "dist/index.js"]
