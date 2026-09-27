# syntax=docker/dockerfile:1

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

# Distroless: glibc + CA certificates, no shell. The compiled binary embeds the Bun runtime and the frontend.
FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /out/proxytail /proxytail
COPY --from=build --chown=nonroot:nonroot /out/data /data
# The CrowdSec bouncer key volume: a new named volume takes this ownership.
COPY --from=build --chown=nonroot:nonroot /out/crowdsec /crowdsec

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data
VOLUME /data
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 CMD ["/proxytail", "healthcheck"]
ENTRYPOINT ["/proxytail"]
