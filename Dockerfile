FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

RUN useradd --system --uid 10001 --create-home workspace \
  && mkdir -p /data \
  && chown -R workspace:workspace /app /data

USER workspace
EXPOSE 3000

HEALTHCHECK --interval=20s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
