FROM node:22-slim AS base

# Install ONNX Runtime deps (needed by @huggingface/transformers)
RUN apt-get update && apt-get install -y \
    libgomp1 \
    libstdc++6 \
    && rm -rf /var/lib/apt/lists/*

FROM base AS builder

# better-sqlite3 v13 ships prebuilds but has a binding.gyp and no install
# script, so npm auto-runs node-gyp rebuild - slim needs the toolchain for that.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

COPY src/ ./src/
RUN npm run build

# Prod deps only; native builds above are reused, not re-run
RUN npm prune --omit=dev

# Production image - only built output + production deps
FROM base AS production

WORKDIR /app

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist/ ./dist/

CMD ["node", "dist/index.js"]
