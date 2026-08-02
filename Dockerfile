FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
COPY surge ./surge
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 DATABASE_PATH=/app/data/allowlist.db
RUN addgroup -S app && adduser -S app -G app && mkdir /app/data && chown -R app:app /app
USER app
EXPOSE 8787
VOLUME ["/app/data"]
CMD ["node", "src/server.js"]
