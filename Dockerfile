# ============================================================
# OpenProphet Trading System — Multi-stage Docker Build
# ============================================================
# Stage 1: Build Go trading backend (requires CGO for SQLite)
# Stage 2: Node.js 20 runtime with supervisord for both processes
# ============================================================

# -----------------------------------------------------------
# Stage 1: Go Builder
# -----------------------------------------------------------
FROM golang:1.22-alpine AS go-builder

# CGO required for gorm sqlite driver (mattn/go-sqlite3)
RUN apk add --no-cache gcc musl-dev sqlite-dev

WORKDIR /build

# Cache module downloads
COPY go.mod go.sum ./
RUN go mod download

# Copy all Go source packages
COPY cmd/ ./cmd/
COPY config/ ./config/
COPY controllers/ ./controllers/
COPY database/ ./database/
COPY interfaces/ ./interfaces/
COPY models/ ./models/
COPY services/ ./services/

# Build static-linked binary with stripped debug symbols
RUN CGO_ENABLED=1 GOOS=linux go build -ldflags="-s -w" -o prophet_bot ./cmd/bot/

# -----------------------------------------------------------
# Stage 2: Node.js Runtime + Supervisord
# -----------------------------------------------------------
FROM node:20-alpine

# Install supervisor + native build deps for better-sqlite3
RUN apk add --no-cache \
    supervisor \
    python3 \
    make \
    g++ \
    sqlite-dev

WORKDIR /app

# Install Node dependencies (layer cache — only rebuilds on package changes)
COPY package.json package-lock.json ./
RUN npm install --omit=dev \
    && apk del python3 make g++

# Copy Go binary from builder stage
COPY --from=go-builder /build/prophet_bot /app/prophet_bot
RUN chmod +x /app/prophet_bot

# Copy Node.js application source
COPY mcp-server.js risk-guard.js crypto-config.js crypto-service.js crypto-tools.js ./
COPY alerts.js env-check.js vectorDB.js backfill_embeddings.js ./
COPY agent/ ./agent/
COPY wallet/ ./wallet/
COPY strategies/ ./strategies/
COPY seed_data/ ./seed_data/

# Create runtime directories
RUN mkdir -p /app/data /app/logs /app/activity_logs /app/decisive_actions

# Copy supervisord config
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf

EXPOSE 3737 4534

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD wget -qO- http://localhost:3737/health || exit 1

CMD ["supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
