FROM golang:1.26-alpine AS builder
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/planner .

FROM alpine:3.23
RUN apk add --no-cache ca-certificates
COPY --from=builder /out/planner /usr/local/bin/planner
USER 65534:65534
EXPOSE 8080
ENTRYPOINT ["planner"]
