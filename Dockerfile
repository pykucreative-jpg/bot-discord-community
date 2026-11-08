FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates ffmpeg python3-venv \
    && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/music && /opt/music/bin/pip install --no-cache-dir \
    yt-dlp==2026.10.26 yt-dlp-ejs==0.8.0 certifi==2026.10.23
ENV PATH="/opt/music/bin:${PATH}"
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY *.mjs ./
CMD ["node", "bot.mjs"]
