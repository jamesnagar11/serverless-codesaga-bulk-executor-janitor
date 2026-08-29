FROM oven/bun:1 as builder

WORKDIR /usr/src/app

COPY package*.json .

RUN bun install

COPY . .

RUN bun run build

FROM oven/bun:1 as runner

WORKDIR /usr/src/app

COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY --from=builder /usr/src/app/package*.json ./
COPY --from=builder /usr/src/app/bun.lock ./
COPY --from=builder /usr/src/app/dist ./dist

CMD ["bun","run","start"]