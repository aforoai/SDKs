# Kong with the Aforo metering plugin baked in.
#
# Why this image exists
# ---------------------
# KONG_PLUGINS is an environment variable, so changing it means recreating the
# container -- which discards anything `luarocks make` installed inside the
# previous one. Kong then refuses to boot ("aforo-metering plugin is enabled but
# not installed"), and because it dies during init_by_lua you cannot `docker exec`
# in to install it. That is a deadlock, not a flaky install. Baking the plugin
# into the image breaks it: the plugin is present before Kong ever starts.
#
#   docker build -t kong-aforo:3.4 .
#   docker run -d --name kong --network=kong-net \
#     -e KONG_DATABASE=postgres -e KONG_PG_HOST=kong-database \
#     -e KONG_PG_USER=kong -e KONG_PG_PASSWORD=kong \
#     -e KONG_ADMIN_LISTEN=127.0.0.1:8001 \
#     -p 8000:8000 kong-aforo:3.4
#
# The Admin API stays on the container's loopback: it has no authentication,
# and anyone who reaches it can reconfigure the gateway. Use it with
# `docker exec kong curl -s localhost:8001/...`, or publish it to the host's
# loopback only (-e KONG_ADMIN_LISTEN=0.0.0.0:8001 -p 127.0.0.1:8001:8001).
#
# Other Kong versions: pass the base image. Kong ships no open-source image
# after 3.9; the Kong Gateway (Enterprise) image runs without a license in free
# mode, and it is the image Kong Konnect data plane nodes run.
#
#   docker build --build-arg KONG_IMAGE_BASE=kong/kong-gateway:3.16.0.1 -t kong-aforo:3.16 .
#
# Tested bases: see "Supported Kong versions" in README.md.
#
# For a fast edit-reload loop that does not rebuild, see USER_GUIDE.md
# ("Local development: mounting the plugin from source").

ARG KONG_IMAGE_BASE=kong:3.4
FROM ${KONG_IMAGE_BASE}

USER root

# No JWT library is installed. RS256 verification uses resty.openssl, which is
# already part of Kong and is OpenSSL 3 native. lua-resty-jwt was tried and
# deliberately dropped: it pulls in lua-resty-hmac, whose FFI binding cannot
# load against the OpenSSL 3 that Kong 3.x links ("size of C type is unknown or
# too large" -- HMAC_CTX is opaque in OpenSSL 3). Installing it appears to
# succeed and then fails at require() time, which reads like a packaging or
# Lua-path problem and is neither.

# `luarocks make` resolves build.modules paths relative to the working directory,
# so it must run from inside the plugin directory -- not from a parent with the
# rockspec passed as a path.
COPY . /tmp/aforo-plugin/
RUN cd /tmp/aforo-plugin \
    && luarocks make kong-plugin-aforo-metering-2.8.1-1.rockspec \
    && rm -rf /tmp/aforo-plugin

USER kong

ENV KONG_PLUGINS=bundled,aforo-metering

# Two shared dicts. aforo_buffer holds the buffered events; without it the
# plugin loads and proxies traffic but meters nothing ("Shared dict
# 'aforo_buffer' not found"). aforo_cache (2.8.0) holds the caches, warning
# throttles and counters, so they never take room from events; without it they
# fall back to aforo_buffer and each worker logs one error.
# Kong injects the value after `lua_shared_dict `, so the second dict is a
# second directive in the same value.
ENV KONG_NGINX_HTTP_LUA_SHARED_DICT="aforo_buffer 10m; lua_shared_dict aforo_cache 5m"

# Required for an https aforo_endpoint -- i.e. every production deployment.
#
# Kong defaults lua_ssl_verify_depth to 1, which is too shallow for an ordinary
# certificate chain (leaf -> intermediate -> root needs at least 2). OpenSSL
# reports the shortfall as "20: unable to get local issuer certificate", which
# reads like a missing CA bundle and is not one: the image already ships a
# complete trust store at /etc/ssl/certs/ca-certificates.crt, and Kong already
# points lua_ssl_trusted_certificate at it. Installing more certificates does
# nothing; only the depth does.
ENV KONG_LUA_SSL_VERIFY_DEPTH=3
