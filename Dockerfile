FROM node:20-slim
RUN apt-get update && apt-get install -y python3 python3-pip && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY client/package*.json client/
RUN cd client && npm install
COPY client client
RUN cd client && npm run build
COPY server/package*.json server/
RUN cd server && npm install --omit=dev
COPY server server
RUN pip3 install --break-system-packages numpy scipy
ENV PORT=8080
CMD ["node", "server/server.js"]