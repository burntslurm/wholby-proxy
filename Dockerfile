FROM node:18-alpine
WORKDIR /app
COPY package.json server.js ./
RUN npm install
EXPOSE 8096
CMD ["node", "server.js"]
