FROM node:22.13-alpine
WORKDIR /app
COPY server.ts ./
COPY content ./content
EXPOSE 443
CMD ["node", "--experimental-strip-types", "--no-warnings", "server.ts"]
