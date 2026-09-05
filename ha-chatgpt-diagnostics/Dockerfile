FROM node:22-alpine3.22

ARG BUILD_VERSION=0.1.10
ARG BUILD_ARCH

ENV APP_VERSION=$BUILD_VERSION

LABEL \
  io.hass.version=$BUILD_VERSION \
  io.hass.type=app \
  io.hass.arch=$BUILD_ARCH \
  org.opencontainers.image.source=https://github.com/aferende/ha-chatgpt-gateway

WORKDIR /app
COPY server.mjs ./server.mjs

EXPOSE 8099
CMD ["node", "server.mjs"]
