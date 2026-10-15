# The agents' computer (D30): what every agent's sandbox starts from.
# Registered as a Daytona snapshot by apps/server/scripts/sandbox-snapshot.ts
# (SANDBOX_SNAPSHOT names it). No secrets here, ever: agents run arbitrary code.
FROM node:22-bookworm-slim AS node

FROM python:3.12-slim-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONUNBUFFERED=1 \
    MPLBACKEND=Agg

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git curl ca-certificates \
      fonts-dejavu fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji \
      fontconfig sudo procps less nano unzip zip \
 && rm -rf /var/lib/apt/lists/* \
 && fc-cache -f

# Node LTS 22.x with npm and corepack (pnpm, yarn).
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && ln -s ../lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack \
 && corepack enable --install-directory /usr/local/bin \
 && node -v && npm -v

# Python libraries for reports, tables and charts.
RUN pip install \
      "pandas==2.2.*" "numpy==2.1.*" "matplotlib==3.9.*" "openpyxl==3.1.*" \
      "python-docx==1.1.*" "reportlab==4.2.*"

# A non-root user; the workspace is theirs. Global npm installs go to their home (no root needed).
RUN useradd --create-home --shell /bin/bash agente \
 && mkdir -p /workspace \
 && chown agente:agente /workspace
USER agente
ENV HOME=/home/agente \
    NPM_CONFIG_PREFIX=/home/agente/.npm-global \
    COREPACK_HOME=/home/agente/.cache/corepack \
    PATH=/home/agente/.npm-global/bin:/usr/local/bin:/usr/bin:/bin
RUN mkdir -p /home/agente/.npm-global /home/agente/.cache/corepack \
 && corepack prepare pnpm@latest --activate \
 && corepack prepare yarn@stable --activate
WORKDIR /workspace

CMD ["sleep", "infinity"]
