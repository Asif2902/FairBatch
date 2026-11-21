FROM node:22-alpine AS builder
WORKDIR /app
COPY config ./config
COPY keeper/package.json keeper/tsconfig.json ./keeper/
WORKDIR /app/keeper
RUN npm install
COPY keeper/src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY config ./config
COPY --from=builder /app/keeper/package.json ./keeper/package.json
COPY --from=builder /app/keeper/node_modules ./keeper/node_modules
COPY --from=builder /app/keeper/dist ./keeper/dist
WORKDIR /app/keeper
EXPOSE 3002
CMD ["node", "dist/index.js"]
