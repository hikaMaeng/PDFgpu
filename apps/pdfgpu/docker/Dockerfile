FROM node:20-alpine AS runtime
WORKDIR /app

COPY apps/pdfgpu/src/server/dist ./server
COPY apps/pdfgpu/src/client/dist ./client

EXPOSE 51000
CMD ["node", "server/index.js"]
