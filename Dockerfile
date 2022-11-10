FROM node:18-alpine

COPY . .
RUN npm install && npm run build

ENV PORT=8080
CMD ["npm", "start"]
