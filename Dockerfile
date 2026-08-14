# One runtime dependency (the redis client) and no build step: install, copy,
# run. Nothing to compile.
FROM node:22-slim

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0

WORKDIR /app

# Dependencies first, so edits to the game do not invalidate the install layer.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 8080

# Runs as root deliberately. The Fly volume is mounted at /data as an empty
# root-owned filesystem, so a non-root user could not create the cache and stats
# directories inside it — the app would start and then silently fail to persist
# anything. Dropping privileges would mean chowning the mount from an entrypoint
# that starts as root anyway.
#
# No shell wrapper, so node is PID 1 and receives SIGTERM directly on deploy.
CMD ["node", "server.js"]
