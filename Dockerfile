FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY web web
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production TT_HOST=0.0.0.0 TT_DATA_DIR=/data
COPY package*.json ./
RUN npm ci --omit=dev
COPY server server
COPY --from=build /app/web/dist web/dist
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 4310
CMD ["npm", "start"]
