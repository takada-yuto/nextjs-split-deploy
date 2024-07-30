FROM node:20 AS builder
WORKDIR /build
COPY package*.json ./
RUN npm ci
COPY . ./
# ビルドすると静的ファイルのファイル名が変わるのでここではビルドしない
# RUN npm run build

# Use a common base image to reduce the cold start time
FROM amazon/aws-lambda-nodejs:20

# Install Lambda Web Adapter
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:0.5.0 /lambda-adapter /opt/extensions/lambda-adapter
ENV PORT=3000

COPY --from=builder /build/next.config.mjs ./
# 静的ファイルはS3にアップロードしているのでここではコピーしない
# COPY --from=builder /build/public ./public
# COPY --from=builder /build/.next/static ./.next/static
COPY --from=builder /build/.next/standalone ./

# Changes due to the base image
ENTRYPOINT ["node"]
CMD ["server.js"]
