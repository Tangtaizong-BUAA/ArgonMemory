FROM node:22-bookworm-slim AS build
WORKDIR /build
ARG APT_MIRROR=
ARG NPM_REGISTRY=https://registry.npmjs.org
RUN if [ -n "$APT_MIRROR" ]; then sed -i "s|http://deb.debian.org/debian|$APT_MIRROR|g" /etc/apt/sources.list.d/debian.sources; fi \
    && apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --registry "$NPM_REGISTRY" --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY skills ./skills
COPY scripts ./scripts
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM python:3.11-slim-bookworm AS python-runtime
ARG PIP_INDEX_URL=https://pypi.org/simple
COPY deploy/requirements.txt deploy/requirements.providers.txt /tmp/
RUN python3 -m pip install --no-cache-dir --index-url "$PIP_INDEX_URL" -r /tmp/requirements.txt -r /tmp/requirements.providers.txt \
    && python3 -m pip install --no-cache-dir --index-url "$PIP_INDEX_URL" --no-deps ms-agent==1.6.0

FROM node:22-bookworm-slim
ARG APT_MIRROR=
RUN if [ -n "$APT_MIRROR" ]; then sed -i "s|http://deb.debian.org/debian|$APT_MIRROR|g" /etc/apt/sources.list.d/debian.sources; fi \
    && apt-get update && apt-get install -y --no-install-recommends libssl3 libsqlite3-0 ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production ARGON_MEMORY_PYTHON_BIN=/usr/local/bin/python3 ARGON_MEMORY_MAINTENANCE_PYTHON=/usr/local/bin/python3
COPY --from=python-runtime /usr/local /usr/local
WORKDIR /app
COPY --from=build --chown=node:node /build/dist ./dist
COPY --from=build --chown=node:node /build/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node skills ./skills
RUN mkdir /state && chown node:node /state
USER node
ENTRYPOINT ["node", "dist/cli/knowledge.js"]
CMD ["help"]
