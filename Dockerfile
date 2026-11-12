# syntax=docker/dockerfile:1
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Install dependencies (production only)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application source code
COPY . .

# Set default environment variables
ENV NODE_ENV=production
ENV PORT=3000

# Expose server port
EXPOSE 3000

# Run as non-root user for security
USER node

# Healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/ || exit 1

# Start the application
CMD ["node", "server.js"]
