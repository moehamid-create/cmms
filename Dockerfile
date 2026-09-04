FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
# Render/Railway/Fly set PORT automatically. DATA_DIR=/data is the persistent disk.
ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "start"]
