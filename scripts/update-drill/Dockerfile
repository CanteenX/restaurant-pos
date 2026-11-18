# Stand-in app image for scripts/update-rollback-drill.sh (not shipped).
FROM node:22-alpine
ARG APP_VERSION=dev
ARG BROKEN=0
ENV APP_VERSION=$APP_VERSION BROKEN=$BROKEN
WORKDIR /app
COPY app.js ./
CMD ["node", "app.js"]
