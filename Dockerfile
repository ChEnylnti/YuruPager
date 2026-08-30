FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci

COPY . .
RUN npm run build:all

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0

COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci --omit=dev --ignore-scripts

COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/server/db apps/server/db
COPY --from=build /app/apps/web/dist apps/web/dist
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/artifacts/yurupager-connector.tgz artifacts/yurupager-connector.tgz
COPY --from=build /app/scripts/install-connector.sh scripts/install-connector.sh

EXPOSE 4300 4301
CMD ["node", "apps/server/dist/index.js"]
