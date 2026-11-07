FROM node:24-alpine
WORKDIR /app
COPY package.json server.js ./
COPY public ./public
RUN mkdir /data && chown node:node /data
ENV NODE_ENV=production PORT=3000 DATABASE_PATH=/data/alerts.sqlite
USER node
EXPOSE 3000
VOLUME ["/data"]
CMD ["node", "server.js"]
