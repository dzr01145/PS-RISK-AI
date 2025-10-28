FROM nginx:alpine

RUN apk add --no-cache apache2-utils \
    && htpasswd -Bbn admin 123 > /etc/nginx/.htpasswd

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html /usr/share/nginx/html/index.html

EXPOSE 80
