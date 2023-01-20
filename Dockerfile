FROM rust AS builder
WORKDIR /app
COPY . .
RUN cargo build --release

FROM debian:buster-slim
COPY --from=builder /app/target/release/suomipelit-lobby /usr/local/bin/suomipelit-lobby

EXPOSE 8080
CMD ["suomipelit-lobby"]
