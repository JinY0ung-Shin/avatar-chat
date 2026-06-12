#!/bin/sh
set -eu

# Rewrites Debian apt sources to use a corporate mirror.
# Inspired by oh-my-gateway's equivalent script.
#
# Build args:
#   APT_MIRROR_HOST         – replaces the host portion of deb.debian.org
#                             e.g. "mirror.example.internal/repository/proxy-apt-deb.debian.org"
#                             This preserves the /debian and /debian-security paths,
#                             so both suites work through the same mirror proxy.
#   APT_SOURCES_FILE        – path to the DEB822 sources file
#                             (default: /etc/apt/sources.list.d/debian.sources)

sources_file="${APT_SOURCES_FILE:-/etc/apt/sources.list.d/debian.sources}"

if [ -n "${APT_MIRROR_HOST:-}" ]; then
    # Replace only the host portion — paths (/debian, /debian-security) stay intact.
    sed -i "s|http://deb.debian.org|http://${APT_MIRROR_HOST}|g" "$sources_file"
fi
