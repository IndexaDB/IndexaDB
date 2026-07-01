FROM node:22-slim

WORKDIR /app

# Install deps first for layer caching
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# App source
COPY bin ./bin
COPY src ./src

# Your project (config + handlers + data) is mounted or copied here
COPY app ./app

ENV INDEXA_LOG_LEVEL=info
EXPOSE 4000

# Override CONFIG at runtime: docker run -e CONFIG=app/indexa.config.yaml ...
ENV CONFIG=app/indexa.config.yaml
HEALTHCHECK --interval=15s --timeout=3s CMD node -e "fetch('http://localhost:4000/_health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["sh", "-c", "node bin/indexa.js deploy --config $CONFIG --port 4000"]
