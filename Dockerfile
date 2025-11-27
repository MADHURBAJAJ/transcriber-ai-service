# Use Node LTS base image
FROM node:18

# Install ffmpeg and dependencies
RUN apt-get update && apt-get install -y ffmpeg

# Install yt-dlp
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

# Create app directory
WORKDIR /app

# Copy package.json
COPY package.json ./

# Install dependencies
RUN npm install

# Copy the rest of the app
COPY . .

# Expose port
EXPOSE 5051

# Start the server
CMD ["node", "server.js"]
