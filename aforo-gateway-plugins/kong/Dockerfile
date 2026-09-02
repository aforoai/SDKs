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
#     -e KONG_ADMIN_LISTEN=0.0.0.0:8001 \
#     -p 8000:8000 -p 8001:8001 kong-aforo:3.4
#
# For a fast edit-reload loop that does not rebuild, see USER_GUIDE.md
# ("Local development: mounting the plugin from source").

FROM kong:3.4

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
    && luarocks make kong-plugin-aforo-metering-2.0.0-1.rockspec \
    && rm -rf /tmp/aforo-plugin

USER kong

ENV KONG_PLUGINS=bundled,aforo-metering

# handler.lua buffers events in ngx.shared.aforo_buffer. Without this dict the
# plugin loads and proxies traffic but silently meters nothing -- every log-phase
# call bails out with "Shared dict 'aforo_buffer' not found".
ENV KONG_NGINX_HTTP_LUA_SHARED_DICT="aforo_buffer 10m"

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
