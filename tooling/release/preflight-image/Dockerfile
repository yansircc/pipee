FROM node:24-bookworm

ENV DEBIAN_FRONTEND=noninteractive
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN corepack enable \
  && corepack prepare pnpm@11.13.1 --activate \
  && npx --yes playwright@1.61.1 install --with-deps chromium \
  && rm -rf /root/.npm /var/lib/apt/lists/*
