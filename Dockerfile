FROM rust:1.94-bookworm AS rust-builder
WORKDIR /build
COPY packages/cove-simplicity/rust packages/cove-simplicity/rust
RUN cargo build --release --locked --manifest-path packages/cove-simplicity/rust/Cargo.toml

FROM node:24-bookworm-slim
WORKDIR /app
RUN npm install --global pnpm@10.33.0
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps ./apps
COPY packages ./packages
COPY tsconfig.base.json ./
COPY crc-core-source-manifest.json ./
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @crclaunch/crc20-protocol build && pnpm --filter @crclaunch/crc20-adapters build
COPY --from=rust-builder /build/packages/cove-simplicity/rust/target/release/cove-simplicity /app/packages/cove-simplicity/rust/target/release/cove-simplicity
ENV NODE_ENV=production
EXPOSE 4391
CMD ["pnpm", "start"]
