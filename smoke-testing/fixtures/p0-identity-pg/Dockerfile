FROM node:22.23.2-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS build

ARG NPM_REGISTRY=https://registry.npmjs.org/
WORKDIR /app
COPY app/package.json app/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund --registry="${NPM_REGISTRY}"
COPY app/ ./
RUN npm run build

FROM node:22.23.2-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436

ENV HOST=0.0.0.0 PORT=8080 NODE_ENV=production
WORKDIR /app
COPY app/package.json app/package-lock.json ./
ARG NPM_REGISTRY=https://registry.npmjs.org/
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund --registry="${NPM_REGISTRY}" \
  && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY app/server.mjs ./server.mjs
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
