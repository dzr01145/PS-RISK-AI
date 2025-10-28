FROM nginx:alpine

# Copy static assets into Nginx web root
COPY index.html /usr/share/nginx/html/index.html

EXPOSE 80
