# syntax=docker/dockerfile:1

# The runtime base, a Docker Hardened Image (see below).
ARG RUNTIME_IMAGE=dhi.io/static:20250419-glibc-debian13

# Build on the native builder platform and cross-compile for the target: no QEMU needed for multi-arch images.
FROM --platform=$BUILDPLATFORM oven/bun:1.3.13 AS build
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
ARG TARGETARCH
RUN case "$TARGETARCH" in \
      amd64) target=bun-linux-x64-baseline ;; \
      arm64) target=bun-linux-arm64 ;; \
      *) echo "unsupported arch: $TARGETARCH" >&2; exit 1 ;; \
    esac \
 && OUTFILE=/out/proxytail bun run build.ts "$target" \
 && mkdir -p /out/data /out/crowdsec

# Docker Hardened Image: glibc, CA certificates and tzdata only, no shell or package manager, running as nonroot
# (65532). The compiled binary embeds the Bun runtime and the frontend, and only links against glibc. Pulling it needs
# `docker login dhi.io` with a Docker Hub account.
FROM ${RUNTIME_IMAGE}
COPY --from=build /out/proxytail /proxytail
COPY --from=build --chown=65532:65532 /out/data /data
# The CrowdSec secrets volume: a new named volume takes this ownership.
COPY --from=build --chown=65532:65532 /out/crowdsec /crowdsec
USER 65532:65532

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data
VOLUME /data
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 CMD ["/proxytail", "healthcheck"]
ENTRYPOINT ["/proxytail"]
