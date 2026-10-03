ARG BUILDPLATFORM
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev
# Runtime dependencies are JavaScript-only. Fail rather than cross-copy native addons.
RUN test -z "$(find node_modules -name '*.node' -print -quit)"

FROM node:22-alpine AS runtime
LABEL org.opencontainers.image.source="https://github.com/aferende/ha-chatgpt-gateway"
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S gateway && adduser -S gateway -G gateway
COPY --from=build --chown=gateway:gateway /app/package*.json ./
COPY --from=build --chown=gateway:gateway /app/node_modules ./node_modules
COPY --from=build --chown=gateway:gateway /app/dist ./dist
USER gateway
EXPOSE 8787
CMD ["node", "dist/server.js"]
