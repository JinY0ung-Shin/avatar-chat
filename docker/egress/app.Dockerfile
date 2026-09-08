# Build the normal Noah image first; this adds only the enforced network boundary.
ARG NOAH_BASE_IMAGE=noah-almighty:egress-base
FROM ${NOAH_BASE_IMAGE}
USER root
ENV HOME=/home/node
ARG APT_MIRROR_HOST=
COPY docker/apt_mirror_sources.sh /tmp/apt_mirror_sources.sh
RUN sh /tmp/apt_mirror_sources.sh \
    && apt-get update \
    && apt-get install -y --no-install-recommends iptables util-linux \
    && rm -rf /var/lib/apt/lists/* /tmp/apt_mirror_sources.sh
COPY docker/egress/entrypoint.sh /usr/local/bin/noah-egress-entrypoint
COPY docker/egress/proxy-bootstrap.cjs /usr/local/lib/noah-proxy-bootstrap.cjs
RUN chmod 755 /usr/local/bin/noah-egress-entrypoint
ENTRYPOINT ["/usr/local/bin/noah-egress-entrypoint"]
CMD ["node", "dist/server/index.js"]
