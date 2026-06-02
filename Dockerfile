FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-websockify \
    nodejs npm \
    wget ca-certificates curl zip \
    && rm -rf /var/lib/apt/lists/*

RUN wget -qO- 'https://github.com/novnc/noVNC/archive/refs/tags/v1.4.0.tar.gz' | \
    tar xz -C /opt && \
    mv /opt/noVNC-1.4.0 /opt/noVNC

COPY landing/ /opt/landing/
RUN cd /opt/landing && npm init -y > /dev/null 2>&1

EXPOSE 8080 6080

COPY start.sh /start.sh
RUN chmod +x /start.sh

CMD ["/start.sh"]
