FROM xataz/node:7.1-onbuild
MAINTAINER "xataz <xataz@mondedie.fr>"
ENV ENV=production UID=1000 GID=1000
RUN sed -i -e 's/#5bc0de/#00897B/g' -e 's/#0275d8/#00897B/g' public/css/*
CMD ["npm", "start"]
