# transcriber-service/Dockerfile
FROM node:20-alpine

# Install dependencies for yt-dlp & ffmpeg
RUN apk add --no-cache ffmpeg curl python3 py3-pip

# Install yt-dlp
RUN pip install yt-dlp

# App directory
WORKDIR /app

# Copy package & install
COPY package.json package-lock.json* ./ 
RUN npm install

# Copy source
COPY . .

# Expose port
EXPOSE 5051

CMD ["npm", "start"]
