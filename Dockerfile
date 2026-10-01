# Gobiman, hosted: the same zero-dependency server, listening on every interface with
# per-session state and the public-internet-only guard (GOBIMAN_HOSTED=1).
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080 GOBIMAN_HOSTED=1
COPY server.js index.html about.html ./
COPY collections ./collections
COPY docs ./docs
USER node
EXPOSE 8080
CMD ["node", "server.js"]
