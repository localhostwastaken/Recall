# Recall witness: multi-stage release build. Build context: witness/.
# (Adapted from upstream servers/verifier/Dockerfile, which built inside the
# servers/ workspace.)
FROM rust:1.99.1-slim-bookworm AS builder

WORKDIR /app

# Build dependencies first with dummy sources so they stay cached until
# Cargo.toml or Cargo.lock change.
COPY Cargo.toml Cargo.lock ./
RUN mkdir -p src && echo "fn main() {}" > src/main.rs && touch src/lib.rs && \
    cargo build --release --locked --bin recall-witness && \
    rm -rf src

# Build the real binary
COPY src ./src
RUN touch src/main.rs src/lib.rs && \
    cargo build --release --locked --bin recall-witness

# Runtime stage
FROM debian:bookworm-slim

ARG GIT_HASH=local
ENV GIT_HASH=${GIT_HASH} \
    PORT=7047

RUN useradd --system --uid 10001 --no-create-home witness
COPY --from=builder /app/target/release/recall-witness /usr/local/bin/recall-witness

USER witness
EXPOSE 7047

CMD ["recall-witness"]
