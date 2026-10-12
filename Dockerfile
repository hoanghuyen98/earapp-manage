FROM node:22-alpine AS web
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production TZ=Asia/Ho_Chi_Minh
COPY package*.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY --from=web /app/web/dist ./web/dist
VOLUME /app/data
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
