# FriendsShare server: website, accounts, Pro subscriptions and matchmaking. The same image runs the
# operator's admin interface when it is started with admin.js instead (see deploy/compose.yml).
# The build context is server/ (deploy/compose.yml builds ./app/server).
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js admin.js ./
COPY lib/ ./lib/
COPY site/ ./site/
COPY admin-site/ ./admin-site/
# The database, its snapshots and the secret key live in /data, which has to belong to the user
# the server runs as. deploy/deploy.sh does the same for the host directory it mounts there.
RUN mkdir -p /data && chown node:node /data
ENV PORT=8080 DATA_DIR=/data
# 8080: website, API and matchmaking. 8792: the admin interface, which has no login and is never proxied.
EXPOSE 8080 8792
HEALTHCHECK --interval=10s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:${PORT}/healthz >/dev/null || exit 1
USER node
# node:sqlite still prints an ExperimentalWarning, which tells nobody anything in the container log.
# node is PID 1 here, so server.js handles SIGTERM itself.
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
