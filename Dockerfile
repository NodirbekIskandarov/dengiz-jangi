FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV PORT=3000
# reyting shu papkaga yoziladi — yo'qolmasligi uchun volume ulang (README'ga qarang)
ENV DATA_DIR=/app/data
EXPOSE 3000
CMD ["node", "server.js"]
