# base image to start with
FROM docker.io/library/node:16

# create app dir
WORKDIR /usr/src/app

# Get package json
COPY package.json ./

# Install dep
RUN npm install

# Copy app files
COPY . .

# Container Port using Port8080
# docker run -p 8080:8080 <-
EXPOSE 8080

# Start server
CMD ["node", "server.js"]

