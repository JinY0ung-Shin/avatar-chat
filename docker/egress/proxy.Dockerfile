FROM debian:bookworm-slim
ARG APT_MIRROR_HOST=
COPY docker/apt_mirror_sources.sh /tmp/apt_mirror_sources.sh
RUN sh /tmp/apt_mirror_sources.sh \
    && apt-get update \
    && apt-get install -y --no-install-recommends squid ca-certificates python3 \
    && rm -rf /var/lib/apt/lists/* /tmp/apt_mirror_sources.sh
ARG CA_CERT_FILE=docker/extra-ca.crt.example
COPY ${CA_CERT_FILE} /tmp/extra-ca.crt
RUN if grep -q "BEGIN CERTIFICATE" /tmp/extra-ca.crt; then \
      cp /tmp/extra-ca.crt /usr/local/share/ca-certificates/noah-extra-ca.crt && update-ca-certificates; \
    fi && rm -f /tmp/extra-ca.crt
COPY docker/egress/squid.conf /etc/squid/squid.conf
COPY docker/egress/policy /etc/noah-egress
COPY docker/egress/controller.py /usr/local/lib/noah-egress-controller.py
RUN mkdir -p /var/lib/noah-egress && chown proxy:proxy /var/lib/noah-egress
USER proxy
EXPOSE 3128 3129
CMD ["python3", "/usr/local/lib/noah-egress-controller.py"]
