FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable
COPY package.json yarn.lock .yarnrc.yml ./
RUN yarn install --immutable
COPY tsconfig.json vite.config.ts ./
COPY src src
RUN yarn build && yarn workspaces focus --production

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY --from=builder /app/build ./build
COPY --from=builder /app/node_modules ./node_modules
USER node
EXPOSE 8011
CMD ["node", "build/sse.js"]
